import type { TgBotDocument, TgBotMessage } from './types.js';
import type { BotStore } from './state.js';
import type { Queue } from '../core/queue.js';
import type { Settings } from '../core/settings.js';
import type { BotLimits } from '../core/config.js';
import type { ChatMessage } from '../core/openrouter.js';
import type { ReplyResult } from './reply.js';
import { TEXTS, BUTTONS } from './texts.js';
import { buildVacancy, assessVacancy, isFetchableLink, MAX_VACANCY_CHARS } from './intake.js';
import { buildVacancyMessages, buildQuestionMessages } from './reply.js';
import { parseMeetTime } from './meet.js';

/**
 * Вся логика бота: что ответить на сообщение и что записать. Функция не
 * касается ни сети, ни файлов — всё внешнее приходит зависимостями, поэтому
 * каждый сценарий (лимиты, страйки, режимы) проверяется тестом без единого
 * запроса наружу.
 */

export type BotAction =
  | { kind: 'text'; chatId: number; text: string; keyboard?: boolean }
  /** Отправить PDF резюме: путь и file_id знает транспорт (bot/run.ts). */
  | { kind: 'cv'; chatId: number }
  /** Сообщение владельцу. Уходит тем же ботом в личку по TG_OWNER_CHAT_ID. */
  | { kind: 'owner'; text: string };

export interface HandlerDeps {
  store: BotStore;
  queue: Queue;
  settings: () => Settings;
  limits: BotLimits;
  profile: { github: string; telegram: string };
  salaryExpectation: string;
  resume: () => string;
  askModel: (messages: ChatMessage[]) => Promise<ReplyResult>;
  readLink: (url: string) => Promise<string | null>;
  readFile: (doc: TgBotDocument) => Promise<
    { ok: true; text: string } | { ok: false; reason: 'type' | 'size' | 'unreadable' }
  >;
  now: () => Date;
}

/** Сколько живёт режим ожидания вакансии или даты (спека 2026-09-20, 4). */
export const MODE_TTL_MS = 30 * 60 * 1000;
/** Сколько текста вакансии уходит владельцу в пинге. */
const PING_QUOTE_CHARS = 400;

type Command = 'start' | 'cv' | 'profile' | 'add_vacancy' | 'set_meet';

/** Команда и текст кнопки — один и тот же вход, поэтому и обработчик один. */
function commandOf(text: string): Command | null {
  const t = text.trim();
  if (t === '/start') return 'start';
  if (t === '/cv' || t === BUTTONS[0]) return 'cv';
  if (t === '/profile' || t === BUTTONS[1]) return 'profile';
  if (t === '/add_vacancy' || t === BUTTONS[2]) return 'add_vacancy';
  if (t === '/set_meet' || t === BUTTONS[3]) return 'set_meet';
  return null;
}

function dayKey(now: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

function say(chatId: number, text: string, keyboard?: boolean): BotAction {
  return keyboard === true ? { kind: 'text', chatId, text, keyboard: true } : { kind: 'text', chatId, text };
}

/** Единственная ссылка в сообщении и ничего больше — повод сходить за текстом вакансии. */
function loneLink(text: string): string | null {
  const t = text.trim();
  if (/\s/.test(t)) return null;
  return isFetchableLink(t) ? t : null;
}

function isNonText(m: TgBotMessage): boolean {
  return m.photo !== undefined || m.voice !== undefined || m.video !== undefined
    || m.sticker !== undefined || m.audio !== undefined;
}

export async function handleMessage(message: TgBotMessage, deps: HandlerDeps): Promise<BotAction[]> {
  const chatId = message.chat.id;
  const username = message.from?.username ?? null;
  const now = deps.now();
  const nowMs = now.getTime();
  const day = dayKey(now);

  const previous = deps.store.chat(chatId);
  // Троттлинг считается по ПРОШЛОМУ сообщению, до записи нового времени.
  if (previous !== null && nowMs - previous.lastMsgAt < deps.limits.minIntervalMs) return [];

  const mode = deps.store.modeAt(chatId, nowMs);
  deps.store.touch(chatId, username, nowMs);
  const muted = previous?.mutedUntil !== undefined && previous.mutedUntil !== null
    && previous.mutedUntil > nowMs;

  const text = message.text ?? message.caption ?? '';
  const command = commandOf(text);

  // Команды бесплатны — работают и в молчании, и при исчерпанном лимите модели.
  if (command !== null) return handleCommand(command, chatId, nowMs, deps);

  if (message.document !== undefined) return handleDocument(message, mode, chatId, deps, day, muted);
  if (isNonText(message) || text.trim() === '') return [say(chatId, TEXTS.notText)];

  if (mode === 'await_meet') return handleMeetAnswer(text, chatId, now, day, deps);
  if (muted) return [say(chatId, TEXTS.limit(deps.profile.telegram))];
  if (mode === 'await_vacancy') return handleVacancyText(text, message.message_id, chatId, username, day, deps);
  return handleQuestion(text, chatId, day, deps);
}

function handleCommand(command: Command, chatId: number, nowMs: number, deps: HandlerDeps): BotAction[] {
  switch (command) {
    case 'start':
      return [say(chatId, TEXTS.start, true)];
    case 'cv':
      return [{ kind: 'cv', chatId }];
    case 'profile':
      return [say(chatId, TEXTS.profile(deps.profile.github, deps.profile.telegram))];
    case 'add_vacancy':
      deps.store.setMode(chatId, 'await_vacancy', nowMs + MODE_TTL_MS);
      return [say(chatId, TEXTS.askVacancy)];
    case 'set_meet':
      deps.store.setMode(chatId, 'await_meet', nowMs + MODE_TTL_MS);
      return [say(chatId, TEXTS.askMeet)];
  }
}

async function handleDocument(
  message: TgBotMessage, mode: 'idle' | 'await_vacancy' | 'await_meet', chatId: number,
  deps: HandlerDeps, day: string, muted: boolean,
): Promise<BotAction[]> {
  const doc = message.document;
  if (doc === undefined) return [];
  if (mode !== 'await_vacancy') return [say(chatId, TEXTS.askVacancy)];
  if (muted) return [say(chatId, TEXTS.limit(deps.profile.telegram))];

  const read = await deps.readFile(doc);
  if (!read.ok) {
    // Модель не зовётся: тип файла и размер видно без неё.
    if (read.reason === 'unreadable') return [say(chatId, TEXTS.unreadableFile)];
    return [say(chatId, TEXTS.badFile)];
  }
  return processVacancy(read.text, message.message_id, chatId, message.from?.username ?? null, day, deps);
}

async function handleVacancyText(
  text: string, messageId: number, chatId: number, username: string | null,
  day: string, deps: HandlerDeps,
): Promise<BotAction[]> {
  const link = loneLink(text);
  if (link !== null) {
    const fetched = await deps.readLink(link);
    // Не вышло — режим сохраняется: человек просто пришлёт текст следующим
    // сообщением, и оно всё ещё будет считаться вакансией.
    if (fetched === null) return [say(chatId, TEXTS.askVacancy)];
    return processVacancy(`${text}\n\n${fetched}`, messageId, chatId, username, day, deps);
  }
  return processVacancy(text, messageId, chatId, username, day, deps);
}

/**
 * Вакансия пришла: строка в очередь (если прошла отсев), ответ рекрутёру от
 * модели и пинг владельцу. Отсев не меняет ответ рекрутёру: отказ по фильтру —
 * решение владельца, а не повод грубить человеку.
 */
async function processVacancy(
  raw: string, messageId: number, chatId: number, username: string | null,
  day: string, deps: HandlerDeps,
): Promise<BotAction[]> {
  const settings = deps.settings();
  const text = raw.slice(0, MAX_VACANCY_CHARS);
  const titleWords = settings.specialties.filter((s) => s.enabled).flatMap((s) => s.titleWords);
  const vacancy = buildVacancy({ text, chatId, messageId, username, titleWords, now: deps.now() });
  const { specialty, screen, score, matched } = assessVacancy(vacancy, settings);

  let queueId: number | null = null;
  let note = '';
  if (!screen.passed) {
    note = `отсеяна: ${screen.reason} (${screen.detail})`;
  } else if (vacancy.contentHash !== null && deps.queue.hasContentHash(vacancy.contentHash)) {
    note = 'такая вакансия уже в очереди';
  } else if (deps.queue.insertPending(vacancy, score, matched, '', 'none', specialty.id)) {
    queueId = deps.queue.idOf(vacancy.source, vacancy.sourceId);
    if (queueId !== null) deps.store.setLastQueueId(chatId, queueId);
  } else {
    note = 'уже была в очереди';
  }

  deps.store.setMode(chatId, 'idle', null);

  const actions: BotAction[] = [];
  const allowed = allowModelCall(chatId, day, deps);
  if (allowed) {
    deps.store.countModelCall(day, chatId);
    deps.store.countModelCall(day, 0);
    const reply = await deps.askModel(buildVacancyMessages({
      text, resume: deps.resume(), role: specialty.name,
    }));
    actions.push(say(chatId, replyText(reply, chatId, deps)));
  } else {
    actions.push(say(chatId, TEXTS.limit(deps.profile.telegram)));
  }

  actions.push({
    kind: 'owner',
    text: [
      `Вакансия от ${username === null ? `id ${chatId}` : `@${username}`}`,
      `${vacancy.title} — скор ${score}, специальность «${specialty.name}»`,
      queueId === null ? note : `в очереди #${queueId}`,
      vacancy.url === '' ? '' : vacancy.url,
      '',
      text.slice(0, PING_QUOTE_CHARS),
    ].filter((s) => s !== '').join('\n'),
  });
  return actions;
}

function handleMeetAnswer(
  text: string, chatId: number, now: Date, day: string, deps: HandlerDeps,
): BotAction[] {
  const parsed = parseMeetTime(text, now);
  // Режим не снимается: человек ошибся форматом, а не передумал встречаться.
  if (parsed === null) return [say(chatId, TEXTS.meetBadFormat)];

  if (deps.store.meetingsToday(chatId, day) >= deps.limits.meetingsPerChatPerDay) {
    return [say(chatId, TEXTS.limit(deps.profile.telegram))];
  }

  const chat = deps.store.chat(chatId);
  deps.store.saveMeeting({
    chatId,
    username: chat?.username ?? null,
    queueId: chat?.lastQueueId ?? null,
    meetAt: parsed.at.getTime(),
    raw: text.trim(),
    createdAt: now.getTime(),
  });
  deps.store.setMode(chatId, 'idle', null);
  // Пинг владельцу собирает сам цикл из bot_meetings: запись сделана до
  // отправки, поэтому сбой сети не теряет договорённость.
  return [say(chatId, TEXTS.meetSaved(parsed.pretty))];
}

async function handleQuestion(
  text: string, chatId: number, day: string, deps: HandlerDeps,
): Promise<BotAction[]> {
  if (!allowModelCall(chatId, day, deps)) return [say(chatId, TEXTS.limit(deps.profile.telegram))];
  deps.store.countModelCall(day, chatId);
  deps.store.countModelCall(day, 0);
  const reply = await deps.askModel(buildQuestionMessages({
    question: text, resume: deps.resume(), salaryExpectation: deps.salaryExpectation,
  }));
  return [say(chatId, replyText(reply, chatId, deps))];
}

function allowModelCall(chatId: number, day: string, deps: HandlerDeps): boolean {
  if (deps.store.modelCalls(day, chatId) >= deps.limits.perChatPerDay) return false;
  return deps.store.modelCalls(day, 0) < deps.limits.perBotPerDay;
}

/**
 * Исход вызова модели в текст рекрутёру. Оффтоп и брак фильтра отвечаются
 * одинаково (решение владельца 2026-09-20) и оба дают страйк: снаружи это одно
 * и то же, а срабатывает фильтр чаще всего на попытке вытянуть лишнее.
 */
function replyText(reply: ReplyResult, chatId: number, deps: HandlerDeps): string {
  if (reply.kind === 'text') {
    deps.store.resetStrikes(chatId);
    return reply.text;
  }
  if (reply.kind === 'failure') return TEXTS.modelFailure;
  const strikes = deps.store.addStrike(chatId);
  if (strikes >= deps.limits.strikesBeforeMute) {
    deps.store.mute(chatId, deps.now().getTime() + deps.limits.muteHours * 3600_000);
  }
  return TEXTS.offTopic;
}
