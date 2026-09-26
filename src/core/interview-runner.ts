import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDialog, type DialogMessage, type TgDialog } from '../telegram/interview-session.js';
import { generateAnswer, type Turn } from './interview.js';
import { readFacts } from './facts.js';
import { isUp, restart, defaultVpnDeps, sleep, type VpnTarget } from './vpn.js';
import type { GigarecruiterConfig } from './config.js';
import { acquireLock, releaseLock, refreshLock, LOCK_PATH } from './interview-lock.js';

/**
 * Цикл автоответа (спека 2026-09-25, 3 и 7; поправки контроллера R6–R15).
 *
 * Окно открыто (`windowUntil > now`, его открывает `interview --window`) —
 * сессия ждёт первое сообщение сколько угодно долго, до конца окна; после
 * первого ответа гаснет по `idleMinutes` тишины. Окна нет — это поллинг: нет
 * новых входящих — выход сразу, есть — отвечаем и живём до тишины. В любом
 * режиме сессию заканчивают потолок `maxRepliesPerSession` и сообщение с
 * кнопками после нашего ответа — так ГигаРекрутёр закрывает интервью (C1);
 * «после ответа» — этой сессии или по истории чата моложе суток (H2).
 *
 * Уведомлений владельцу нет по его решению: единственный след — журнал, и в
 * нём только события (номера, длины, причины), текстов диалога там нет.
 */

export const STATE_PATH = 'data/interview-state.json';
export const LOG_PATH = 'data/interview.log';
export const RETRY_BACKOFF_MS = [30_000, 120_000, 300_000, 900_000] as const;
/** Как часто перечитывать историю (R9). */
export const POLL_MS = 5_000;
/** Сколько сбоев history() подряд цикл терпит (D2); следующий заканчивает сессию. */
export const HISTORY_FAILURES_TOLERATED = 3;
/** Входящее старше суток — прошлый разговор, не отвечается никогда (R14). */
export const STALE_MS = 24 * 60 * 60_000;

export interface RunnerState {
  lastMessageId: number;
  windowUntil: number;
  lastPollAt: number;
  /**
   * Когда сработал потолок ответов за сессию (FR-6); 0 — не срабатывал. Пока
   * он стоит, ни поллинг, ни запуск в старом окне не отвечают: встречная
   * реплика ГигаРекрутёра на наш последний ответ иначе завела бы разговор
   * заново на следующем поллинге. Снимает только новое окно (openWindow).
   */
  capTrippedAt: number;
}

const EMPTY: RunnerState = { lastMessageId: 0, windowUntil: 0, lastPollAt: 0, capTrippedAt: 0 };

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
      capTrippedAt: Number.isFinite(raw.capTrippedAt) ? Number(raw.capTrippedAt) : 0,
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

/** Новое окно — новый разговор: запомненный потолок ответов снимается (FR-6). */
export function openWindow(now: number, minutes: number, path: string = STATE_PATH): void {
  const s = readState(path);
  writeState({ ...s, windowUntil: now + minutes * 60_000, capTrippedAt: 0 }, path);
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
 * группу надо собрать заново. 'lost' — блокировку перехватил другой
 * экземпляр: ответ не отправлен, метка не сдвинута, вопрос — его.
 */
export type AnswerOutcome = 'sent' | 'retry' | 'idle' | 'superseded' | 'lost';

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
  /**
   * Блокировка всё ещё наша? Спрашивается последним перед отправкой (FR-5):
   * процесс, простоявший на модели или паузе дольше срока блокировки, мог
   * её потерять. Не задан — считаем, что наша.
   */
  owns?: () => boolean;
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
  if (deps.owns !== undefined && !deps.owns()) return 'lost';
  await deps.dialog.setTyping();
  // Метку двигаем до отправки: падение на полпути не даст ответить дважды.
  // Состояние перечитывается: за время паузы окно мог сдвинуть другой процесс.
  writeState({ ...readState(statePath), lastMessageId: last.id }, statePath);
  await deps.dialog.send(r.text);
  log(`ответ на ${ids}: ${r.text.length} символов`, logPath);
  return 'sent';
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
  /** `note` в restart — журнал цикла: туда идут коды sc.exe и судьба GUI (FU-8). */
  vpn?: { isUp(): Promise<boolean>; restart(target: VpnTarget, note: (line: string) => void): Promise<boolean> };
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
    lock = acquireLock(lockPath, pid, opts.isAlive, now());
  } catch (e) {
    note(`блокировка не взялась: ${errText(e)}`);
    return;
  }
  if (!lock.ok) {
    note(`уже работает другой экземпляр (pid ${lock.holder}), выхожу`);
    return;
  }
  if (lock.stale !== null) note(`брошенная блокировка «${lock.stale}» перехвачена`);

  let dialog: TgDialog | null = null;
  try {
    // Потолок ответов сработал, нового окна с тех пор не было (FR-6): ни
    // VPN, ни Telegram не трогаем — отвечать всё равно не будем.
    const capped = readState(statePath).capTrippedAt;
    if (capped > 0) {
      note(`потолок ответов сработал ${new Date(capped).toISOString()}, до нового окна не отвечаю — выхожу`);
      return;
    }
    const vpn = opts.vpn ?? {
      isUp: () => isUp(defaultVpnDeps),
      restart: (target: VpnTarget, line: (l: string) => void) => restart(target, defaultVpnDeps, line),
    };
    if (!(await vpn.isUp())) {
      note(`VPN не отвечает, пробую перезапустить службу ${opts.config.vpnService}`);
      if (!(await vpn.restart({ service: opts.config.vpnService, app: opts.config.vpnApp }, note))) {
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
    await converse(dialog, opts, now, note, { path: lockPath, pid });
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

/** Сбой history(), который цикл ещё терпит (D2): шаг начинается заново через POLL_MS. */
class HistoryHiccup extends Error {}

/**
 * Диалог, чья history() терпит до HISTORY_FAILURES_TOLERATED сбоев подряд
 * (D2): каждый — строка в журнал и HistoryHiccup, следующий сверх предела —
 * исходная ошибка, сессия заканчивается, как раньше. Успех обнуляет счётчик.
 * Все чтения цикла идут через него, включая перечитывание перед отправкой:
 * сбой там — ответ не уходит вслепую, группа собирается заново.
 */
function tolerantDialog(dialog: TgDialog, note: (line: string) => void): TgDialog {
  let failures = 0;
  return {
    async history(minId) {
      try {
        const r = await dialog.history(minId);
        failures = 0;
        return r;
      } catch (e) {
        failures += 1;
        if (failures > HISTORY_FAILURES_TOLERATED) throw e;
        note(`история чата не прочиталась, сбой ${failures} подряд из ${HISTORY_FAILURES_TOLERATED} терпимых: ${errText(e)}`);
        throw new HistoryHiccup();
      }
    },
    send: (text) => dialog.send(text),
    setTyping: () => dialog.setTyping(),
    onMessage: (cb) => dialog.onMessage(cb),
    close: () => dialog.close(),
  };
}

/**
 * Пачка идёт сразу за нашим ответом моложе суток (H2)? Тогда сообщение с
 * кнопками в ней — оценка после нашего интервью, даже если отвечал другой
 * процесс или окно открылось заново. Выбор вакансии в новом интервью идёт за
 * старой оценкой бота или за нашим ответом старше суток — это не конец.
 */
async function followsOurRecentReply(
  dialog: TgDialog,
  msgs: DialogMessage[],
  floor: number,
  t: number,
): Promise<boolean> {
  const head = msgs.find((m) => !m.out && m.id > floor);
  if (head === undefined) return false;
  const prev = (await dialog.history(0)).filter((m) => m.id < head.id).at(-1);
  return prev !== undefined && prev.out && t - prev.date.getTime() <= STALE_MS;
}

/** Последовательный цикл разговора (R9): без рекурсии, без подписки, без гонок с close(). */
async function converse(
  raw: TgDialog,
  opts: RunOptions,
  now: () => number,
  note: (line: string) => void,
  lock: { path: string; pid: number },
): Promise<void> {
  const cfg = opts.config;
  const dialog = tolerantDialog(raw, note);
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
  /** Ответов в этой сессии: потолок (C1) и «разговор уже шёл» (R8). */
  let replies = 0;
  let pending = false;
  let sentCount = 0;
  let round = 0;
  let first = true;
  // Тишина — время с последнего входящего или отправленного. До первого
  // ответа сессию держит окно, после — тишина (R8). Неотвеченный вопрос —
  // не конец разговора: пока он висит, окно держит сессию и после первого
  // ответа, лестница повторов идёт до конца окна (спека 7). Окно,
  // закрывшееся посреди разговора, его не рвёт: дальше живём до тишины.
  const endsAt = (windowUntil: number): number =>
    (replies > 0 && !pending ? lastActivity + idleMs : Math.max(windowUntil, lastActivity + idleMs));

  for (;;) {
    try {
      const t = now();
      // Живой цикл продлевает блокировку (D1); перехватили — в чате второй цикл.
      if (!refreshLock(lock.path, lock.pid, t)) {
        note(`блокировку перехватил другой экземпляр, сессия закрыта: ответов ${sentCount}`);
        return;
      }
      const state = readState(statePath);
      if (state.windowUntil > windowMark) {
        // Окно открыли заново, пока мы работали (новый отклик): это новая сессия.
        windowMark = state.windowUntil;
        replies = 0;
      }
      if (!first && t >= endsAt(state.windowUntil)) {
        note(`сессия закрыта: ответов ${sentCount}, тишина ${Math.round((t - lastActivity) / 60_000)} мин`);
        return;
      }

      const msgs = await dialog.history(state.lastMessageId);
      // Граница R13: всё до нашего последнего сообщения отвечено или пропущено
      // намеренно — двойной ответ невозможен, даже если файл состояния потерян.
      const floor = Math.max(state.lastMessageId, ...msgs.filter((m) => m.out).map((m) => m.id));
      const batchEnd = Math.max(floor, msgs.at(-1)?.id ?? 0);
      const group: DialogMessage[] = [];
      let fresh = false;
      let buttons = false;
      for (const m of msgs) {
        if (m.out || m.id <= floor) continue;
        const stale = t - m.date.getTime() > STALE_MS;
        if (!stale) {
          fresh = true;
          buttons ||= m.hasButtons;
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
      if (buttons && (replies > 0 || await followsOurRecentReply(dialog, msgs, floor, t))) {
        // Конец интервью (C1): после наших ответов ГигаРекрутёр прощается и
        // сразу шлёт оценку с кнопками. Прощание без кнопок, но отвечать на
        // него — значит начать новый круг; вся пачка остаётся без ответа.
        // Счётчик ответов — только этого процесса и сбрасывается новым окном,
        // поэтому «после ответа» проверяется ещё и по истории чата (H2).
        //
        // Срез — по первому сообщению с кнопками (FU-7): за оценкой в той же
        // пачке может начаться новое интервью (клавиатура выбора вакансии и
        // вопрос). Метка встаёт на оценку, остальное разбирает следующий проход:
        // там клавиатура идёт за оценкой бота, а не за нашим ответом, — не конец.
        const cut = msgs.find((m) => !m.out && m.id > floor && m.hasButtons)!;
        bump(cut.id);
        note(`конец интервью: после ответа пришло сообщение с кнопками, пачка до ${cut.id} без ответа; ответов ${sentCount}`);
        const textAfterCut = msgs.some((m) => !m.out && m.id > cut.id && !m.hasButtons);
        const windowOpen = state.windowUntil > t;
        if (!textAfterCut && !windowOpen) return;
        // Старое интервью закрыто, следом может идти новое: счёт ответов заново.
        replies = 0;
        pending = false;
        note(textAfterCut ? 'после конца интервью в чате новое — разбираю дальше' : 'окно ещё открыто — жду нового интервью');
        continue;
      }
      bump(group.length === 0 ? batchEnd : floor);
      pending = group.length > 0;

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
        // Прошлые интервью (старше суток, R14) — про другую вакансию: в
        // транскрипт идёт только текущий разговор (M3).
        const transcript = toTranscript((await dialog.history(0))
          .filter((m) => m.id < head.id && t - m.date.getTime() <= STALE_MS));
        const seenUpTo = msgs.at(-1)?.id ?? head.id;
        const owns = (): boolean => refreshLock(lock.path, lock.pid, now());
        const r = await answerGroup({ dialog, group, seenUpTo, transcript, generate, delay, statePath, logPath, owns });
        if (r === 'lost') {
          note(`блокировку перехватил другой экземпляр перед отправкой, ответ не ушёл: ответов ${sentCount}`);
          return;
        }
        if (r === 'superseded') continue;
        if (r === 'sent') {
          replies += 1;
          pending = false;
          sentCount += 1;
          round = 0;
          lastActivity = now();
          if (replies >= cfg.maxRepliesPerSession) {
            // Два бота могут переписываться бесконечно (C1): дальше не отвечаем,
            // и следующие запуски тоже — до нового окна (FR-6).
            writeState({ ...readState(statePath), capTrippedAt: now() }, statePath);
            note(`потолок ${cfg.maxRepliesPerSession} ответов за сессию, сессия закрыта; до нового окна не отвечаю`);
            return;
          }
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
    } catch (e) {
      if (!(e instanceof HistoryHiccup)) throw e;
      await pause(POLL_MS);
    }
  }
}
