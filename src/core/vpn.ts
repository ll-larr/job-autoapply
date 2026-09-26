import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { discoverSocksProxy, parseTasklistCsv } from './proxy.js';

/**
 * Рестарт VPN (спека 2026-09-25, 7; поправка контроллера R4; решение владельца
 * 2026-09-26, FU-2). Рабочий клиент — Happ. Соединение держит служба Windows
 * `HappService` (`D:\Happ\happd.exe`, LocalSystem), ядро `xray.exe` — её
 * дочерний процесс. Права службы дают обычному пользователю и остановку, и
 * запуск, поэтому перезапуск идёт через `sc.exe` без прав администратора.
 *
 * Одна попытка: `sc.exe stop` → ждать, пока `sc.exe query` скажет STOPPED (до
 * SERVICE_STOP_WAIT_MS; не дождались — всё равно запускаем) → `sc.exe start` →
 * если GUI `Happ.exe` не запущен, запустить его: возможно, это он велит службе
 * подключиться → ждать порт до VPN_WAIT_MS, опрашивая раз в VPN_POLL_MS. Коды
 * выхода sc.exe решающими не считаются: остановка уже остановленной службы
 * даёт 1062, запуск запущенной — 1056; успех решает только появившийся порт.
 *
 * Прежний клиент v2RayTun может стоять и даже висеть в трее — его здесь не
 * трогает ничто: ни убийства процессов по имени, ни запуска.
 *
 * Без VPN Telegram недоступен физически: деградировать тут не во что, цикл
 * просто спит до следующей попытки.
 */

export const VPN_BACKOFF_MS = [5000, 15000, 45000] as const;

/** Сколько всего ждать появления порта после запуска службы. */
export const VPN_WAIT_MS = 30_000;

/** Как часто опрашивать discover, пока ждём появления порта. */
export const VPN_POLL_MS = 2_000;

/** Сколько ждать, пока служба после `sc stop` сообщит STOPPED. */
export const SERVICE_STOP_WAIT_MS = 15_000;

/** Как часто спрашивать `sc query`, пока ждём остановку. */
export const SERVICE_POLL_MS = 1_000;

/** Что перезапускать: имя службы и GUI клиента (config.gigarecruiter.vpnService/vpnApp). */
export interface VpnTarget {
  service: string;
  app: string;
}

/** Результат sc.exe: код выхода (null — не запустился или убит по таймауту) и stdout. */
export interface ScResult {
  code: number | null;
  stdout: string;
}

export interface VpnDeps {
  discover(): Promise<boolean>;
  /** sc.exe с аргументами. Не бросает: любой исход — ScResult. */
  sc(args: string[]): Promise<ScResult>;
  /** Запущен ли процесс с таким именем образа (`Happ.exe`). */
  isRunning(image: string): Promise<boolean>;
  /** Отвязанный запуск GUI: `cmd /c start "" <exe>`. */
  launch(exe: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Служба остановлена? В выводе `sc.exe query` подписи локализованы (у владельца
 * — по-русски в OEM-кодировке, читаются мусором), а состояние всегда пишется
 * кодом и латинским именем: «: 1  STOPPED». По ним и узнаём. STOP_PENDING,
 * RUNNING и флаг STOPPABLE сюда не подходят; служба не найдена (1060) — тоже.
 */
export function isStoppedOutput(stdout: string): boolean {
  return /:\s*1\s+STOPPED\b/.test(stdout);
}

function scExec(args: string[]): Promise<ScResult> {
  return new Promise((resolve) => {
    execFile('sc.exe', args, { timeout: 15000, windowsHide: true, encoding: 'latin1' }, (err, stdout) => {
      const code = err === null ? 0 : typeof err.code === 'number' ? err.code : null;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });
}

/**
 * tasklist с фильтром по имени образа. Не смогли спросить — считаем, что GUI
 * нет: лишний запуск однокопийного GUI безвреден, а без него служба может так
 * и не подключиться.
 */
function isRunningExec(image: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'tasklist', ['/fi', `IMAGENAME eq ${image}`, '/fo', 'csv', '/nh'],
      { timeout: 15000, windowsHide: true, encoding: 'latin1' },
      (err, stdout) => {
        if (err !== null) { resolve(false); return; }
        const want = image.toLowerCase();
        resolve([...parseTasklistCsv(String(stdout)).values()].some((n) => n.toLowerCase() === want));
      },
    );
  });
}

export function launchApp(exe: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('cmd', ['/c', 'start', '', exe], { timeout: 15000, windowsHide: true }, () => resolve());
  });
}

export async function isUp(deps: Pick<VpnDeps, 'discover'>): Promise<boolean> {
  return deps.discover();
}

export const defaultVpnDeps: VpnDeps = {
  async discover() {
    const { found } = await discoverSocksProxy();
    return found !== null;
  },
  sc: scExec,
  isRunning: isRunningExec,
  launch: launchApp,
  sleep,
};

/**
 * Ждёт, пока служба сообщит STOPPED: `sc query` сразу и затем раз в
 * SERVICE_POLL_MS, пока не наберётся SERVICE_STOP_WAIT_MS. false — не дождались.
 */
async function waitForStopped(service: string, deps: Pick<VpnDeps, 'sc' | 'sleep'>): Promise<boolean> {
  let waited = 0;
  for (;;) {
    if (isStoppedOutput((await deps.sc(['query', service])).stdout)) return true;
    if (waited >= SERVICE_STOP_WAIT_MS) return false;
    await deps.sleep(SERVICE_POLL_MS);
    waited += SERVICE_POLL_MS;
  }
}

/**
 * Ждёт появления порта после запуска: опрашивает discover раз в VPN_POLL_MS,
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

const codeText = (code: number | null): string =>
  (code === null ? 'кода нет (sc.exe не запустился или завис)' : `код ${code}`);

/**
 * true — прокси снова отвечает. false — три попытки не помогли.
 *
 * `note` — журнал вызывающего (FU-8): коды выхода `sc.exe stop` и `start` и
 * запускался ли GUI. Решений по ним restart не принимает, но без них по журналу
 * не понять, почему VPN не поднялся: отказ в доступе (5), служба не найдена
 * (1060) или просто не подключилась.
 */
export async function restart(
  target: VpnTarget,
  deps: VpnDeps = defaultVpnDeps,
  note: (line: string) => void = () => {},
): Promise<boolean> {
  const image = win32.basename(target.app);
  const total = VPN_BACKOFF_MS.length;
  for (let attempt = 0; attempt < total; attempt += 1) {
    const say = (line: string): void => note(`VPN, попытка ${attempt + 1}/${total}: ${line}`);
    // Коды выхода не проверяются намеренно (см. шапку): решает только порт.
    say(`sc.exe stop ${target.service} — ${codeText((await deps.sc(['stop', target.service])).code)}`);
    // Не остановилась за отведённое время — всё равно пробуем запустить:
    // start на зависшей службе провалится, и попытку засчитает ожидание порта.
    if (!(await waitForStopped(target.service, deps))) {
      say(`служба ${target.service} не сообщила STOPPED за ${SERVICE_STOP_WAIT_MS / 1000} с, запускаю всё равно`);
    }
    say(`sc.exe start ${target.service} — ${codeText((await deps.sc(['start', target.service])).code)}`);
    if (await deps.isRunning(image)) {
      say(`GUI ${image} уже запущен`);
    } else {
      say(`GUI ${image} не запущен — запускаю ${target.app}`);
      await deps.launch(target.app);
    }
    if (await waitForPort(deps)) return true;
    // Бэкофф нужен только перед следующей попыткой — после последней неудачи
    // спать не для чего, вызывающий код и так узнаёт про false немедленно.
    if (attempt < VPN_BACKOFF_MS.length - 1) await deps.sleep(VPN_BACKOFF_MS[attempt]!);
  }
  return false;
}
