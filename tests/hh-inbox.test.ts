import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkHhInbox, probeHhInbox, lastHhReport, chatProbeFresh,
  type HhChat, type HhInboxDeps, type HhNegotiationsPage, type HhSession, type ChatProbe,
} from '../src/hh/inbox.js';
import type { FrameLike, ItemLike } from '../src/hh/chat.js';
import { CHAT_MESSAGE_CANDIDATES } from '../src/hh/inbox-selectors.js';
import { Dialogs } from '../src/core/dialogs.js';
import { Queue } from '../src/core/queue.js';
import { BotStore } from '../src/bot/state.js';
import type { Settings } from '../src/core/settings.js';
import type { SecretaryInput, SecretaryOutcome } from '../src/bot/secretary.js';

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 7, 12, 0).getTime();

interface TopicSpec {
  id: number; vacancy: number; state?: string; inbox?: string; count?: number; hasNew?: boolean; modified?: number;
}

const htmlOf = (topics: TopicSpec[]): string =>
  `<html><script>{"topicList":${JSON.stringify(topics.map((t) => ({
    id: t.id, vacancyId: t.vacancy, chatId: t.id + 1000, lastState: t.state ?? 'RESPONSE',
    inboxAvailabilityState: t.inbox ?? 'AVAILABLE', conversationMessagesCount: t.count ?? 1,
    hasNewMessages: t.hasNew === true, lastModifiedMillis: t.modified ?? NOW - DAY,
  })))}}</script></html>`;

/** Чат-пустышка: сообщения лежат в массиве, отправка дописывает их, «поле опустело» управляется флагом. */
class FakeChat implements HhChat {
  messages: string[] = [];
  sent: string[] = [];
  clears = true;
  hasInput = true;
  frame: FrameLike;
  constructor() {
    this.frame = {
      locator: (selector: string) => {
        const list = selector === CHAT_MESSAGE_CANDIDATES[0] ? this.messages : [];
        return {
          count: async () => list.length,
          nth: (i: number): ItemLike => ({ innerText: async () => list[i]!, getAttribute: async () => null }),
        };
      },
    };
  }
  async sendText(text: string): Promise<boolean> {
    if (!this.clears) return false;
    this.sent.push(text);
    this.messages.push(text);
    return true;
  }
  async probe(): Promise<ChatProbe> {
    return {
      frameFound: true, frameUrl: 'https://chatik.hh.ru/chat/N',
      messageSelectors: { [CHAT_MESSAGE_CANDIDATES[0]!]: this.messages.length },
      inputSelectors: { textarea: this.hasInput ? 1 : 0 }, sendSelectors: { 'button[type="submit"]': 1 },
    };
  }
}

class FakeSession implements HhSession {
  html = htmlOf([]);
  status: 'ok' | 'auth_required' | 'captcha' = 'ok';
  throwOnOpen: Error | null = null;
  chats = new Map<string, FakeChat>();
  opens: Array<{ allowWrites: boolean }> = [];
  closes: Array<{ keepForHuman: boolean }> = [];
  blocked: string[] = [];
  async openNegotiations(opts: { allowWrites: boolean }): Promise<HhNegotiationsPage> {
    this.opens.push(opts);
    if (this.throwOnOpen !== null) throw this.throwOnOpen;
    return {
      status: async () => this.status,
      html: async () => this.html,
      blockedWrites: () => this.blocked,
      openChat: async (vacancyId: string) => this.chats.get(vacancyId) ?? null,
      close: async (o) => { this.closes.push({ keepForHuman: o?.keepForHuman === true }); },
    };
  }
}

let dir: string;
let dbPath: string;
let dialogs: Dialogs;
let queue: Queue;
let session: FakeSession;
let settings: Settings;
let brainCalls: SecretaryInput[];
let brainText: string | null;
let clock: number;
let sleeps: number[];

function makeDeps(over: Partial<HhInboxDeps> = {}): HhInboxDeps {
  return {
    session, dialogs, queue, settings: () => settings, now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); }, random: () => 0, log: () => {},
    brain: async (input): Promise<SecretaryOutcome> => {
      brainCalls.push(input);
      return {
        actions: brainText === null ? [] : [{ kind: 'text', chatId: 0, text: brainText }],
        intent: 'test', silenced: null, meetingId: null, outcome: 'answered',
      };
    },
    ...over,
  };
}

const withHh = (hh: Partial<Settings['hhInbox']>): void => {
  settings = { hhInbox: { enabled: true, replyEnabled: false, intervalMinutes: 30, maxRepliesPerDay: 20, ...hh } } as Settings;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jaa-hhinbox-'));
  dbPath = join(dir, 'queue.db');
  queue = new Queue(dbPath);
  new BotStore(dbPath); // создаёт таблицы бота рядом с очередью
  dialogs = new Dialogs(dbPath);
  session = new FakeSession();
  brainCalls = [];
  brainText = 'Добрый день! Могу в четверг.';
  clock = NOW;
  sleeps = [];
  withHh({});
});

describe('checkHhInbox: чтение', () => {
  it('считает отклики и события, пишет отчёт и открывает ровно одну вкладку — с блокировкой записи', async () => {
    session.html = htmlOf([
      { id: 1, vacancy: 11, hasNew: true, count: 2 },
      { id: 2, vacancy: 12, state: 'INTERVIEW' },
      { id: 3, vacancy: 13, state: 'DISCARD' },
      { id: 4, vacancy: 14 },
    ]);
    session.blocked = ['POST /chat/notify_chat_opened'];
    const r = await checkHhInbox(makeDeps());
    expect(r).toMatchObject({ outcome: 'ok', topics: 4, newReplies: 1, invites: 1, rejects: 1, repliesSent: 0 });
    expect(r.blockedWrites).toEqual(['POST /chat/notify_chat_opened']);
    expect(session.opens).toEqual([{ allowWrites: false }]);
    expect(lastHhReport(dialogs)).toEqual(r);
    expect(brainCalls).toHaveLength(0);
  });

  it('второй проход без изменений новых событий не даёт', async () => {
    session.html = htmlOf([{ id: 1, vacancy: 11, hasNew: true, count: 2 }]);
    await checkHhInbox(makeDeps());
    const r = await checkHhInbox(makeDeps());
    expect(r).toMatchObject({ newReplies: 0, invites: 0, rejects: 0 });
  });

  it('replyEnabled выключен — разблокированная вкладка не открывается ни при каких новых сообщениях', async () => {
    session.html = htmlOf([{ id: 1, vacancy: 11, hasNew: true, count: 3 }]);
    dialogs.kvSet('hh:chatProbeOkAt', String(clock));
    await checkHhInbox(makeDeps());
    session.html = htmlOf([{ id: 1, vacancy: 11, hasNew: true, count: 5 }]);
    await checkHhInbox(makeDeps());
    expect(session.opens.every((o) => !o.allowWrites)).toBe(true);
    expect(brainCalls).toHaveLength(0);
  });

  it('вход потерян — auth_required, вкладка закрыта', async () => {
    session.status = 'auth_required';
    const r = await checkHhInbox(makeDeps());
    expect(r.outcome).toBe('auth_required');
    expect(session.closes).toEqual([{ keepForHuman: false }]);
  });

  it('капча — captcha, вкладка остаётся человеку', async () => {
    session.status = 'captcha';
    const r = await checkHhInbox(makeDeps());
    expect(r.outcome).toBe('captcha');
    expect(session.closes).toEqual([{ keepForHuman: true }]);
  });

  it('разметка без topicList — error с причиной, база не тронута', async () => {
    session.html = '<html>новая вёрстка</html>';
    const r = await checkHhInbox(makeDeps());
    expect(r.outcome).toBe('error');
    expect(r.error).toContain('topicList');
    expect(dialogs.hhTopic(1)).toBeNull();
  });

  it('профиль занят другим процессом — profile_busy', async () => {
    session.throwOnOpen = new Error('profile is locked');
    const r = await checkHhInbox(makeDeps());
    expect(r).toMatchObject({ outcome: 'profile_busy', error: 'profile is locked' });
    expect(session.closes).toEqual([]);
  });
});

describe('checkHhInbox: ответы', () => {
  const topic = (count: number, over: Partial<TopicSpec> = {}): TopicSpec => ({ id: 5, vacancy: 55, hasNew: true, count, ...over });

  beforeEach(() => {
    withHh({ replyEnabled: true });
    dialogs.kvSet('hh:chatProbeOkAt', String(clock));
    const chat = new FakeChat();
    chat.messages = ['Здравствуйте, откликаюсь на вакансию', 'Добрый день, расскажите об опыте'];
    session.chats.set('55', chat);
  });

  const chat = (): FakeChat => session.chats.get('55')!;

  it('без свежей пробы чата ответов нет и разблокированная вкладка не открывается', async () => {
    dialogs.kvSet('hh:chatProbeOkAt', String(clock - 15 * DAY));
    session.html = htmlOf([topic(2)]);
    const r = await checkHhInbox(makeDeps());
    expect(session.opens).toEqual([{ allowWrites: false }]);
    expect(r.replyIssues[0]).toContain('--probe-chat');
    expect(brainCalls).toHaveLength(0);
  });

  it('вообще без пробы — то же самое', async () => {
    dialogs.kvSet('hh:chatProbeOkAt', '');
    expect(chatProbeFresh(dialogs, clock)).toBe(false);
    session.html = htmlOf([topic(2)]);
    await checkHhInbox(makeDeps());
    expect(session.opens.every((o) => !o.allowWrites)).toBe(true);
  });

  it('первое чтение чата — базовая линия: запоминает сообщения и не отвечает', async () => {
    session.html = htmlOf([topic(2)]);
    const r = await checkHhInbox(makeDeps());
    expect(r.repliesSent).toBe(0);
    expect(brainCalls).toHaveLength(0);
    expect(dialogs.hhTopic(5)!.baselineAt).toBe(clock);
    expect(dialogs.hhSeen(5).size).toBe(2);
    expect(session.opens).toEqual([{ allowWrites: false }, { allowWrites: true }]);
  });

  it('новое сообщение после базовой линии — мозг отвечает, текст уходит в чат, ключи записаны', async () => {
    session.html = htmlOf([topic(2)]);
    await checkHhInbox(makeDeps());
    chat().messages.push('Когда можете созвониться?');
    session.html = htmlOf([topic(3)]);
    clock += 3_600_000;
    const r = await checkHhInbox(makeDeps());
    expect(brainCalls).toHaveLength(1);
    expect(brainCalls[0]).toMatchObject({ channel: 'hh', text: 'Когда можете созвониться?', hh: { topicId: 5 } });
    expect(chat().sent).toEqual(['Добрый день! Могу в четверг.']);
    expect(r.repliesSent).toBe(1);
    expect(dialogs.hhBotReplies(clock - DAY, 5)).toBe(1);
    expect(dialogs.hhSeen(5).size).toBeGreaterThanOrEqual(4);
  });

  it('то же сообщение второй раз не получает ответа', async () => {
    session.html = htmlOf([topic(2)]);
    await checkHhInbox(makeDeps());
    chat().messages.push('Когда можете созвониться?');
    session.html = htmlOf([topic(3)]);
    await checkHhInbox(makeDeps());
    // hh снова показывает «есть новые», но в чате ничего нового нет
    session.html = htmlOf([topic(4)]);
    clock += 3_600_000;
    const r = await checkHhInbox(makeDeps());
    expect(brainCalls).toHaveLength(1);
    expect(r.repliesSent).toBe(0);
  });

  it('отправка не опустошила поле — прогон останавливается, повторной отправки нет', async () => {
    session.html = htmlOf([topic(2)]);
    await checkHhInbox(makeDeps());
    chat().messages.push('Вопрос');
    chat().clears = false;
    session.html = htmlOf([topic(3)]);
    const r = await checkHhInbox(makeDeps());
    expect(r.replyIssues).toContain('field_not_cleared:5');
    expect(r.repliesSent).toBe(0);
    // ключ уже записан до отправки: на следующем проходе тот же вопрос повторно не уйдёт
    chat().clears = true;
    session.html = htmlOf([topic(4)]);
    await checkHhInbox(makeDeps());
    expect(brainCalls).toHaveLength(1);
  });

  it('чат не читается (ноль сообщений) — пометка chat_unreadable, мозг не зовут', async () => {
    chat().messages = [];
    session.html = htmlOf([topic(2)]);
    const r = await checkHhInbox(makeDeps());
    expect(r.replyIssues).toContain('chat_unreadable:5');
    expect(brainCalls).toHaveLength(0);
  });

  it('чат не нашёлся на странице — chat_not_found', async () => {
    session.chats.clear();
    session.html = htmlOf([topic(2)]);
    const r = await checkHhInbox(makeDeps());
    expect(r.replyIssues).toContain('chat_not_found:5');
  });

  it('работодатель закрыл чат (inboxState не AVAILABLE) — не открываем', async () => {
    session.html = htmlOf([topic(2, { inbox: 'DISABLED_BY_EMPLOYER' })]);
    await checkHhInbox(makeDeps());
    expect(session.opens).toEqual([{ allowWrites: false }]);
  });

  it('не больше двух ответов в чат за сутки', async () => {
    session.html = htmlOf([topic(2)]);
    await checkHhInbox(makeDeps());
    for (let n = 3; n <= 5; n += 1) {
      chat().messages.push(`Вопрос ${n}`);
      session.html = htmlOf([topic(n)]);
      clock += 60_000;
      await checkHhInbox(makeDeps());
    }
    expect(brainCalls).toHaveLength(2);
    expect(dialogs.hhBotReplies(clock - DAY, 5)).toBe(2);
  });

  it('дневной лимит maxRepliesPerDay', async () => {
    withHh({ replyEnabled: true, maxRepliesPerDay: 1 });
    session.chats.set('66', Object.assign(new FakeChat(), { messages: ['Добрый день', 'Ответьте'] }));
    session.html = htmlOf([topic(2), { id: 6, vacancy: 66, hasNew: true, count: 2 }]);
    await checkHhInbox(makeDeps());
    chat().messages.push('Новое');
    session.chats.get('66')!.messages.push('Новое');
    session.html = htmlOf([topic(3), { id: 6, vacancy: 66, hasNew: true, count: 3 }]);
    clock += 60_000;
    const r = await checkHhInbox(makeDeps());
    expect(r.repliesSent).toBe(1);
    expect(r.replyIssues).toContain('дневной лимит ответов исчерпан');
  });

  it('между чатами пауза из диапазона 30–90 с', async () => {
    session.chats.set('66', Object.assign(new FakeChat(), { messages: ['Добрый день', 'Ответьте'] }));
    session.html = htmlOf([topic(2), { id: 6, vacancy: 66, hasNew: true, count: 2 }]);
    await checkHhInbox(makeDeps());
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(30_000);
    expect(sleeps[0]).toBeLessThanOrEqual(90_000);
  });

  it('просьба остановиться прерывает проход', async () => {
    session.html = htmlOf([topic(2)]);
    const r = await checkHhInbox(makeDeps({ stopRequested: () => true }));
    expect(r.replyIssues).toContain('stopped');
    expect(session.opens).toEqual([{ allowWrites: false }]);
  });

  it('нет мозга — проход только читает', async () => {
    session.html = htmlOf([topic(2)]);
    await checkHhInbox(makeDeps({ brain: undefined }));
    expect(session.opens).toEqual([{ allowWrites: false }]);
  });

  it('ошибка внутри чата не роняет проход и не ломает отчёт', async () => {
    session.html = htmlOf([topic(2)]);
    session.chats.get('55')!.frame = { locator: () => { throw new Error('frame detached'); } };
    const r = await checkHhInbox(makeDeps());
    expect(r.outcome).toBe('ok');
    expect(r.replyIssues.some((x) => x.startsWith('error:5:'))).toBe(true);
  });
});

describe('probeHhInbox', () => {
  beforeEach(() => {
    session.html = htmlOf([{ id: 5, vacancy: 55, count: 2, modified: NOW }]);
    const chat = new FakeChat();
    chat.messages = ['Здравствуйте', 'Добрый день'];
    session.chats.set('55', chat);
  });

  const files = (): string[] => readdirSync(join(dir, 'debug'));

  it('режим read: блокировка записи включена, пробу чата не засчитывает', async () => {
    const r = await probeHhInbox(makeDeps(), 'read', join(dir, 'debug'));
    expect(session.opens).toEqual([{ allowWrites: false }]);
    expect(r.chatProbeOk).toBe(false);
    expect(dialogs.kvGet('hh:chatProbeOkAt')).toBeNull();
  });

  it('режим chat: сообщения и поле ввода найдены — проба пройдена и запомнена', async () => {
    const r = await probeHhInbox(makeDeps(), 'chat', join(dir, 'debug'));
    expect(session.opens).toEqual([{ allowWrites: true }]);
    expect(r).toMatchObject({ outcome: 'ok', topicsSeen: 1, messagesFound: 2, chatProbeOk: true });
    expect(dialogs.kvGet('hh:chatProbeOkAt')).toBe(String(clock));
    expect(chatProbeFresh(dialogs, clock + DAY)).toBe(true);
    expect(chatProbeFresh(dialogs, clock + 15 * DAY)).toBe(false);
  });

  it('нет поля ввода — проба не пройдена', async () => {
    session.chats.get('55')!.hasInput = false;
    const r = await probeHhInbox(makeDeps(), 'chat', join(dir, 'debug'));
    expect(r.chatProbeOk).toBe(false);
    expect(dialogs.kvGet('hh:chatProbeOkAt')).toBeNull();
  });

  it('ничего не отправляет и не печатает', async () => {
    await probeHhInbox(makeDeps(), 'chat', join(dir, 'debug'));
    expect(session.chats.get('55')!.sent).toEqual([]);
  });

  it('отчёт на диске — счётчики и адрес фрейма без цифр, без текстов переписки', async () => {
    await probeHhInbox(makeDeps(), 'chat', join(dir, 'debug'));
    const [name] = files();
    expect(name).toMatch(/^inbox-probe-.*\.json$/);
    const text = readFileSync(join(dir, 'debug', name!), 'utf8');
    expect(text).toContain('chatik.hh.ru/chat/N');
    expect(text).not.toContain('Добрый день');
    expect(text).not.toContain('Здравствуйте');
  });

  it('нет откликов с сообщениями — no_topics', async () => {
    session.html = htmlOf([{ id: 5, vacancy: 55, count: 0 }]);
    const r = await probeHhInbox(makeDeps(), 'chat', join(dir, 'debug'));
    expect(r.outcome).toBe('no_topics');
    expect(r.chatProbeOk).toBe(false);
  });

  it('капча — вкладка остаётся человеку', async () => {
    session.status = 'captcha';
    const r = await probeHhInbox(makeDeps(), 'chat', join(dir, 'debug'));
    expect(r.outcome).toBe('captcha');
    expect(session.closes).toEqual([{ keepForHuman: true }]);
  });
});
