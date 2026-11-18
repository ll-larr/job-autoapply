import { describe, it, expect, afterEach } from 'vitest';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import {
  proxyAddressFromEnv,
  parseWindowsProxyServer,
  parseRegProxyServer,
  parseNetstatListeners,
  parseTasklistCsv,
  vpnListenerPorts,
  probeHttpProxy,
  probeSocks5,
  discoverProxy,
  discoverSocksProxy,
  createProxyResolver,
  createProxiedFetch,
  type ProxyAddress,
  type ProxyDiscovery,
} from '../src/core/proxy.js';

/**
 * Прокси нужен ровно одному адресату — OpenRouter, то есть письмам: площадки
 * ходят мимо него. Поэтому выключенный VPN не ломает систему целиком, но
 * обнуляет генерацию, а выглядит это как «вакансии нашлись, письма пустые».
 *
 * Раньше адрес прокси задавал лаунчер, один раз и с зашитым портом 10801.
 * 2026-09-18 VPN-клиент переехал на 10809, лаунчер никого не нашёл, и письма
 * встали. Теперь прокси ищется в момент запроса, по нескольким источникам.
 */

let servers: (Server | HttpServer)[] = [];
let sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets = [];
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
});

function portOf(s: Server | HttpServer): number {
  return (s.address() as { port: number }).port;
}

/**
 * Поддельный прокси. `reply` — что ответить на первую строку запроса; `null`
 * — молчать. Первые строки запросов складываются в `seen`.
 */
async function fakeProxy(reply: string | null): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = [];
  const s = createServer((sock) => {
    sockets.push(sock);
    sock.once('data', (buf) => {
      seen.push(buf.toString('latin1').split('\r\n')[0]!);
      if (reply !== null) sock.write(reply);
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { port: portOf(s), seen };
}

/** Настоящий туннелирующий HTTP-прокси: CONNECT host:port и дальше труба. */
async function tunnelingProxy(): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = [];
  const s = createServer((client) => {
    sockets.push(client);
    client.once('data', (buf) => {
      const line = buf.toString('latin1').split('\r\n')[0]!;
      seen.push(line);
      const m = /^CONNECT ([^:]+):(\d+) /.exec(line);
      if (!m) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
      const upstream = connect(Number(m[2]), m[1]!, () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        upstream.pipe(client);
        client.pipe(upstream);
      });
      sockets.push(upstream);
      upstream.on('error', () => client.destroy());
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { port: portOf(s), seen };
}

async function httpTarget(body: string): Promise<number> {
  const s = createHttpServer((_req, res) => res.end(body));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return portOf(s);
}

/** Порт, который точно никто не слушает: заняли и сразу отпустили. */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = portOf(s);
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe('proxyAddressFromEnv', () => {
  it('читает адрес со схемой', () => {
    expect(proxyAddressFromEnv({ HTTPS_PROXY: 'http://127.0.0.1:10801' }))
      .toEqual({ host: '127.0.0.1', port: 10801 });
  });

  it('читает адрес БЕЗ схемы — так его тоже пишут', () => {
    expect(proxyAddressFromEnv({ HTTP_PROXY: '127.0.0.1:10801' }))
      .toEqual({ host: '127.0.0.1', port: 10801 });
  });

  it('HTTPS_PROXY главнее HTTP_PROXY', () => {
    expect(proxyAddressFromEnv({ HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'http://b:2' })?.host).toBe('a');
  });

  it('строчные имена тоже читаются', () => {
    expect(proxyAddressFromEnv({ https_proxy: 'http://127.0.0.1:9' })?.port).toBe(9);
  });

  it('пусто и мусор дают null, а не выдуманный адрес', () => {
    expect(proxyAddressFromEnv({})).toBeNull();
    expect(proxyAddressFromEnv({ HTTP_PROXY: '   ' })).toBeNull();
    expect(proxyAddressFromEnv({ HTTP_PROXY: '://' })).toBeNull();
  });
});

describe('parseWindowsProxyServer — порт из настроек Windows', () => {
  it('простая форма host:port', () => {
    expect(parseWindowsProxyServer('127.0.0.1:10809')).toEqual([10809]);
  });

  it('форма по протоколам: берёт http и https, socks пропускает', () => {
    // SOCKS-порт на CONNECT по HTTP не ответит, пробовать его незачем.
    expect(parseWindowsProxyServer('http=127.0.0.1:10809;https=127.0.0.1:10810;socks=127.0.0.1:10808'))
      .toEqual([10809, 10810]);
  });

  it('localhost засчитывается', () => {
    expect(parseWindowsProxyServer('localhost:8080')).toEqual([8080]);
  });

  it('нелокальный прокси — не наш VPN-клиент, пропускается', () => {
    expect(parseWindowsProxyServer('proxy.corp:3128')).toEqual([]);
  });

  it('пусто — пусто', () => {
    expect(parseWindowsProxyServer('')).toEqual([]);
  });
});

describe('parseRegProxyServer — вывод reg query', () => {
  it('достаёт значение', () => {
    const out = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n'
      + '    ProxyServer    REG_SZ    127.0.0.1:10809\r\n\r\n';
    expect(parseRegProxyServer(out)).toBe('127.0.0.1:10809');
  });

  it('значения нет — null', () => {
    expect(parseRegProxyServer('ERROR: The system was unable to find the specified registry key or value.'))
      .toBeNull();
  });
});

describe('parseNetstatListeners — кто что слушает', () => {
  const OUT = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1676',
    '  TCP    127.0.0.1:10808        0.0.0.0:0              LISTENING       5555',
    '  TCP    127.0.0.1:10809        0.0.0.0:0              LISTENING       5555',
    '  TCP    127.0.0.1:10809        127.0.0.1:50123        ESTABLISHED     5555',
    '  TCP    192.168.1.5:139        0.0.0.0:0              LISTENING       4',
    '  TCP    [::]:445               [::]:0                 LISTENING       4',
    '  TCP    [::1]:7000             [::]:0                 LISTENING       777',
  ].join('\r\n');

  it('берёт только LISTENING на адресах, куда достучится 127.0.0.1', () => {
    expect(parseNetstatListeners(OUT)).toEqual([
      { port: 135, pid: 1676 },
      { port: 10808, pid: 5555 },
      { port: 10809, pid: 5555 },
      { port: 445, pid: 4 },
    ]);
  });
});

describe('parseTasklistCsv', () => {
  it('pid → имя процесса', () => {
    const out = '"System","4","Services","0","20 K"\r\n"xraycore.exe","5555","Console","1","50 000 K"\r\n';
    const m = parseTasklistCsv(out);
    expect(m.get(5555)).toBe('xraycore.exe');
    expect(m.get(4)).toBe('System');
  });
});

describe('vpnListenerPorts — порты VPN-клиента', () => {
  it('оставляет только порты процессов VPN-клиента, по возрастанию', () => {
    const listeners = [
      { port: 135, pid: 1676 }, { port: 10809, pid: 5555 }, { port: 10808, pid: 5555 },
      { port: 7890, pid: 42 },
    ];
    const names = new Map([[1676, 'svchost.exe'], [5555, 'xraycore.exe'], [42, 'mihomo.exe']]);
    expect(vpnListenerPorts(listeners, names)).toEqual([7890, 10808, 10809]);
  });

  it('узнаёт распространённые клиенты', () => {
    for (const name of ['xray.exe', 'v2ray.exe', 'sing-box.exe', 'clash.exe', 'mihomo.exe', 'hiddify.exe']) {
      expect(vpnListenerPorts([{ port: 1, pid: 1 }], new Map([[1, name]]))).toEqual([1]);
    }
  });
});

describe('probeHttpProxy — живой ли HTTP-прокси', () => {
  it('отвечает 200 на CONNECT — годен', async () => {
    const p = await fakeProxy('HTTP/1.1 200 Connection established\r\n\r\n');
    expect(await probeHttpProxy({ host: '127.0.0.1', port: p.port })).toBe(true);
    // Проверяет именно дорогу к OpenRouter, а не абстрактный порт.
    expect(p.seen[0]).toBe('CONNECT openrouter.ai:443 HTTP/1.1');
  });

  it('отказ прокси — не годен', async () => {
    const p = await fakeProxy('HTTP/1.1 403 Forbidden\r\n\r\n');
    expect(await probeHttpProxy({ host: '127.0.0.1', port: p.port })).toBe(false);
  });

  it('открытый порт, но не HTTP-прокси — не годен', async () => {
    // SOCKS-порт или чужая программа: порт открыт, но на CONNECT отвечает мусором.
    const p = await fakeProxy('\x05\xff');
    expect(await probeHttpProxy({ host: '127.0.0.1', port: p.port })).toBe(false);
  });

  it('закрытый порт — false, а не исключение', async () => {
    expect(await probeHttpProxy({ host: '127.0.0.1', port: await deadPort() })).toBe(false);
  });

  it('молчащий порт — false за таймаут, не виснет', async () => {
    const p = await fakeProxy(null);
    const t0 = Date.now();
    expect(await probeHttpProxy({ host: '127.0.0.1', port: p.port }, 300)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('discoverProxy — где сейчас прокси', () => {
  /** Проба по списку живых портов; записывает, что пробовали. */
  function probeAlive(alive: number[], tried: number[] = []) {
    return async (a: ProxyAddress) => { tried.push(a.port); return alive.includes(a.port); };
  }
  const none = async (): Promise<number[]> => [];

  it('порт сменился, настройки Windows знают новый — находит (случай 2026-09-18)', async () => {
    const d = await discoverProxy({
      env: {},
      windowsProxyPorts: async () => [10809],
      vpnProcessPorts: none,
      probe: probeAlive([10809]),
    });
    expect(d.found).toEqual({ host: '127.0.0.1', port: 10809, source: 'windows' });
  });

  it('в настройках Windows старый порт — находит по процессу VPN-клиента', async () => {
    const d = await discoverProxy({
      env: {},
      windowsProxyPorts: async () => [10801],
      vpnProcessPorts: async () => [10808, 10809],
      // 10808 — SOCKS, на CONNECT не отвечает; 10809 — HTTP.
      probe: probeAlive([10809]),
    });
    expect(d.found).toEqual({ host: '127.0.0.1', port: 10809, source: 'vpn-process' });
  });

  it('явный адрес из окружения проверяется первым', async () => {
    const tried: number[] = [];
    const d = await discoverProxy({
      env: { HTTPS_PROXY: 'http://127.0.0.1:7777' },
      windowsProxyPorts: async () => [10809],
      vpnProcessPorts: none,
      probe: probeAlive([7777, 10809], tried),
    });
    expect(d.found?.source).toBe('env');
    expect(tried).toEqual([7777]);
  });

  it('мёртвый адрес из окружения не мешает найти живой', async () => {
    const d = await discoverProxy({
      env: { HTTPS_PROXY: 'http://127.0.0.1:7777' },
      windowsProxyPorts: async () => [10809],
      vpnProcessPorts: none,
      probe: probeAlive([10809]),
    });
    expect(d.found?.port).toBe(10809);
  });

  it('больше ничего не знает — пробует запасной 10801', async () => {
    const d = await discoverProxy({
      env: {}, windowsProxyPorts: none, vpnProcessPorts: none, probe: probeAlive([10801]),
    });
    expect(d.found).toEqual({ host: '127.0.0.1', port: 10801, source: 'fallback' });
  });

  it('VPN выключен — null и список проверенного, без повторов', async () => {
    const tried: number[] = [];
    const d = await discoverProxy({
      env: { HTTP_PROXY: '127.0.0.1:10809' },
      windowsProxyPorts: async () => [10809],
      vpnProcessPorts: async () => [10809, 10808],
      probe: probeAlive([], tried),
    });
    expect(d.found).toBeNull();
    expect(tried).toEqual([10809, 10808, 10801]);
    expect(d.checked).toEqual(['127.0.0.1:10809', '127.0.0.1:10808', '127.0.0.1:10801']);
  });

  it('сломанный источник не роняет поиск', async () => {
    const d = await discoverProxy({
      env: {},
      windowsProxyPorts: async () => { throw new Error('reg недоступен'); },
      vpnProcessPorts: async () => [10809],
      probe: probeAlive([10809]),
    });
    expect(d.found?.port).toBe(10809);
  });
});

describe('createProxyResolver — не искать заново на каждое письмо', () => {
  const FOUND: ProxyDiscovery = {
    found: { host: '127.0.0.1', port: 10809, source: 'windows' }, checked: ['127.0.0.1:10809'],
  };

  it('в пределах срока отдаёт найденное, не ища заново', async () => {
    let calls = 0;
    const r = createProxyResolver(async () => { calls++; return FOUND; }, 10_000, () => 0);
    await r.get();
    await r.get();
    expect(calls).toBe(1);
  });

  it('одновременные запросы ждут один поиск', async () => {
    let calls = 0;
    const r = createProxyResolver(async () => { calls++; return FOUND; });
    await Promise.all([r.get(), r.get(), r.get()]);
    expect(calls).toBe(1);
  });

  it('по истечении срока ищет заново — VPN могли включить', async () => {
    let calls = 0;
    let now = 0;
    const r = createProxyResolver(async () => { calls++; return FOUND; }, 10_000, () => now);
    await r.get();
    now = 10_001;
    await r.get();
    expect(calls).toBe(2);
  });

  it('invalidate заставляет искать заново', async () => {
    let calls = 0;
    const r = createProxyResolver(async () => { calls++; return FOUND; }, 10_000, () => 0);
    await r.get();
    r.invalidate();
    await r.get();
    expect(calls).toBe(2);
  });
});

describe('createProxiedFetch — запрос идёт через найденный прокси', () => {
  function resolverFor(found: ProxyAddress | null, onDiscover?: () => void) {
    return createProxyResolver(async () => {
      onDiscover?.();
      return {
        found: found === null ? null : { ...found, source: 'windows' as const },
        checked: [],
      };
    });
  }

  it('прокси найден — запрос проходит через него', async () => {
    const target = await httpTarget('через туннель');
    const proxy = await tunnelingProxy();
    const f = createProxiedFetch(resolverFor({ host: '127.0.0.1', port: proxy.port }));

    const res = await f(`http://127.0.0.1:${target}/`);

    expect(await res.text()).toBe('через туннель');
    expect(proxy.seen).toEqual([`CONNECT 127.0.0.1:${target} HTTP/1.1`]);
  });

  it('прокси не найден — запрос идёт напрямую', async () => {
    const target = await httpTarget('напрямую');
    const f = createProxiedFetch(resolverFor(null));
    expect(await (await f(`http://127.0.0.1:${target}/`)).text()).toBe('напрямую');
  });

  it('прокси умер между запросами — ошибка, и следующий запрос ищет заново', async () => {
    const target = await httpTarget('ok');
    let discoveries = 0;
    const f = createProxiedFetch(resolverFor({ host: '127.0.0.1', port: await deadPort() }, () => { discoveries++; }));

    await expect(f(`http://127.0.0.1:${target}/`)).rejects.toThrow();
    await expect(f(`http://127.0.0.1:${target}/`)).rejects.toThrow();
    expect(discoveries).toBe(2);
  });
});

describe('probeSocks5', () => {
  async function fakeSocks(connectReply: number): Promise<{ port: number; close(): void }> {
    const server = createServer((s) => {
      let stage = 0;
      s.on('data', () => {
        if (stage === 0) { s.write(Buffer.from([5, 0])); stage = 1; return; }
        s.write(Buffer.from([5, connectReply, 0, 1, 0, 0, 0, 0, 0, 0]));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    return { port, close: () => server.close() };
  }

  it('SOCKS5 без пароля, CONNECT прошёл — годен', async () => {
    const s = await fakeSocks(0);
    expect(await probeSocks5({ host: '127.0.0.1', port: s.port })).toBe(true);
    s.close();
  });

  it('CONNECT отклонён — не годен', async () => {
    const s = await fakeSocks(5);
    expect(await probeSocks5({ host: '127.0.0.1', port: s.port })).toBe(false);
    s.close();
  });

  it('HTTP-прокси вместо SOCKS — не годен', async () => {
    const server = createServer((s) => s.on('data', () => s.end('HTTP/1.1 400 Bad Request\r\n\r\n')));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    expect(await probeSocks5({ host: '127.0.0.1', port })).toBe(false);
    server.close();
  });

  it('discoverSocksProxy пробует кандидатов SOCKS-проверкой', async () => {
    const d = await discoverSocksProxy({
      env: {}, windowsProxyPorts: async () => [10809], vpnProcessPorts: async () => [10808, 10809],
      probe: async (a) => a.port === 10808,
    });
    expect(d.found).toMatchObject({ port: 10808, source: 'vpn-process' });
  });
});
