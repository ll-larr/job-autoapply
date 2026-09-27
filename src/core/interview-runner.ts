import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDialog, type DialogMessage, type TgDialog } from '../telegram/interview-session.js';
import { generateAnswer, type Turn } from './interview.js';
import { readFacts } from './facts.js';
import { isUp, restart, defaultVpnDeps, sleep, type VpnTarget } from './vpn.js';
import type { GigarecruiterConfig } from './config.js';
import { acquireLock, releaseLock, refreshLock, LOCK_PATH } from './interview-lock.js';
import { readSession } from '../telegram/session.js';
import {
  CHOICE_GRACE_MS, choiceStep, interviewTitle, isChoiceMade, isChoicePrompt, isChoiceText, isInterviewBoundary, isInterviewStart, withInterviewed,
} from './interview-choice.js';

/**
 * Цикл автоответа (спека 2026-09-25, 3 и 7; поправки контроллера R6–R15).
 *
 * Окно открыто (`windowUntil > now`, его открывает `interview --window`) —
 * сессия ждёт первое сообщение сколько угодно долго, до конца окна; после
 * первого ответа гаснет по `idleMinutes` тишины. Окна нет — это поллинг: нет
 * новых входящих — выход сразу, есть — отвечаем и живём до тишины. В любом
 * режиме сессию заканчивают потолок `maxRepliesPerSession` и сообщение с
 * кнопками после нашего ответа — так ГигаРекрутёр закрывает интервью (C1);
 * «после ответа» — этой сессии или по истории чата моложе суток (H2). Такой
 * конец, пришедший уже в текущем окне, запоминается до нового окна (FU-9);
 * пришедший до его открытия — хвост прошлого интервью, разбор идёт дальше.
 *
 * Единственная кнопка, которую цикл нажимает, — вариант подсказки выбора
 * вакансии (G2, решения — interview-choice.ts). Подсказка и начало нового
 * интервью — граница: конец FU-9 их не глотает, текст до них остаётся без
 * ответа, а выбор (наш, бота или владельца) и начало, присланное ботом без
 * подсказки, снимают запомненный конец — начинается новое интервью. Каждое
 * начатое интервью считается в потолок maxInterviewsPerWindow (C2).
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
  /**
   * Свежий конец интервью (FU-9): дата сообщения с кнопками после нашего
   * ответа, пришедшего уже после открытия текущего окна (FU-15: дата самого
   * сообщения, а не момент разбора). 0 — не было.
   * Пока оно позже открытия окна, ни поллинг, ни запуск не отвечают:
   * «Спасибо за оценку!» после оценки иначе снова завело бы разговор двух
   * ботов (C1). Снимает новое окно (openWindow) — новый отклик — или выбор
   * вакансии в подсказке ГигаРекрутёра (G2): это начало следующего интервью.
   */
  interviewEndedAt: number;
  /**
   * Вакансия идущего интервью (G2): нажатый нами вариант (C2) или «Получил Ваш
   * отклик на позицию X» из начала интервью; '' — не знаем.
   */
  currentTitle: string;
  /**
   * Вакансии начатых интервью (G2, C2), нормализованные (normalizeTitle):
   * нажатая — сразу при нажатии, начатая ботом — по его началу. В подсказке
   * выбора они пропускаются. Новое окно их не снимает.
   */
  interviewedTitles: string[];
  /**
   * Интервью, начатых в текущем окне (C2): нажатый вариант подсказки или начало,
   * присланное ботом. Сверх maxInterviewsPerWindow срабатывает потолок
   * (capTrippedAt). Обнуляет новое окно.
   */
  interviewsInWindow: number;
  /** id последнего разобранного начала интервью: одно начало считается один раз. */
  lastStartId: number;
  /**
   * id подсказки, где мы нажали вариант, пока его начало интервью не пришло
   * (C2): нажатие уже посчитано, и это начало второй раз не считается. 0 —
   * нет. Кроме более позднего начала (countStarts), снимается новым окном
   * (openWindow) и концом интервью (finished): начало нажатого варианта
   * может не прийти вовсе, и метка не должна переживать ни то, ни другое —
   * иначе она «предоплатит» не связанный с этим нажатием старт (R2-3).
   */
  pressedPromptId: number;
  /**
   * Подсказка, где нажата «Далее» (I2), и её кнопки в тот момент: «Далее» —
   * один раз на подсказку, в любом процессе. 0 и '' — не нажималась.
   */
  pagedPromptId: number;
  pagedSnapshot: string;
}

const EMPTY: RunnerState = {
  lastMessageId: 0, windowUntil: 0, lastPollAt: 0, capTrippedAt: 0, interviewEndedAt: 0, currentTitle: '', interviewedTitles: [],
  interviewsInWindow: 0, lastStartId: 0, pressedPromptId: 0, pagedPromptId: 0, pagedSnapshot: '',
};

export function backoffFor(round: number): number {
  const i = Math.min(round, RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[i]!;
}

export function readState(path: string = STATE_PATH): RunnerState {
  if (!existsSync(path)) return { ...EMPTY, interviewedTitles: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<keyof RunnerState, unknown>;
    const num = (v: unknown): number => (Number.isFinite(v) ? Number(v) : 0);
    return {
      lastMessageId: num(raw.lastMessageId),
      windowUntil: num(raw.windowUntil),
      lastPollAt: num(raw.lastPollAt),
      capTrippedAt: num(raw.capTrippedAt),
      interviewEndedAt: num(raw.interviewEndedAt),
      currentTitle: typeof raw.currentTitle === 'string' ? raw.currentTitle : '',
      interviewedTitles: Array.isArray(raw.interviewedTitles)
        ? raw.interviewedTitles.filter((t): t is string => typeof t === 'string')
        : [],
      interviewsInWindow: num(raw.interviewsInWindow),
      lastStartId: num(raw.lastStartId),
      pressedPromptId: num(raw.pressedPromptId),
      pagedPromptId: num(raw.pagedPromptId),
      pagedSnapshot: typeof raw.pagedSnapshot === 'string' ? raw.pagedSnapshot : '',
    };
  } catch {
    // Битый файл не должен ронять цикл: начинаем с нуля.
    return { ...EMPTY, interviewedTitles: [] };
  }
}

export function writeState(s: RunnerState, path: string = STATE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  renameSync(tmp, path);
}

/**
 * Новое окно — новый разговор: запомненные потолок (FR-6, C2) и конец
 * интервью (FU-9) снимаются, счёт интервью за окно начинается с нуля.
 * pressedPromptId тоже снимается (R2-3): без него нажатие, чей start не
 * пришёл, переживало бы окно и «предоплатило» бы первый старт следующего —
 * тот не посчитался бы в потолок. «Далее» (pagedPromptId/pagedSnapshot) новое
 * окно не трогает — это метка страницы конкретной подсказки, а не окна.
 */
export function openWindow(now: number, minutes: number, path: string = STATE_PATH): void {
  const s = readState(path);
  writeState({
    ...s, windowUntil: now + minutes * 60_000, capTrippedAt: 0, interviewEndedAt: 0, interviewsInWindow: 0, pressedPromptId: 0,
  }, path);
}

/**
 * Когда открылось текущее (или последнее) окно (FU-9): windowUntil минус его
 * длина. Окна не было ни разу — отрицательное число, раньше любого сообщения.
 */
export function windowOpenedAt(s: RunnerState, windowMinutes: number): number {
  return s.windowUntil - windowMinutes * 60_000;
}

/**
 * Интервью текущего окна уже закончилось (FU-9)? Ноль — «не заканчивалось»:
 * без проверки на него окно, которого не было (открытие в минусе), считалось
 * бы закрытым навсегда.
 */
function interviewEnded(s: RunnerState, windowMinutes: number): boolean {
  return s.interviewEndedAt > 0 && s.interviewEndedAt > windowOpenedAt(s, windowMinutes);
}

const endedLine = (s: RunnerState): string =>
  `интервью закончилось ${new Date(s.interviewEndedAt).toISOString()}, ни подсказки выбора вакансии, ни начала нового — выхожу`;

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
  /** Есть ли сессия личного аккаунта (G1). Не задано — файл `config.sessionPath` непустой. */
  hasSession?: (path: string) => boolean;
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
    // Интервью идёт с сессии личного аккаунта (G1), не с рабочей. Пока владелец
    // в неё не вошёл, ни VPN, ни Telegram не трогаем: одна строка и выход.
    const sessionPath = opts.config.sessionPath;
    if (!(opts.hasSession ?? ((p: string) => readSession(p) !== null))(sessionPath)) {
      note(`нет сессии личного аккаунта — войди: npm run tg:login -- --session ${sessionPath}`);
      return;
    }
    // Потолок ответов (FR-6) или интервью за окно (C2) сработал, нового окна
    // с тех пор не было: ни VPN, ни Telegram не трогаем — отвечать всё равно
    // не будем. Конец интервью (FU-9) так рано не выходит: в молчании после
    // него видны подсказка выбора вакансии и начало следующего (G2).
    const capped = readState(statePath).capTrippedAt;
    if (capped > 0) {
      note(`потолок сработал ${new Date(capped).toISOString()}, до нового окна не отвечаю — выхожу`);
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
    const opened = await (opts.openDialog ?? openDialog)(opts.config.username, { sessionPath });
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
    getMessage: (id) => dialog.getMessage(id),
    send: (text) => dialog.send(text),
    setTyping: () => dialog.setTyping(),
    pressButton: (messageId, text) => dialog.pressButton(messageId, text),
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
  /** До какого момента сессию держит выдержка перед нажатием в подсказке выбора (G2). */
  let hold = 0;
  /**
   * После свежего конца без подсказки — до какого момента ждать подсказку или
   * начало нового интервью (M1): бот шлёт их той же секундой, что и оценку, но
   * история могла прочитаться между ними. 0 — не ждём.
   */
  let endHold = 0;
  // Тишина — время с последнего входящего или отправленного. До первого
  // ответа сессию держит окно, после — тишина (R8). Неотвеченный вопрос —
  // не конец разговора: пока он висит, окно держит сессию и после первого
  // ответа, лестница повторов идёт до конца окна (спека 7). Окно,
  // закрывшееся посреди разговора, его не рвёт: дальше живём до тишины.
  const endsAt = (windowUntil: number): number => Math.max(hold, endHold,
    replies > 0 && !pending ? lastActivity + idleMs : Math.max(windowUntil, lastActivity + idleMs));
  /** Вакансия выбрана (нами, ботом или владельцем) — дальше новое интервью (G2). */
  const newInterview = (): void => {
    replies = 0;
    pending = false;
    hold = 0;
    endHold = 0;
    lastActivity = now();
  };
  /**
   * Интервью закончилось: его вакансия — в пройденные (G2). pressedPromptId
   * снимается и здесь (R2-3): если start нажатого варианта так и не пришёл,
   * метка не должна переживать конец интервью и «предоплачивать» будущий
   * старт, с этим нажатием не связанный.
   */
  const finished = (s: RunnerState): Pick<RunnerState, 'currentTitle' | 'interviewedTitles' | 'pressedPromptId'> =>
    ({ currentTitle: '', interviewedTitles: withInterviewed(s.interviewedTitles, s.currentTitle), pressedPromptId: 0 });
  /**
   * Начала интервью в группе (G2, C2), каждое один раз (lastStartId): вакансия —
   * в текущую и сразу в пройденные, начало — в счёт интервью за окно. Начало
   * вслед за нашим нажатием уже посчитано при нажатии (pressedPromptId). Начало
   * по уже пройденной вакансии отвечается (бот решил спросить снова), но тоже
   * считается. Сверх maxInterviewsPerWindow — потолок: группа без ответа,
   * capTrippedAt, false — сессия выходит.
   */
  const countStarts = (group: readonly DialogMessage[]): boolean => {
    let s = readState(statePath);
    const opens = group.filter((m) => m.id > s.lastStartId && isInterviewStart(m));
    if (opens.length === 0) return true;
    for (const m of opens) {
      const title = interviewTitle(m.text)!;
      const prepaid = s.pressedPromptId > 0 && m.id > s.pressedPromptId;
      const count = s.interviewsInWindow + (prepaid ? 0 : 1);
      if (count > cfg.maxInterviewsPerWindow) {
        writeState({ ...s, capTrippedAt: now() }, statePath);
        note(`потолок ${cfg.maxInterviewsPerWindow} интервью за окно: начало интервью ${m.id} без ответа; до нового окна не отвечаю`);
        return false;
      }
      s = {
        ...s,
        interviewsInWindow: count,
        pressedPromptId: prepaid ? 0 : s.pressedPromptId,
        lastStartId: m.id,
        currentTitle: title,
        interviewedTitles: withInterviewed(s.interviewedTitles, title),
      };
      note(`начало интервью ${m.id}: вакансия «${title}», интервью за окно: ${count}`);
    }
    writeState(s, statePath);
    return true;
  };

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
      // Интервью этого окна закончилось (FU-9): текст остаётся без ответа,
      // разбирается только выбор вакансии — начало следующего (G2).
      const ended = interviewEnded(state, cfg.windowMinutes);
      const group: DialogMessage[] = [];
      let fresh = false;
      let buttons = false;
      for (const m of msgs) {
        if (m.out || m.id <= floor) continue;
        const stale = t - m.date.getTime() > STALE_MS;
        if (!stale) {
          fresh = true;
          if (m.id > seenId) { seenId = m.id; lastActivity = t; }
        }
        // Подсказку выбора разбирают ниже; она не конец интервью и не вопрос (G2).
        if (ended || (!stale && isChoicePrompt(m))) continue;
        buttons ||= !stale && m.hasButtons;
        if (stale || m.hasButtons || isChoiceMade(m) || isChoiceText(m)) {
          // Кнопки не нажимаем и не отвечаем на них (R7); старое — прошлый
          // разговор (R14); «Спасибо за выбор вакансии» и любая строка про
          // выбор вакансии («выберите вакансию из списка выше») — служебные,
          // вопроса в них нет (G2, M2).
          if (!logged.has(m.id)) {
            note(stale ? `пропущено ${m.id}: старше суток`
              : m.hasButtons ? `пропущено сообщение с кнопками ${m.id}`
                : isChoiceMade(m) ? `пропущено ${m.id}: вакансия выбрана` : `пропущено ${m.id}: служебная строка выбора вакансии`);
          }
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
        // Какой это конец, решает дата сообщения с кнопками (FU-9). Пришло
        // после открытия окна — конец текущего интервью: вся пачка без ответа,
        // конец запоминается до нового окна, сессия выходит. Пришло раньше —
        // хвост прошлого интервью, а новое (отклик открыл окно) может идти
        // следом в той же пачке или позже. Метка встаёт на это сообщение и на
        // всё, что пришло за ним ещё до открытия окна, — это тоже прошлое
        // интервью («Если появятся вопросы — пишите!»), отвечать на него —
        // снова завести двух ботов (FU-14). Пришедшее после открытия разбирает
        // следующий проход — там клавиатура нового интервью идёт за оценкой
        // бота, а не за нашим ответом, это не конец.
        //
        // Живой конец (2026-09-27) — прощание, оценка и подсказка выбора
        // вакансии одной секундой, а когда вакансия осталась одна — прощание,
        // оценка и сразу начало нового интервью. Подсказка, её след «Спасибо за
        // выбор…» или начало интервью — граница: метка встаёт перед ней, её
        // разбирает следующий проход (G2). Вакансия закончившегося интервью
        // уходит в пройденные — и при свежем конце, и при хвосте.
        const cut = msgs.find((m) => !m.out && m.id > floor && m.hasButtons && !isChoicePrompt(m))!;
        const next = msgs.find((m) => !m.out && m.id > cut.id && isInterviewBoundary(m));
        const before = (end: number): number => (next === undefined ? end
          : Math.max(cut.id, ...msgs.filter((m) => m.id < next.id && m.id <= end).map((m) => m.id)));
        const openedAt = windowOpenedAt(state, cfg.windowMinutes);
        if (cut.date.getTime() >= openedAt) {
          // Время конца — дата самой оценки, а не «сейчас» (FU-15): окно, которое
          // новый отклик открыл между чтением состояния и этой записью, началось
          // позже оценки, и конец прошлого интервью его не заглушит.
          const s = readState(statePath);
          const end = before(batchEnd);
          writeState({
            ...s, lastMessageId: Math.max(s.lastMessageId, end), interviewEndedAt: cut.date.getTime(), ...finished(s),
          }, statePath);
          // Подсказки ещё нет — сессия ждёт её CHOICE_GRACE_MS и ещё 30 с от даты
          // оценки, потом выходит (M1): пачка могла разорваться между оценкой и
          // подсказкой, которые бот шлёт одной секундой. Конец, найденный
          // поллингом через час, не держит сессию зря.
          if (next === undefined) endHold = cut.date.getTime() + CHOICE_GRACE_MS + 30_000;
          note(`конец интервью: после ответа пришло сообщение с кнопками, пачка до ${end} без ответа; ответов ${sentCount}; `
            + (next === undefined ? `подсказку выбора вакансии жду до ${new Date(endHold).toISOString()}`
              : isInterviewStart(next) ? `следом начало нового интервью ${next.id}` : `следом выбор вакансии ${next.id}`));
          continue;
        }
        const tailEnd = before(Math.max(cut.id, ...msgs.filter((m) => m.id > cut.id && m.date.getTime() < openedAt).map((m) => m.id)));
        const s = readState(statePath);
        writeState({ ...s, lastMessageId: Math.max(s.lastMessageId, tailEnd), ...finished(s) }, statePath);
        note(`хвост прошлого интервью: сообщение с кнопками ${cut.id} пришло до открытия окна, пачка до ${tailEnd} без ответа — разбираю дальше`);
        replies = 0;
        pending = false;
        continue;
      }

      // Граница интервью (G2): последняя свежая подсказка, её след или начало нового.
      const item = msgs.findLast((m) => !m.out && m.id > floor && t - m.date.getTime() <= STALE_MS && isInterviewBoundary(m));
      if (ended && item !== undefined && !isChoicePrompt(item)) {
        const s = readState(statePath);
        if (isChoiceMade(item)) {
          // Подсказка уже «Спасибо за выбор вакансии»: выбрали без нас (бот сам
          // или владелец) — начинается новое интервью, молчание FU-9 снято.
          writeState({ ...s, lastMessageId: Math.max(s.lastMessageId, item.id), interviewEndedAt: 0 }, statePath);
          note(`выбор вакансии ${item.id}: вакансию выбрали без нас, начинается новое интервью`);
        } else {
          // Начало интервью без подсказки: вакансия осталась одна, бот начал сам
          // (живое наблюдение 2026-09-27). Законное новое интервью — молчание
          // FU-9 снято, метка встаёт перед началом, следующий проход на него
          // отвечает; всё до него («Спасибо за оценку!») — без ответа.
          const upTo = Math.max(floor, ...msgs.filter((m) => m.id < item.id).map((m) => m.id));
          writeState({ ...s, lastMessageId: Math.max(s.lastMessageId, upTo), interviewEndedAt: 0 }, statePath);
          note(`начало интервью ${item.id} после конца прошлого: бот начал сам, молчание снято`);
        }
        newInterview();
        continue;
      }
      const prompt = item !== undefined && isChoicePrompt(item) ? item : undefined;
      if (ended && prompt === undefined) {
        // Свежий конец этой сессии — ещё ждём подсказку или начало (M1); текст
        // тем временем без ответа (FU-9). Иначе — одна строка и выход.
        if (t < endHold) {
          await pause(POLL_MS);
          continue;
        }
        note(endedLine(state));
        return;
      }
      if (prompt === undefined) {
        bump(group.length === 0 ? batchEnd : floor);
        pending = group.length > 0;
        hold = 0;
      }

      if (first) {
        first = false;
        if (state.windowUntil <= t && !fresh) {
          note('поллинг: новых входящих нет');
          return;
        }
        note(state.windowUntil > t ? `сессия: окно до ${new Date(state.windowUntil).toISOString()}` : 'сессия: поллинг нашёл новое');
      }

      if (prompt !== undefined) {
        const step = await choiceStep({
          prompt, msgs, now: t, interviewed: state.interviewedTitles, current: state.currentTitle,
          // «Далее» — один раз на подсказку в любом процессе (I2).
          pagedAt: state.pagedPromptId === prompt.id ? state.pagedSnapshot : undefined,
          canStart: state.interviewsInWindow < cfg.maxInterviewsPerWindow,
          getMessage: (id) => dialog.getMessage(id),
          history: (id) => dialog.history(id),
          press: (id, text) => dialog.pressButton(id, text),
          owns: () => refreshLock(lock.path, lock.pid, now()),
        });
        if (step.kind === 'lost') {
          note(`блокировку перехватил другой экземпляр перед нажатием, ничего не нажато: ответов ${sentCount}`);
          return;
        }
        if (step.kind === 'capped') {
          // Ещё одно интервью было бы сверх потолка за окно (C2): как у ответов, до нового окна.
          writeState({ ...readState(statePath), capTrippedAt: now() }, statePath);
          note(`потолок ${cfg.maxInterviewsPerWindow} интервью за окно: выбор вакансии ${prompt.id} не нажат; до нового окна не отвечаю`);
          return;
        }
        pending = false;
        if (step.kind === 'done') {
          const s = readState(statePath);
          // Нажатая вакансия записывается сразу, не по началу интервью (C2): оно
          // может назвать её иначе или не прийти вовсе. Нажатие — начатое
          // интервью: считается в потолок, а его начало второй раз не считается.
          const pressed: Partial<RunnerState> = step.pressed === undefined ? {} : {
            currentTitle: step.pressed,
            interviewedTitles: withInterviewed(s.interviewedTitles, step.pressed),
            interviewsInWindow: s.interviewsInWindow + 1,
            pressedPromptId: prompt.id,
          };
          writeState({
            ...s, lastMessageId: Math.max(s.lastMessageId, prompt.id), ...(step.started ? { interviewEndedAt: 0 } : {}), ...pressed,
          }, statePath);
          note(step.line);
          hold = 0;
          if (step.started) newInterview();
          continue;
        }
        // Текст до подсказки — прошлый разговор, без ответа; сама она
        // перечитывается следующим проходом, пока не станет можно жать.
        bump(Math.max(floor, ...msgs.filter((m) => m.id < prompt.id).map((m) => m.id)));
        if (step.kind === 'paged') {
          writeState({ ...readState(statePath), pagedPromptId: prompt.id, pagedSnapshot: step.snapshot }, statePath);
          note(step.line);
          lastActivity = now();
        } else if (step.until > 0) {
          hold = step.until + POLL_MS;
        }
        await pause(POLL_MS);
        continue;
      }

      const head = group[0];
      if (head !== undefined) {
        if (!countStarts(group)) return;
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
