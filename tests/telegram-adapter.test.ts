import { describe, it, expect } from 'vitest';
import { TelegramAdapter } from '../src/adapters/telegram.js';
import type { TgChat, TgMessage, TgReader, TgSender } from '../src/telegram/types.js';
import { normalizeVacancy } from '../src/core/vacancy.js';
import type { TgChatSetting } from '../src/core/settings.js';
import { errors } from 'telegram';

const CHAT: TgChatSetting = { id: '-1001', title: 'Работа в ИТ', username: 'workayte', kind: 'channel', enabled: true };
const VACANCY_TEXT = 'Бизнес-аналитик в банк\nОбязанности: процессы. Требования: BPMN, опыт от 1 года. ' + 'Описание задач. '.repeat(15) + '\nОтклик: @hr_person';
const NOW = new Date('2026-09-19T12:00:00Z');

function msg(id: number, text = VACANCY_TEXT, daysAgo = 1): TgMessage {
  return { id, date: new Date(NOW.getTime() - daysAgo * 86_400_000), text, urls: [] };
}

function mkReader(byChat: Record<string, TgMessage[] | Error>, calls: Array<{ chat: string; minId: number }> = []): TgReader {
  return {
    async dialogs() { return []; },
    async resolveChat() { throw new Error('не нужен'); },
    async messages(chat: TgChat, opts) {
      calls.push({ chat: chat.id, minId: opts.minId });
      const v = byChat[chat.id];
      if (v instanceof Error) throw v;
      return (v ?? []).filter((m) => m.id > opts.minId && m.date >= opts.since).slice(0, opts.limit);
    },
  };
}

function mkAdapter(reader: TgReader | { error: string }, chats: TgChatSetting[] = [CHAT]) {
  const cursors = new Map<string, number>();
  const slept: number[] = [];
  const adapter = new TelegramAdapter({
    reader: async () => reader,
    queue: { getTgCursor: (id) => cursors.get(id) ?? 0, setTgCursor: (id, last) => cursors.set(id, Math.max(cursors.get(id) ?? 0, last)) },
    chats: () => chats,
    firstReadDays: () => 14,
    titleWords: () => ['аналитик'],
    sleep: async (ms) => { slept.push(ms); },
    now: () => NOW.getTime(),
    random: () => 0,
  });
  return { adapter, cursors, slept };
}

describe('TelegramAdapter.search', () => {
  it('бесфразовый: второй вызов за прогон (skip > 0) ничего не читает', async () => {
    const calls: Array<{ chat: string; minId: number }> = [];
    const { adapter } = mkAdapter(mkReader({ '-1001': [msg(10)] }, calls));
    expect(adapter.queryless).toBe(true);
    expect(await adapter.search({ query: '', skip: 0 })).toHaveLength(1);
    expect(await adapter.search({ query: '', skip: 1 })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('первое чтение — от 0 на 14 дней, дальше — от курсора', async () => {
    const calls: Array<{ chat: string; minId: number }> = [];
    const { adapter, cursors } = mkAdapter(mkReader({ '-1001': [msg(12), msg(11, VACANCY_TEXT, 20)] }, calls));
    const first = await adapter.search({ query: '', skip: 0 });
    expect(first.map((v) => v.sourceId)).toEqual(['-1001:12']); // 20 дней назад — за глубиной
    expect(cursors.get('-1001')).toBe(12);
    await adapter.search({ query: '', skip: 0 });
    expect(calls.at(-1)!.minId).toBe(12);
  });

  it('счётчики: не вакансия, нет контакта', async () => {
    const noContact = VACANCY_TEXT.replace('Отклик: @hr_person', 'Отклик на сайте');
    const { adapter } = mkAdapter(mkReader({ '-1001': [msg(1, 'Короткий пост'), msg(2, noContact), msg(3)] }));
    const out = await adapter.search({ query: '', skip: 0 });
    expect(out).toHaveLength(1);
    expect(adapter.lastSearchStats).toMatchObject({ read: 3, notVacancy: 1, noContact: 1 });
  });

  it('выключенный чат не читается', async () => {
    const calls: Array<{ chat: string; minId: number }> = [];
    const { adapter } = mkAdapter(mkReader({ '-1001': [msg(1)] }, calls), [{ ...CHAT, enabled: false }]);
    expect(await adapter.search({ query: '', skip: 0 })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('недоступный чат пропускается и называется, остальные читаются', async () => {
    const other: TgChatSetting = { ...CHAT, id: '-1002', title: 'Второй' };
    const gone = new errors.RPCError('CHANNEL_PRIVATE', {} as never, 400);
    const { adapter } = mkAdapter(mkReader({ '-1001': gone, '-1002': [msg(5)] }), [CHAT, other]);
    const out = await adapter.search({ query: '', skip: 0 });
    expect(out).toHaveLength(1);
    expect(adapter.lastSearchStats!.skippedChats).toEqual([{ title: 'Работа в ИТ', why: 'чат недоступен (закрыт или тебя удалили)' }]);
  });

  it('FloodWait до 60 с — ждём и повторяем; дольше — чат пропускается', async () => {
    let n = 0;
    const flaky: TgReader = {
      ...mkReader({}),
      async messages() {
        n++;
        if (n === 1) throw new errors.FloodWaitError({ request: {} as never, capture: 30 });
        return [msg(7)];
      },
    };
    const { adapter, slept } = mkAdapter(flaky);
    expect(await adapter.search({ query: '', skip: 0 })).toHaveLength(1);
    expect(slept).toContain(30_000);

    const long: TgReader = { ...mkReader({}), async messages() { throw new errors.FloodWaitError({ request: {} as never, capture: 600 }); } };
    const b = mkAdapter(long);
    expect(await b.adapter.search({ query: '', skip: 0 })).toEqual([]);
    expect(b.adapter.lastSearchStats!.skippedChats[0]!.why).toMatch(/600/);
  });

  it('Telegram не подключён — ошибка с причиной (конвейер запишет её в отчёт)', async () => {
    const { adapter } = mkAdapter({ error: 'VPN выключен, Telegram пропущен' });
    await expect(adapter.search({ query: '', skip: 0 })).rejects.toThrow('VPN выключен');
  });

  it('между чатами пауза 1–2 с', async () => {
    const other: TgChatSetting = { ...CHAT, id: '-1002', title: 'Второй' };
    const { adapter, slept } = mkAdapter(mkReader({ '-1001': [], '-1002': [] }), [CHAT, other]);
    await adapter.search({ query: '', skip: 0 });
    expect(slept).toEqual([1000]);
  });
});

describe('TelegramAdapter.apply', () => {
  const V = normalizeVacancy({
    source: 'tg', sourceId: '-1001:7', title: 'Системный аналитик', company: '', url: 'https://t.me/workayte/7',
    description: 'd', geo: '', postedAt: '2026-09-19T00:00:00Z', contact: 'hr_person', channel: 'Работа в ИТ',
  });

  function mkSender(over: Partial<TgSender> = {}) {
    const log: string[] = [];
    const sender: TgSender = {
      async resolvePeer(u) { log.push(`resolve ${u}`); return { kind: 'user', username: u }; },
      async sendText(u, t) { log.push(`text ${u} ${t.slice(0, 10)}`); },
      async sendFile(u, p) { log.push(`file ${u} ${p}`); },
      ...over,
    };
    return { sender, log };
  }
  function adapterWith(sender: TgSender | { error: string }, pdf: string | null = 'C:/cv.pdf') {
    return new TelegramAdapter({
      reader: async () => ({ error: 'не нужен' }), queue: { getTgCursor: () => 0, setTgCursor: () => {} },
      chats: () => [], firstReadDays: () => 14, titleWords: () => [],
      sender: async () => sender, resumePdf: () => pdf, sleep: async () => {},
    });
  }

  it('человек — текст, затем PDF специальности', async () => {
    const { sender, log } = mkSender();
    expect(await adapterWith(sender).apply(V, 'Здравствуйте! …', { specialty: 'ba' })).toEqual({ status: 'sent' });
    expect(log).toEqual(['resolve hr_person', 'text hr_person Здравствуй', 'file hr_person C:/cv.pdf']);
  });

  it.each(['bot', 'channel', 'group'] as const)('%s вместо человека — failed, ничего не отправлено', async (kind) => {
    const { sender, log } = mkSender({ async resolvePeer(u) { return { kind, username: u }; } });
    const r = await adapterWith(sender).apply(V, 'x', { specialty: 'ba' });
    expect(r).toMatchObject({ status: 'failed' });
    expect(r.status === 'failed' && r.reason).toMatch(/вручную/);
    expect(log.some((l) => l.startsWith('text'))).toBe(false);
  });

  it('текст ушёл, файл нет — sent с предупреждением (текст не вернуть)', async () => {
    const { sender } = mkSender({ async sendFile() { throw new Error('upload failed'); } });
    const r = await adapterWith(sender).apply(V, 'x', { specialty: 'ba' });
    expect(r).toMatchObject({ status: 'sent' });
    expect(r.status === 'sent' && r.warning).toMatch(/резюме не приложилось/);
  });

  it('нет PDF у специальности — только текст, с предупреждением', async () => {
    const { sender, log } = mkSender();
    const r = await adapterWith(sender, null).apply(V, 'x', { specialty: 'ba' });
    expect(r.status === 'sent' && r.warning).toMatch(/PDF/);
    expect(log.some((l) => l.startsWith('file'))).toBe(false);
  });

  it.each([
    ['PEER_FLOOD', 'account_limited'],
    ['USER_PRIVACY_RESTRICTED', 'failed'],
    ['USERNAME_NOT_OCCUPIED', 'failed'],
    ['AUTH_KEY_UNREGISTERED', 'auth_required'],
  ])('%s → %s', async (code, status) => {
    const { sender } = mkSender({ async sendText() { throw new errors.RPCError(code, {} as never, 400); } });
    expect((await adapterWith(sender).apply(V, 'x', { specialty: 'ba' })).status).toBe(status);
  });

  it('FloodWait до 60 с — ждём и повторяем; дольше — account_limited', async () => {
    let n = 0;
    const { sender } = mkSender({ async sendText() { if (n++ === 0) throw new errors.FloodWaitError({ request: {} as never, capture: 20 }); } });
    expect((await adapterWith(sender).apply(V, 'x', { specialty: 'ba' })).status).toBe('sent');
    const b = mkSender({ async sendText() { throw new errors.FloodWaitError({ request: {} as never, capture: 3600 }); } });
    expect((await adapterWith(b.sender).apply(V, 'x', { specialty: 'ba' })).status).toBe('account_limited');
  });

  it('Telegram не подключён — auth_required с причиной-ошибкой не путается: failed не ставится', async () => {
    expect((await adapterWith({ error: 'Telegram не подключён' }).apply(V, 'x', { specialty: 'ba' })).status).toBe('auth_required');
  });

  it('вакансия без контакта — failed «контакт не найден»', async () => {
    const { sender } = mkSender();
    const r = await adapterWith(sender).apply({ ...V, contact: null }, 'x', { specialty: 'ba' });
    expect(r).toMatchObject({ status: 'failed' });
  });
});
