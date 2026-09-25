import { describe, it, expect } from 'vitest';
import {
  restart, isStoppedOutput, VPN_BACKOFF_MS, VPN_POLL_MS, VPN_WAIT_MS, SERVICE_STOP_WAIT_MS, SERVICE_POLL_MS,
  type VpnDeps, type ScResult,
} from '../src/core/vpn.js';

/**
 * Рестарт Happ (решение владельца 2026-09-26, FU-2). VPN — служба HappService:
 * остановить через sc.exe, дождаться STOPPED, запустить, поднять GUI Happ, если
 * его нет, и ждать порт, как раньше (R4).
 *
 * Тесты не зовут ни sc.exe, ни tasklist, ни cmd: это остановило бы настоящий
 * VPN владельца. Каждый side effect подменяется через VpnDeps, а проверяем мы
 * порядок вызовов и их аргументы.
 */

const TARGET = { service: 'HappService', app: 'D:\\Happ\\Happ.exe' };

// Вывод `sc.exe query HappService` на машине владельца: подписи локализованы
// (и в OEM-кодировке читаются мусором), имя состояния — всегда латиницей.
const scOut = (code: number, state: string, flags = '(NOT_STOPPABLE, NOT_PAUSABLE, IGNORES_SHUTDOWN)'): string => [
  '',
  'Имя_службы: HappService ',
  '        Тип                : 10  WIN32_OWN_PROCESS  ',
  `        Состояние          : ${code}  ${state} `,
  `                                ${flags}`,
  '        Код_выхода_Win32   : 0  (0x0)',
  '',
].join('\r\n');
const RUNNING = scOut(4, 'RUNNING', '(STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)');
const STOP_PENDING = scOut(3, 'STOP_PENDING', '(STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)');
const STOPPED = scOut(1, 'STOPPED');

interface Script {
  /** stdout n-го запроса состояния (с единицы). По умолчанию сразу STOPPED. */
  query?: (n: number) => string;
  stopCode?: number;
  startCode?: number;
  appRunning?: boolean;
  /** Отвечает ли порт на n-м опросе (с единицы) в попытке attempt (с единицы). */
  discover?: (n: number, attempt: number) => boolean;
}

function fakeDeps(script: Script = {}): VpnDeps & { calls: string[] } {
  const calls: string[] = [];
  let queries = 0;
  let attempt = 0;
  let polls = 0;
  return {
    calls,
    async sc(args: string[]): Promise<ScResult> {
      calls.push(`sc ${args.join(' ')}`);
      if (args[0] === 'stop') { attempt += 1; polls = 0; return { code: script.stopCode ?? 0, stdout: '' }; }
      if (args[0] === 'start') return { code: script.startCode ?? 0, stdout: '' };
      queries += 1;
      return { code: 0, stdout: (script.query ?? (() => STOPPED))(queries) };
    },
    async isRunning(image: string) {
      calls.push(`isRunning ${image}`);
      return script.appRunning ?? false;
    },
    async launch(exe: string) {
      calls.push(`launch ${exe}`);
    },
    async discover() {
      calls.push('discover');
      polls += 1;
      return (script.discover ?? (() => true))(polls, attempt);
    },
    async sleep(ms: number) {
      calls.push(`sleep ${ms}`);
    },
  };
}

const sleeps = (calls: string[]): number[] =>
  calls.filter((c) => c.startsWith('sleep ')).map((c) => Number(c.slice('sleep '.length)));

describe('isStoppedOutput', () => {
  it('локализованный вывод sc.exe query: «1  STOPPED» — остановлена', () => {
    expect(isStoppedOutput(STOPPED)).toBe(true);
  });

  it('английский вывод тоже узнаётся', () => {
    expect(isStoppedOutput('SERVICE_NAME: HappService\r\n        STATE              : 1  STOPPED \r\n')).toBe(true);
  });

  it('RUNNING, STOP_PENDING и флаг STOPPABLE — не остановлена', () => {
    expect(isStoppedOutput(RUNNING)).toBe(false);
    expect(isStoppedOutput(STOP_PENDING)).toBe(false);
    expect(isStoppedOutput(scOut(2, 'START_PENDING'))).toBe(false);
  });

  it('служба не найдена (1060) или пустой вывод — не остановлена', () => {
    expect(isStoppedOutput('[SC] EnumQueryServicesStatus:OpenService: ошибка: 1060:\r\n')).toBe(false);
    expect(isStoppedOutput('')).toBe(false);
  });
});

describe('restart', () => {
  it('порядок: sc stop → опрос sc query до STOPPED → sc start → GUI нет — запуск GUI → ожидание порта', async () => {
    const d = fakeDeps({ query: (n) => (n === 1 ? STOP_PENDING : STOPPED), appRunning: false });

    expect(await restart(TARGET, d)).toBe(true);

    expect(d.calls).toEqual([
      'sc stop HappService',
      'sc query HappService',
      `sleep ${SERVICE_POLL_MS}`,
      'sc query HappService',
      'sc start HappService',
      'isRunning Happ.exe',
      'launch D:\\Happ\\Happ.exe',
      'discover',
    ]);
  });

  it('GUI Happ уже запущен — второй раз не запускается', async () => {
    const d = fakeDeps({ appRunning: true });

    expect(await restart(TARGET, d)).toBe(true);

    expect(d.calls).toContain('isRunning Happ.exe');
    expect(d.calls.some((c) => c.startsWith('launch'))).toBe(false);
    expect(d.calls.indexOf('isRunning Happ.exe')).toBeGreaterThan(d.calls.indexOf('sc start HappService'));
  });

  it('служба не сообщила STOPPED за 15 с — всё равно start, а не отказ', async () => {
    const d = fakeDeps({ query: () => STOP_PENDING });

    expect(await restart(TARGET, d)).toBe(true);

    expect(SERVICE_STOP_WAIT_MS).toBe(15_000);
    const beforeStart = d.calls.slice(0, d.calls.indexOf('sc start HappService'));
    expect(beforeStart.filter((c) => c === 'sc query HappService')).toHaveLength(SERVICE_STOP_WAIT_MS / SERVICE_POLL_MS + 1);
    expect(sleeps(beforeStart).reduce((a, b) => a + b, 0)).toBe(SERVICE_STOP_WAIT_MS);
    expect(d.calls).toContain('sc start HappService');
  });

  it('sc stop уже остановленной службы (код 1062) и sc start запущенной (1056) не фатальны', async () => {
    const d = fakeDeps({ stopCode: 1062, startCode: 1056 });

    expect(await restart(TARGET, d)).toBe(true);

    expect(d.calls.slice(0, 3)).toEqual(['sc stop HappService', 'sc query HappService', 'sc start HappService']);
  });

  it('три провала — false, три пары stop/start, бэкофф 5 и 15 с между попытками, после последней не спит', async () => {
    const d = fakeDeps({ discover: () => false });

    expect(await restart(TARGET, d)).toBe(false);

    expect(d.calls.filter((c) => c === 'sc stop HappService')).toHaveLength(3);
    expect(d.calls.filter((c) => c === 'sc start HappService')).toHaveLength(3);
    expect(sleeps(d.calls).filter((ms) => (VPN_BACKOFF_MS as readonly number[]).includes(ms)))
      .toEqual([VPN_BACKOFF_MS[0], VPN_BACKOFF_MS[1]]);
    expect(d.calls.at(-1)).toBe('discover');
  });

  it('порт ждётся до 30 с с опросом раз в 2 с, прежде чем попытка считается проваленной', async () => {
    const d = fakeDeps({ discover: () => false });

    await restart(TARGET, d);

    const firstAttempt = d.calls.slice(0, d.calls.indexOf(`sleep ${VPN_BACKOFF_MS[0]}`));
    expect(sleeps(firstAttempt).filter((ms) => ms === VPN_POLL_MS)).toHaveLength(VPN_WAIT_MS / VPN_POLL_MS);
    expect(firstAttempt.filter((c) => c === 'discover')).toHaveLength(VPN_WAIT_MS / VPN_POLL_MS + 1);
  });

  it('порт появился на 5-м опросе в пределах 30 с — второго рестарта нет', async () => {
    const d = fakeDeps({ discover: (n) => n >= 5 });

    expect(await restart(TARGET, d)).toBe(true);

    expect(d.calls.filter((c) => c === 'sc stop HappService')).toHaveLength(1);
    expect(sleeps(d.calls)).not.toContain(VPN_BACKOFF_MS[0]);
  });

  it('первая попытка провалилась, вторая подняла — между ними бэкофф VPN_BACKOFF_MS[0]', async () => {
    const d = fakeDeps({ discover: (_n, attempt) => attempt >= 2 });

    expect(await restart(TARGET, d)).toBe(true);

    expect(d.calls.filter((c) => c === 'sc stop HappService')).toHaveLength(2);
    expect(sleeps(d.calls)).toContain(VPN_BACKOFF_MS[0]);
    expect(sleeps(d.calls)).not.toContain(VPN_BACKOFF_MS[1]);
  });

  it('служба и GUI берутся из аргумента: другое имя — другие вызовы', async () => {
    const d = fakeDeps();

    await restart({ service: 'OtherVpn', app: 'C:\\Other\\Gui.exe' }, d);

    expect(d.calls).toEqual([
      'sc stop OtherVpn', 'sc query OtherVpn', 'sc start OtherVpn', 'isRunning Gui.exe', 'launch C:\\Other\\Gui.exe', 'discover',
    ]);
  });
});
