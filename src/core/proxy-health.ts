import { connect } from 'node:net';

/**
 * Жив ли прокси, через который уходят запросы к OpenRouter.
 *
 * Зачем вообще: письма — единственное, чему прокси нужен (провайдер блокирует
 * прямые запросы к OpenRouter и отдаёт 403 «Access denied by security
 * policy»). Площадки, наоборот, ходят мимо него. Поэтому выключенный VPN не
 * ломает систему целиком, но обнуляет генерацию писем — а выглядит это как
 * «вакансии нашлись, письма пустые», без единого слова о причине. Ровно так и
 * вышло 2026-09-01 на прогоне в 22 вакансии.
 *
 * Проверяется именно TCP-соединение с портом, а не настройка в реестре:
 * галочка «использовать прокси» может стоять, пока клиент выключен, и тогда
 * реестр соврёт. Соединение — это то, что случится с настоящим запросом.
 */

/** Адрес прокси из окружения. `null`, когда не задан ни один из вариантов. */
export function proxyAddressFromEnv(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } | null {
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

/**
 * Принимает ли кто-нибудь соединение по этому адресу.
 *
 * Таймаут короткий: проверка идёт по расписанию из панели, и повиснуть на ней
 * нельзя. Локальный порт отвечает за миллисекунды — если не ответил за
 * секунду, клиент выключен.
 */
export function isReachable(
  address: { host: string; port: number },
  timeoutMs = 1000,
): Promise<boolean> {
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
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export interface ProxyHealth {
  /** Заданы ли переменные окружения с адресом прокси. */
  configured: boolean;
  /** Разрешено ли Node их читать (--use-env-proxy / NODE_USE_ENV_PROXY=1). */
  allowed: boolean;
  /** Отвечает ли прокси прямо сейчас. `null`, когда адреса нет и проверять нечего. */
  reachable: boolean | null;
}

export async function checkProxyHealth(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
  timeoutMs = 1000,
): Promise<ProxyHealth> {
  const address = proxyAddressFromEnv(env);
  const allowed = execArgv.includes('--use-env-proxy') || env['NODE_USE_ENV_PROXY'] === '1';
  return {
    configured: address !== null,
    allowed,
    reachable: address === null ? null : await isReachable(address, timeoutMs),
  };
}

/**
 * Годен ли прокси для генерации писем. Нужны все три условия сразу: адрес
 * задан, Node разрешено его читать, и на том конце кто-то есть.
 */
export function isProxyUsable(h: ProxyHealth): boolean {
  return h.configured && h.allowed && h.reachable === true;
}
