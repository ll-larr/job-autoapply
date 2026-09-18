import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

/**
 * Прокси для писем: где он сейчас и как через него ходить.
 *
 * Прокси нужен ровно одному адресату — OpenRouter: провайдер блокирует прямые
 * запросы к нему и отдаёт 403 «Access denied by security policy». Площадкам,
 * наоборот, прокси ломает связь (careerist.ru — ConnectTimeout, hh.ru — 403),
 * поэтому через него идут только письма, а всё остальное — напрямую.
 *
 * Раньше адрес задавал лаунчер: один раз, при запуске, с портом 10801,
 * зашитым в код. Это ломалось двумя путями. 2026-09-18 VPN-клиент переехал на
 * 10809 — лаунчер никого не нашёл, переменные не задал, письма встали. А если
 * VPN был выключен в момент запуска, включить его потом было мало: Node читает
 * адрес из окружения один раз, и панель приходилось перезапускать.
 *
 * Теперь прокси ищется в момент, когда пишется письмо, по нескольким
 * источникам, и каждый кандидат проверяется настоящим рукопожатием. Сменил
 * клиент порт или VPN включили позже — следующее письмо найдёт его само.
 */

export interface ProxyAddress { host: string; port: number }

/** Откуда взялся адрес. Идёт в панель и консоль: человеку полезно знать. */
export type ProxySource = 'env' | 'windows' | 'vpn-process' | 'fallback';

export interface FoundProxy extends ProxyAddress { source: ProxySource }

export interface ProxyDiscovery {
  found: FoundProxy | null;
  /** Что проверили, по порядку, `host:port`. Для сообщения «не нашёл, смотрел тут». */
  checked: string[];
}

/** Порт, на котором VPN-клиент слушал до 2026-09-18. Последний из кандидатов. */
const FALLBACK_PORT = 10801;

/** Адрес прокси из окружения. `null`, когда не задан ни один из вариантов. */
export function proxyAddressFromEnv(env: NodeJS.ProcessEnv = process.env): ProxyAddress | null {
  const raw = (env['HTTPS_PROXY'] ?? env['https_proxy'] ?? env['HTTP_PROXY'] ?? env['http_proxy'] ?? '').trim();
  if (raw === '') return null;
  try {
    // Адрес может прийти и без схемы («127.0.0.1:10801») — URL такое не
    // разбирает, поэтому схему при необходимости дописываем.
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const port = u.port === '' ? (u.protocol === 'https:' ? 443 : 80) : Number(u.port);
    if (!Number.isInteger(port) || port <= 0) return null;
    return { host: u.hostname, port };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Источники кандидатов. Разбор вывода — чистые функции, запуск команд — ниже.
// ---------------------------------------------------------------------------

const LOCAL_HOST = /^(?:127\.0\.0\.1|localhost)$/i;

/**
 * Порты из значения `ProxyServer` в настройках Windows. Туда его пишет сам
 * VPN-клиент, когда включает системный прокси.
 *
 * Бывает две формы: `127.0.0.1:10809` и `http=…;https=…;socks=…`. SOCKS
 * пропускаем — на HTTP CONNECT он не ответит. Нелокальный адрес — это не наш
 * VPN-клиент, а, скажем, корпоративный прокси; его тоже пропускаем.
 */
export function parseWindowsProxyServer(value: string): number[] {
  const ports: number[] = [];
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    const scheme = eq === -1 ? '' : part.slice(0, eq).trim().toLowerCase();
    if (scheme !== '' && scheme !== 'http' && scheme !== 'https') continue;
    const m = /^([^:\s]+):(\d+)$/.exec(part.slice(eq + 1).trim());
    if (m && LOCAL_HOST.test(m[1]!)) ports.push(Number(m[2]));
  }
  return ports;
}

/** Значение `ProxyServer` из вывода `reg query … /v ProxyServer`. */
export function parseRegProxyServer(stdout: string): string | null {
  const m = /^\s*ProxyServer\s+REG_\w+\s+(.+?)\s*$/m.exec(stdout);
  return m ? m[1]! : null;
}

/**
 * Слушающие TCP-порты из `netstat -ano -p TCP`. Только те, что слушают на
 * адресе, куда достучится 127.0.0.1: сам 127.0.0.1 или «все адреса».
 */
export function parseNetstatListeners(stdout: string): { port: number; pid: number }[] {
  const out: { port: number; pid: number }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line);
    if (m) out.push({ port: Number(m[2]), pid: Number(m[3]) });
  }
  return out;
}

/** pid → имя процесса из `tasklist /fo csv /nh`. */
export function parseTasklistCsv(stdout: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line);
    if (m) names.set(Number(m[2]), m[1]!);
  }
  return names;
}

/** Процессы VPN-клиентов, чьи порты имеет смысл пробовать. */
const VPN_PROCESS = /^(?:xray|v2ray|sing-box|clash|mihomo|hiddify|nekobox|nekoray)/i;

/**
 * Порты, на которых слушает VPN-клиент. Нужны на случай, когда клиент сменил
 * порт, но в настройки Windows его не записал (режим «не трогать системный
 * прокси»): тогда реестр хранит старый порт, а процесс знает правду.
 */
export function vpnListenerPorts(
  listeners: { port: number; pid: number }[],
  names: Map<number, string>,
): number[] {
  const ports = listeners
    .filter((l) => VPN_PROCESS.test(names.get(l.pid) ?? ''))
    .map((l) => l.port);
  return [...new Set(ports)].sort((a, b) => a - b);
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, windowsHide: true, encoding: 'latin1' }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

async function windowsProxyPortsFromRegistry(): Promise<number[]> {
  if (process.platform !== 'win32') return [];
  const out = await run('reg', [
    'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer',
  ]);
  const value = parseRegProxyServer(out);
  return value === null ? [] : parseWindowsProxyServer(value);
}

async function vpnProcessPortsFromSystem(): Promise<number[]> {
  if (process.platform !== 'win32') return [];
  const [netstat, tasklist] = await Promise.all([
    run('netstat', ['-ano', '-p', 'TCP']),
    run('tasklist', ['/fo', 'csv', '/nh']),
  ]);
  return vpnListenerPorts(parseNetstatListeners(netstat), parseTasklistCsv(tasklist));
}

// ---------------------------------------------------------------------------
// Проверка и поиск.
// ---------------------------------------------------------------------------

/**
 * Годится ли адрес как HTTP-прокси до OpenRouter.
 *
 * Открытого порта мало: у VPN-клиента рядом с HTTP-портом обычно слушает
 * SOCKS, а порт могла занять и чужая программа. Поэтому проверка — настоящий
 * `CONNECT openrouter.ai:443`, ровно то, что сделает запрос письма. Ответ 200
 * значит, что прокси живой и сам достучался до OpenRouter.
 */
export function probeHttpProxy(address: ProxyAddress, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: address.host, port: address.port });
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.write('CONNECT openrouter.ai:443 HTTP/1.1\r\nHost: openrouter.ai:443\r\n\r\n');
    });
    socket.once('data', (buf) => done(/^HTTP\/1\.[01] 200\b/.test(buf.toString('latin1'))));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.once('close', () => done(false));
  });
}

export interface DiscoveryDeps {
  env?: NodeJS.ProcessEnv;
  windowsProxyPorts?: () => Promise<number[]>;
  vpnProcessPorts?: () => Promise<number[]>;
  probe?: (address: ProxyAddress) => Promise<boolean>;
}

/**
 * Ищет живой прокси. Кандидаты по порядку: явный адрес из окружения, порт из
 * настроек Windows, порты процесса VPN-клиента, запасной 10801. Первый, кто
 * прошёл проверку, и есть ответ.
 */
export async function discoverProxy(deps: DiscoveryDeps = {}): Promise<ProxyDiscovery> {
  const env = deps.env ?? process.env;
  const probe = deps.probe ?? ((a: ProxyAddress) => probeHttpProxy(a));
  // Сломанный источник — не повод бросать поиск: остальные могут знать ответ.
  const safe = (f: () => Promise<number[]>) => f().catch((): number[] => []);

  const [windowsPorts, vpnPorts] = await Promise.all([
    safe(deps.windowsProxyPorts ?? windowsProxyPortsFromRegistry),
    safe(deps.vpnProcessPorts ?? vpnProcessPortsFromSystem),
  ]);

  const candidates: FoundProxy[] = [];
  const fromEnv = proxyAddressFromEnv(env);
  if (fromEnv) candidates.push({ ...fromEnv, source: 'env' });
  for (const port of windowsPorts) candidates.push({ host: '127.0.0.1', port, source: 'windows' });
  for (const port of vpnPorts) candidates.push({ host: '127.0.0.1', port, source: 'vpn-process' });
  candidates.push({ host: '127.0.0.1', port: FALLBACK_PORT, source: 'fallback' });

  const checked: string[] = [];
  for (const c of candidates) {
    const key = `${c.host}:${c.port}`;
    if (checked.includes(key)) continue;
    checked.push(key);
    if (await probe(c)) return { found: c, checked };
  }
  return { found: null, checked };
}

export interface ProxyResolver {
  get(): Promise<ProxyDiscovery>;
  /** Забыть найденное: следующий `get` ищет заново. Зовётся, когда прокси подвёл. */
  invalidate(): void;
}

/**
 * Помнит результат поиска `ttlMs`, чтобы не запускать netstat на каждое
 * письмо. Срок короткий: VPN включают и выключают по ходу работы, и это
 * должно замечаться без перезапуска.
 */
export function createProxyResolver(
  discover: () => Promise<ProxyDiscovery> = () => discoverProxy(),
  ttlMs = 10_000,
  now: () => number = Date.now,
): ProxyResolver {
  let cached: { at: number; value: Promise<ProxyDiscovery> } | null = null;
  return {
    get() {
      if (cached === null || now() - cached.at > ttlMs) {
        const value = discover();
        cached = { at: now(), value };
        // Упавший поиск не должен залипнуть в кеше на весь срок.
        value.catch(() => { if (cached?.value === value) cached = null; });
      }
      return cached.value;
    },
    invalidate() { cached = null; },
  };
}

/** Общий на процесс: панель и письма должны видеть один и тот же ответ. */
export const proxyResolver = createProxyResolver();

const agents = new Map<string, ProxyAgent>();

function agentFor(address: ProxyAddress): ProxyAgent {
  const url = `http://${address.host}:${address.port}`;
  let agent = agents.get(url);
  if (!agent) {
    // Туннель всегда, и для http тоже: probeHttpProxy проверяет именно
    // CONNECT, так что годность доказана только для него.
    agent = new ProxyAgent({ uri: url, proxyTunnel: true });
    agents.set(url, agent);
  }
  return agent;
}

/**
 * fetch, который ходит через найденный прокси. Не нашёлся — идёт напрямую:
 * блок-страницу провайдера потом опознает describeHttpFailure и назовёт
 * причину. Прокси подвёл посреди работы — результат поиска забывается, и
 * следующая попытка ищет заново.
 *
 * Запрос уходит через fetch из пакета undici, а не через встроенный: агент и
 * fetch должны быть из одной версии undici, встроенная в Node может отличаться.
 */
export function createProxiedFetch(resolver: ProxyResolver = proxyResolver): typeof fetch {
  const proxied = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const { found } = await resolver.get();
    if (found === null) return fetch(input, init);
    try {
      return await undiciFetch(
        input as Parameters<typeof undiciFetch>[0],
        { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher: agentFor(found) },
      ) as unknown as Response;
    } catch (e) {
      resolver.invalidate();
      throw e;
    }
  };
  return proxied as typeof fetch;
}
