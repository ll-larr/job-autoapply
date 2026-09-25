import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDialog, type DialogMessage, type TgDialog } from '../telegram/interview-session.js';
import { generateAnswer, type Turn } from './interview.js';
import { readFacts } from './facts.js';
import { isUp, restart, defaultVpnDeps, sleep } from './vpn.js';
import type { GigarecruiterConfig } from './config.js';

/**
 * Цикл автоответа (спека 2026-09-25, 3 и 7; поправки контроллера R6–R15).
 *
 * Окно открыто (`windowUntil > now`, его открывает `interview --window`) —
 * сессия ждёт первое сообщение сколько угодно долго, до конца окна; после
 * первого ответа гаснет по `idleMinutes` тишины. Окна нет — это поллинг: нет
 * новых входящих — выход сразу, есть — отвечаем и живём до тишины.
 *
 * Уведомлений владельцу нет по его решению: единственный след — журнал, и в
 * нём только события (номера, длины, причины), текстов диалога там нет.
 */

export const STATE_PATH = 'data/interview-state.json';
export const LOG_PATH = 'data/interview.log';
export const LOCK_PATH = 'data/interview.lock';
export const RETRY_BACKOFF_MS = [30_000, 120_000, 300_000, 900_000] as const;
/** Как часто перечитывать историю (R9). */
export const POLL_MS = 5_000;
/** Входящее старше суток — прошлый разговор, не отвечается никогда (R14). */
export const STALE_MS = 24 * 60 * 60_000;

export interface RunnerState {
  lastMessageId: number;
  windowUntil: number;
  lastPollAt: number;
}

const EMPTY: RunnerState = { lastMessageId: 0, windowUntil: 0, lastPollAt: 0 };

export function backoffFor(round: number): number {
  const i = Math.min(round, RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[i]!;
}

export function readState(path: string = STATE_PATH): RunnerState {
  if (!existsSync(path)) return { ...EMPTY };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RunnerState>;
    return {
      lastMessageId: Number.isFinite(raw.lastMessageId) ? Number(raw.lastMessageId) : 0,
      windowUntil: Number.isFinite(raw.windowUntil) ? Number(raw.windowUntil) : 0,
      lastPollAt: Number.isFinite(raw.lastPollAt) ? Number(raw.lastPollAt) : 0,
    };
  } catch {
    // Битый файл не должен ронять цикл: начинаем с нуля.
    return { ...EMPTY };
  }
}

export function writeState(s: RunnerState, path: string = STATE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  renameSync(tmp, path);
}

export function openWindow(now: number, minutes: number, path: string = STATE_PATH): void {
  const s = readState(path);
  writeState({ ...s, windowUntil: now + minutes * 60_000 }, path);
}

export function log(line: string, path: string = LOG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8');
}

export type GenerateFn = (input: { transcript: Turn[]; question: string }) =>
  Promise<{ ok: true; text: string } | { ok: false; failure: string }>;

/**
 * 'sent' — ответ ушёл. 'retry' — модели не дали годного текста, в чат не ушло
 * ничего, вызывающая сторона ставит бэкофф. 'idle' — на это уже отвечали.
 * 'superseded' — пока шла пауза, в чате появилось новое: ответ не отправлен,
 * группу надо собрать заново.
 */
export type AnswerOutcome = 'sent' | 'retry' | 'idle' | 'superseded';

export interface AnswerDeps {
  dialog: TgDialog;
  question: DialogMessage;
  transcript: Turn[];
  generate: GenerateFn;
  /** Пауза перед ответом: мгновенный ответ выдаёт машину. */
  delay(): Promise<void>;
  statePath?: string;
  logPath?: string;
}

export interface GroupDeps extends Omit<AnswerDeps, 'question'> {
  /** Входящие без кнопок после нашего последнего сообщения, от старых к новым. */
  group: DialogMessage[];
  /**
   * Последний id, уже просмотренный при сборке группы (за ней могут стоять
   * пропущенные сообщения с кнопками). Новым считается только то, что позже.
   * Не задан — последний id группы.
   */
  seenUpTo?: number;
}

/** Один вопрос — один ответ. Частный случай группы из одного сообщения. */
export async function answerOnce(deps: AnswerDeps): Promise<AnswerOutcome> {
  const { question, ...rest } = deps;
  return answerGroup({ ...rest, group: [question] });
}

/**
 * Группа входящих — один ответ (R9). ГигаРекрутёр шлёт «Спасибо за ответ» и
 * вопрос то одним сообщением, то двумя; отвечать надо один раз, на склейку.
 */
export async function answerGroup(deps: GroupDeps): Promise<AnswerOutcome> {
  const statePath = deps.statePath ?? STATE_PATH;
  const logPath = deps.logPath ?? LOG_PATH;
  const first = deps.group[0];
  const last = deps.group.at(-1);
  if (first === undefined || last === undefined) return 'idle';
  if (last.id <= readState(statePath).lastMessageId) return 'idle';
  const ids = first.id === last.id ? `${last.id}` : `${first.id}–${last.id}`;

  const question = deps.group.map((m) => m.text).join('\n');
  const r = await deps.generate({ transcript: deps.transcript, question });
  if (!r.ok) {
    log(`брак на ${ids}: ${r.failure}`, logPath);
    return 'retry';
  }

  await deps.delay();
  // Пока модель думала и шла пауза, собеседник мог дописать вопрос, а владелец
  // — ответить сам. Наш ответ встал бы после их сообщений, и граница «всё до
  // нашего последнего сообщения обработано» проглотила бы их без ответа.
  if ((await deps.dialog.history(Math.max(last.id, deps.seenUpTo ?? 0))).length > 0) {
    log(`к ${ids} пришло продолжение, ответ пересобирается`, logPath);
    return 'superseded';
  }
  await deps.dialog.setTyping();
  // Метку двигаем до отправки: падение на полпути не даст ответить дважды.
  // Состояние перечитывается: за время паузы окно мог сдвинуть другой процесс.
  writeState({ ...readState(statePath), lastMessageId: last.id }, statePath);
  await deps.dialog.send(r.text);
  log(`ответ на ${ids}: ${r.text.length} символов`, logPath);
  return 'sent';
}

/** Жив ли процесс. EPERM — процесс есть, просто чужой. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Один экземпляр (R10): файл с pid. Живой владелец — отказ. Мёртвый, мусор в
 * файле или наш же pid (переиспользован после падения) — перехват.
 */
export function acquireLock(
  path: string,
  pid: number,
  isAlive: (pid: number) => boolean = pidAlive,
): { ok: true; stale: string | null } | { ok: false; holder: number } {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, String(pid), { encoding: 'utf8', flag: 'wx' });
    return { ok: true, stale: null };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  let raw = '';
  try { raw = readFileSync(path, 'utf8').trim(); } catch { /* сняли между попытками */ }
  const holder = Number(raw);
  if (/^\d+$/.test(raw) && holder !== pid && isAlive(holder)) return { ok: false, holder };
  writeFileSync(path, String(pid), 'utf8');
  return { ok: true, stale: raw };
}

/** Снимает только свою блокировку: чужую, перехваченную у нас, не трогаем. */
export function releaseLock(path: string, pid: number): void {
  try {
    if (readFileSync(path, 'utf8').trim() === String(pid)) rmSync(path);
  } catch { /* файла уже нет */ }
}

export interface RunOptions {
  config: GigarecruiterConfig;
  /** Резюме для промпта — то же, что у бота: специальность по умолчанию (R15). */
  resume: string;
  models: string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  openDialog?: typeof openDialog;
  vpn?: { isUp(): Promise<boolean>; restart(exe: string): Promise<boolean> };
  generate?: GenerateFn;
  factsPath?: string;
  statePath?: string;
  logPath?: string;
  lockPath?: string;
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Один запуск: блокировка, VPN, диалог, разговор, уборка. Не бросает никогда:
 * любая ошибка — строка в журнал, закрытый диалог, снятая блокировка.
 */
export async function runInterview(opts: RunOptions): Promise<void> {
  const statePath = opts.statePath ?? STATE_PATH;
  const lockPath = opts.lockPath ?? LOCK_PATH;
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now;
  const note = (line: string): void => {
    try { log(line, opts.logPath ?? LOG_PATH); } catch { /* журнал недоступен — писать некуда */ }
  };

  let lock: ReturnType<typeof acquireLock>;
  try {
    lock = acquireLock(lockPath, pid, opts.isAlive);
  } catch (e) {
    note(`блокировка не взялась: ${errText(e)}`);
    return;
  }
  if (!lock.ok) {
    note(`уже работает другой экземпляр (pid ${lock.holder}), выхожу`);
    return;
  }
  if (lock.stale !== null) note(`блокировка мёртвого процесса «${lock.stale}» перехвачена`);

  let dialog: TgDialog | null = null;
  try {
    const vpn = opts.vpn ?? { isUp: () => isUp(defaultVpnDeps), restart: (exe: string) => restart(exe) };
    if (!(await vpn.isUp())) {
      note('VPN не отвечает, пробую рестарт');
      if (!(await vpn.restart(opts.config.vpnExe))) {
        note('VPN не поднялся за три попытки, жду следующего запуска');
        return;
      }
      note('VPN поднят');
    }
    const opened = await (opts.openDialog ?? openDialog)(opts.config.username);
    if (!opened.ok) {
      note(`диалог не открылся: ${opened.reason}`);
      return;
    }
    dialog = opened.dialog;
    await converse(dialog, opts, now, note);
  } catch (e) {
    note(`сессия прервана ошибкой: ${errText(e)}`);
  } finally {
    if (dialog !== null) {
      try { await dialog.close(); } catch (e) { note(`диалог не закрылся: ${errText(e)}`); }
      try { writeState({ ...readState(statePath), lastPollAt: now() }, statePath); } catch { /* не критично */ }
    }
    releaseLock(lockPath, pid);
  }
}

function toTranscript(messages: DialogMessage[]): Turn[] {
  return messages.map((m): Turn => ({ who: m.out ? 'me' : 'bot', text: m.text }));
}

/** Последовательный цикл разговора (R9): без рекурсии, без подписки, без гонок с close(). */
async function converse(
  dialog: TgDialog,
  opts: RunOptions,
  now: () => number,
  note: (line: string) => void,
): Promise<void> {
  const cfg = opts.config;
  const statePath = opts.statePath ?? STATE_PATH;
  const logPath = opts.logPath ?? LOG_PATH;
  const pause = opts.sleep ?? sleep;
  const random = opts.random ?? Math.random;
  const idleMs = cfg.idleMinutes * 60_000;
  const generate: GenerateFn = opts.generate ?? ((input) => generateAnswer(
    // Факты перечитываются на каждый ответ: владелец дописывает их руками.
    { resume: opts.resume, facts: readFacts(opts.factsPath).text, ...input },
    { models: opts.models, maxLength: cfg.maxReplyLength },
  ));
  const [lo, hi] = cfg.replyDelaySec;
  const delay = (): Promise<void> => pause((lo + random() * Math.max(0, hi - lo)) * 1000);
  const bump = (id: number): void => {
    const s = readState(statePath);
    if (id > s.lastMessageId) writeState({ ...s, lastMessageId: id }, statePath);
  };

  const logged = new Set<number>();
  let windowMark = readState(statePath).windowUntil;
  let lastActivity = now();
  let seenId = 0;
  let answered = false;
  let sentCount = 0;
  let round = 0;
  let first = true;
  // Тишина — время с последнего входящего или отправленного. До первого
  // ответа сессию держит окно, после — тишина (R8). Окно, закрывшееся посреди
  // разговора, его не рвёт: дальше живём, как поллинг, до тишины.
  const endsAt = (windowUntil: number): number =>
    (answered ? lastActivity + idleMs : Math.max(windowUntil, lastActivity + idleMs));

  for (;;) {
    const t = now();
    const state = readState(statePath);
    if (state.windowUntil > windowMark) {
      // Окно открыли заново, пока мы работали (новый отклик): это новая сессия.
      windowMark = state.windowUntil;
      answered = false;
    }
    if (!first && t >= endsAt(state.windowUntil)) {
      note(`сессия закрыта: ответов ${sentCount}, тишина ${Math.round((t - lastActivity) / 60_000)} мин`);
      return;
    }

    const msgs = await dialog.history(state.lastMessageId);
    // Граница R13: всё до нашего последнего сообщения отвечено или пропущено
    // намеренно — двойной ответ невозможен, даже если файл состояния потерян.
    const floor = Math.max(state.lastMessageId, ...msgs.filter((m) => m.out).map((m) => m.id));
    const group: DialogMessage[] = [];
    let fresh = false;
    for (const m of msgs) {
      if (m.out || m.id <= floor) continue;
      const stale = t - m.date.getTime() > STALE_MS;
      if (!stale) {
        fresh = true;
        if (m.id > seenId) { seenId = m.id; lastActivity = t; }
      }
      if (stale || m.hasButtons) {
        // Кнопки не нажимаем и не отвечаем на них (R7); старое — прошлый разговор (R14).
        if (!logged.has(m.id)) note(stale ? `пропущено ${m.id}: старше суток` : `пропущено сообщение с кнопками ${m.id}`);
        logged.add(m.id);
        continue;
      }
      group.push(m);
    }
    bump(group.length === 0 ? Math.max(floor, msgs.at(-1)?.id ?? 0) : floor);

    if (first) {
      first = false;
      if (state.windowUntil <= t && !fresh) {
        note('поллинг: новых входящих нет');
        return;
      }
      note(state.windowUntil > t ? `сессия: окно до ${new Date(state.windowUntil).toISOString()}` : 'сессия: поллинг нашёл новое');
    }

    const head = group[0];
    if (head !== undefined) {
      const transcript = toTranscript((await dialog.history(0)).filter((m) => m.id < head.id));
      const seenUpTo = msgs.at(-1)?.id ?? head.id;
      const r = await answerGroup({ dialog, group, seenUpTo, transcript, generate, delay, statePath, logPath });
      if (r === 'superseded') continue;
      if (r === 'sent') {
        answered = true;
        sentCount += 1;
        round = 0;
        lastActivity = now();
      }
      if (r === 'retry') {
        // Бэкофф не дольше, чем осталось жить сессии: спать после её конца незачем.
        const wait = Math.min(backoffFor(round), Math.max(0, endsAt(readState(statePath).windowUntil) - now()));
        round += 1;
        await pause(wait);
        continue;
      }
    }
    await pause(POLL_MS);
  }
}
