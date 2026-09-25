import { execFile } from 'node:child_process';
import { discoverSocksProxy } from './proxy.js';

/**
 * Рестарт VPN (спека 2026-09-25, 7; поправка контроллера R4). Рабочий клиент —
 * v2RayTun, и процессов у него два: оболочка `v2RayTun.exe` держит конфиг и
 * сама поднимает ядро `xraycore.exe` во временной папке. Убивать надо оба —
 * иначе оболочка переподнимет ядро со старым состоянием, — а запускать
 * только оболочку.
 *
 * После запуска оболочки порт открывается не мгновенно: ядро поднимается
 * несколько секунд. Поэтому после каждого launch мы ждём до VPN_WAIT_MS,
 * опрашивая discover раз в VPN_POLL_MS, и только если порт так и не появился
 * за всё это время — считаем попытку провалившейся и уходим в бэкофф перед
 * следующей. Без этого первая попытка почти всегда «проваливалась» бы, а
 * вторая убивала только что поднимающийся VPN.
 *
 * Без VPN Telegram недоступен физически: деградировать тут не во что, цикл
 * просто спит до следующей попытки.
 */

export const VPN_BACKOFF_MS = [5000, 15000, 45000] as const;

/** Сколько всего ждать появления порта после одного launch. */
export const VPN_WAIT_MS = 30_000;

/** Как часто опрашивать discover, пока ждём появления порта. */
export const VPN_POLL_MS = 2_000;

const KILL_NAMES = ['v2RayTun.exe', 'xraycore.exe'];

export interface VpnDeps {
  discover(): Promise<boolean>;
  kill(): Promise<void>;
  launch(exe: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 15000, windowsHide: true }, () => resolve());
  });
}

/** Процесса может не быть — taskkill вернёт ошибку, и это нормально. */
export async function killVpn(): Promise<void> {
  for (const name of KILL_NAMES) await run('taskkill', ['/F', '/IM', name]);
}

export async function launchVpn(exe: string): Promise<void> {
  await run('cmd', ['/c', 'start', '', exe]);
}

export async function isUp(deps: Pick<VpnDeps, 'discover'>): Promise<boolean> {
  return deps.discover();
}

export const defaultVpnDeps: VpnDeps = {
  async discover() {
    const { found } = await discoverSocksProxy();
    return found !== null;
  },
  kill: killVpn,
  launch: launchVpn,
  sleep,
};

/**
 * Ждёт появления порта после launch: опрашивает discover раз в VPN_POLL_MS,
 * пока не наберётся VPN_WAIT_MS суммарного ожидания. true — порт ответил,
 * false — не появился за отведённое время.
 */
async function waitForPort(deps: Pick<VpnDeps, 'discover' | 'sleep'>): Promise<boolean> {
  let waited = 0;
  for (;;) {
    if (await deps.discover()) return true;
    if (waited >= VPN_WAIT_MS) return false;
    await deps.sleep(VPN_POLL_MS);
    waited += VPN_POLL_MS;
  }
}

/** true — прокси снова отвечает. false — три попытки не помогли. */
export async function restart(exe: string, deps: VpnDeps = defaultVpnDeps): Promise<boolean> {
  for (let attempt = 0; attempt < VPN_BACKOFF_MS.length; attempt += 1) {
    await deps.kill();
    await deps.launch(exe);
    if (await waitForPort(deps)) return true;
    await deps.sleep(VPN_BACKOFF_MS[attempt]!);
  }
  return false;
}
