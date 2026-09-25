import { describe, it, expect, vi } from 'vitest';
import { restart, VPN_BACKOFF_MS, VPN_POLL_MS } from '../src/core/vpn.js';
import type { VpnDeps } from '../src/core/vpn.js';

/**
 * Рестарт v2RayTun (поправка контроллера 2026-09-25, R4). После launch порт
 * открывается не мгновенно — оболочка ещё поднимает ядро xraycore.exe, — так
 * что restart ждёт его появления до VPN_WAIT_MS, опрашивая discover раз в
 * VPN_POLL_MS, и только после этого решает, что попытка провалилась.
 *
 * Тесты не должны звать killVpn, launchVpn или defaultVpnDeps: это убило бы
 * настоящий VPN. Каждый side effect подменяется через VpnDeps, и проверяем мы
 * не сырые вызовы discover (их число — деталь реализации опроса), а сколько
 * раз были kill/launch/sleep и в каком порядке.
 */

function fakeDeps(overrides: Partial<VpnDeps> = {}): VpnDeps {
  return {
    kill: vi.fn(async () => {}),
    launch: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    discover: vi.fn(async () => true),
    ...overrides,
  };
}

describe('restart', () => {
  it('порт ответил сразу — ровно одна пара kill и launch', async () => {
    const d = fakeDeps({ discover: vi.fn(async () => true) });

    expect(await restart('C:/v2RayTun.exe', d)).toBe(true);

    expect(d.kill).toHaveBeenCalledTimes(1);
    expect(d.launch).toHaveBeenCalledTimes(1);
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it('порт появился на N-м опросе в пределах 30 секунд — второго launch нет', async () => {
    let calls = 0;
    const d = fakeDeps({
      discover: vi.fn(async () => {
        calls += 1;
        return calls >= 5; // поднялся на 5-м опросе, задолго до дедлайна в 30с
      }),
    });

    expect(await restart('C:/v2RayTun.exe', d)).toBe(true);

    expect(d.kill).toHaveBeenCalledTimes(1);
    expect(d.launch).toHaveBeenCalledTimes(1);
    // ждали опросом (VPN_POLL_MS), а не бэкоффом между попытками
    expect(d.sleep).toHaveBeenCalledWith(VPN_POLL_MS);
    expect(d.sleep).not.toHaveBeenCalledWith(VPN_BACKOFF_MS[0]);
  });

  it('порт не появился ни разу за 30 секунд ни на одной попытке — false и ровно три launch', async () => {
    const d = fakeDeps({ discover: vi.fn(async () => false) });

    expect(await restart('C:/v2RayTun.exe', d)).toBe(false);

    expect(d.kill).toHaveBeenCalledTimes(3);
    expect(d.launch).toHaveBeenCalledTimes(3);
  });

  it('kill вызывается строго раньше launch, иначе оболочка переподнимет старое ядро', async () => {
    const order: string[] = [];
    const d = fakeDeps({
      kill: vi.fn(async () => { order.push('kill'); }),
      launch: vi.fn(async () => { order.push('launch'); }),
      discover: vi.fn(async () => true),
    });

    await restart('C:/v2RayTun.exe', d);

    expect(order).toEqual(['kill', 'launch']);
  });

  it('между первой и второй попыткой выдержан бэкофф VPN_BACKOFF_MS[0]', async () => {
    let attempt = 0;
    const d = fakeDeps({
      kill: vi.fn(async () => { attempt += 1; }),
      // первая попытка (attempt=1) ни разу не поднимается за отведённые 30с,
      // вторая (attempt=2) отвечает сразу
      discover: vi.fn(async () => attempt >= 2),
    });

    expect(await restart('C:/v2RayTun.exe', d)).toBe(true);

    expect(d.launch).toHaveBeenCalledTimes(2);
    expect(d.sleep).toHaveBeenCalledWith(VPN_BACKOFF_MS[0]);
  });
});
