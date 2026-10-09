import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotStore, businessKey } from '../../src/bot/state.js';
import { Queue } from '../../src/core/queue.js';
import { seedSettings, type Settings } from '../../src/core/settings.js';
import { DEFAULT_BOT_LIMITS, DEFAULT_SECRETARY, type SecretaryConfig } from '../../src/core/config.js';
import { ChatMemory } from '../../src/bot/memory.js';
import { extractNumbers } from '../../src/core/facts.js';
import { normalizeVacancy } from '../../src/core/vacancy.js';
import type { ChatMessage } from '../../src/core/openrouter.js';
import type { SecretaryDeps, SecretaryInput } from '../../src/bot/secretary.js';
import type { SecretaryReply, AnswerProblem } from '../../src/bot/secretary-prompt.js';
import type { TgBotMessage, TgBotUpdate, TgBusinessConnection } from '../../src/bot/types.js';

/** Пятница, 9 октября 2026, 12:00 по местному времени машины. */
export const T0 = new Date(2026, 9, 9, 12, 0, 0, 0).getTime();
export const FACTS_SAMPLE = readFileSync('tests/fixtures/facts-sample.md', 'utf8');
export const RESUME = 'Артём, бизнес-аналитик. BPMN 2.0, SQL, интеграции, Jira. Сократил трудозатраты с 76 до 11 часов в месяц.';

export interface Harness {
  deps: SecretaryDeps;
  store: BotStore;
  queue: Queue;
  memory: ChatMemory;
  /** Что получила модель, по вызовам. */
  asked: ChatMessage[][];
  /** Проверки ответа, как их видит модель (для тестов валидатора). */
  checks: Array<(body: string) => AnswerProblem | null>;
  clock: { now: number };
  settings: Settings;
  /** Следующие ответы модели; пусто — «ответ модели». */
  replies: SecretaryReply[];
  typed: number;
}

export interface HarnessOptions {
  settings?: (s: Settings) => void;
  secretary?: Partial<SecretaryConfig>;
  facts?: string;
  readLink?: SecretaryDeps['readLink'];
  readFile?: SecretaryDeps['readFile'];
  limits?: Partial<SecretaryDeps['limits']>;
}

export function makeHarness(o: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'jaa-sec-'));
  const path = join(dir, 'queue.db');
  const settings = seedSettings(undefined, null);
  // Календарь считает в поясе владельца; T0 построен в поясе машины, поэтому и тесты — в нём.
  settings.calendar.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  o.settings?.(settings);
  const clock = { now: T0 };
  const store = new BotStore(path);
  const queue = new Queue(path);
  const memory = new ChatMemory({ turns: 8, ttlMs: 6 * 3_600_000 });
  const facts = o.facts ?? FACTS_SAMPLE;
  const h: Harness = {
    deps: undefined as unknown as SecretaryDeps, store, queue, memory, asked: [], checks: [], clock, settings, replies: [], typed: 0,
  };
  h.deps = {
    store,
    queue,
    settings: () => settings,
    limits: { ...DEFAULT_BOT_LIMITS, ...o.limits },
    profile: { github: 'https://github.com/x', telegram: '@HIRE_agent' },
    salaryExpectation: '180–260 тыс. ₽ на руки',
    resume: () => RESUME,
    askModel: async () => ({ kind: 'text', text: 'не должен вызываться' }),
    readLink: o.readLink ?? (async () => null),
    readFile: o.readFile ?? (async () => ({ ok: false, reason: 'type' })),
    now: () => new Date(clock.now),
    secretary: { account: 'HIRE_agent', ...DEFAULT_SECRETARY, ...o.secretary },
    memory,
    facts: () => ({ text: facts, numbers: extractNumbers(facts) }),
    dialogs: null,
    askSecretary: async (messages, check) => {
      h.asked.push(messages);
      h.checks.push(check);
      return h.replies.shift() ?? { kind: 'text', text: 'ответ модели' };
    },
    typing: async () => { h.typed += 1; },
    role: () => 'Бизнес-аналитик',
  };
  return h;
}

/** Ввод мозга по умолчанию: личка @rec (id 77), одно сообщение. */
export function input(h: Harness, over: Partial<SecretaryInput> = {}): SecretaryInput {
  return {
    channel: 'business',
    chatKey: businessKey(77),
    peerChatId: 77,
    connectionId: 'c1',
    username: 'rec',
    messageIds: [1],
    text: '',
    document: null,
    nonTextOnly: false,
    at: h.clock.now,
    edit: null,
    ...over,
  };
}

/** Строка очереди «мы написали @rec по вакансии» со статусом sent. Возвращает id. */
export function seedSent(h: Harness, over: { title?: string; contact?: string; letter?: string } = {}): number {
  const contact = over.contact ?? 'rec';
  const v = normalizeVacancy({
    source: 'tg', sourceId: `-100:${Math.floor(Math.random() * 1e6)}`, title: over.title ?? 'Системный аналитик', company: '',
    url: 'https://t.me/jobs/5', description: 'Нужны BPMN и SQL. Зарплата 250 000.', geo: '', postedAt: new Date(T0),
    contact,
  });
  h.queue.insertPending(v, 50, [], over.letter ?? 'Привет! Я - Хаер, ИИ ассистент кандидата. Пишу тебе по вакансии.', 'dm');
  const id = h.queue.idOf(v.source, v.sourceId)!;
  h.queue.approve(id);
  h.queue.markSent(id);
  return id;
}

export const bizConn = (over: Partial<TgBusinessConnection> = {}): TgBusinessConnection => ({
  id: 'c1',
  user: { id: 500, is_bot: false, username: 'HIRE_agent' },
  user_chat_id: 500,
  date: Math.floor(T0 / 1000),
  rights: { can_reply: true },
  is_enabled: true,
  ...over,
});

/** Входящее сообщение рекрутёра (id 77, @rec) в личке аккаунта. */
export const bizMsg = (over: Partial<TgBotMessage> = {}): TgBotMessage => ({
  message_id: 1,
  date: Math.floor(T0 / 1000),
  chat: { id: 77, type: 'private', username: 'rec' },
  from: { id: 77, username: 'rec', is_bot: false },
  business_connection_id: 'c1',
  text: 'Привет',
  ...over,
});

/** Сообщение самого аккаунта (id 500): ручное, GramJS или ответ этого бота. */
export const ownerMsg = (over: Partial<TgBotMessage> = {}): TgBotMessage =>
  bizMsg({ from: { id: 500, username: 'HIRE_agent', is_bot: false }, ...over });

export const bizUpdate = (n: number, over: Partial<TgBotUpdate>): TgBotUpdate => ({ update_id: n, ...over });
