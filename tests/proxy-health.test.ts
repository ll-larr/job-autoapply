import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import {
  proxyAddressFromEnv,
  isReachable,
  checkProxyHealth,
  isProxyUsable,
} from '../src/core/proxy-health.js';

/**
 * Прокси нужен ровно одному адресату — OpenRouter, то есть письмам: площадки
 * ходят мимо него. Поэтому выключенный VPN не ломает систему целиком, но
 * обнуляет генерацию, а выглядит это как «вакансии нашлись, письма пустые».
 * Ровно так и вышло 2026-09-01 на прогоне в 22 вакансии, и панель обязана
 * называть причину сама.
 */

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
});

function listen(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve((s.address() as { port: number }).port));
  });
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

describe('isReachable', () => {
  it('видит живой порт', async () => {
    const port = await listen();
    expect(await isReachable({ host: '127.0.0.1', port })).toBe(true);
  });

  it('на закрытом порту отвечает false, а не бросает', async () => {
    // Порт, который точно никто не слушает: заняли и сразу отпустили.
    const port = await listen();
    await new Promise<void>((r) => servers.pop()!.close(() => r()));
    expect(await isReachable({ host: '127.0.0.1', port }, 500)).toBe(false);
  });

  it('не виснет дольше таймаута на неотвечающем адресе', async () => {
    // 10.255.255.1 — адрес, который молчит: соединение не откажут, оно повиснет.
    const t0 = Date.now();
    expect(await isReachable({ host: '10.255.255.1', port: 65530 }, 300)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000);
  }, 10000);
});

describe('checkProxyHealth', () => {
  it('всё на месте — прокси годен', async () => {
    const port = await listen();
    const h = await checkProxyHealth(
      { HTTPS_PROXY: `http://127.0.0.1:${port}`, NODE_USE_ENV_PROXY: '1' }, [],
    );
    expect(h).toEqual({ configured: true, allowed: true, reachable: true });
    expect(isProxyUsable(h)).toBe(true);
  });

  it('адрес есть, VPN выключен — configured, но НЕ reachable', async () => {
    // Это и есть случай «включи VPN»: настройки в порядке, клиента нет.
    const port = await listen();
    await new Promise<void>((r) => servers.pop()!.close(() => r()));
    const h = await checkProxyHealth(
      { HTTPS_PROXY: `http://127.0.0.1:${port}`, NODE_USE_ENV_PROXY: '1' }, [], 500,
    );
    expect(h.configured).toBe(true);
    expect(h.allowed).toBe(true);
    expect(h.reachable).toBe(false);
    expect(isProxyUsable(h)).toBe(false);
  });

  it('адреса нет — проверять нечего, reachable null', async () => {
    const h = await checkProxyHealth({ NODE_USE_ENV_PROXY: '1' }, []);
    expect(h).toEqual({ configured: false, allowed: true, reachable: null });
    expect(isProxyUsable(h)).toBe(false);
  });

  it('живой прокси без разрешения читать его — всё равно не годен', async () => {
    // Флаг запуска: Node читает переменные только с --use-env-proxy, и
    // выставить его позже нельзя — undici читает конфигурацию один раз.
    const port = await listen();
    const h = await checkProxyHealth({ HTTPS_PROXY: `http://127.0.0.1:${port}` }, []);
    expect(h.reachable).toBe(true);
    expect(h.allowed).toBe(false);
    expect(isProxyUsable(h)).toBe(false);
  });

  it('флаг запуска засчитывается наравне с переменной', async () => {
    const port = await listen();
    const h = await checkProxyHealth(
      { HTTPS_PROXY: `http://127.0.0.1:${port}` }, ['--use-env-proxy'],
    );
    expect(h.allowed).toBe(true);
    expect(isProxyUsable(h)).toBe(true);
  });
});
