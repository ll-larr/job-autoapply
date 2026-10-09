import { describe, it, expect } from 'vitest';
import { runBot, type RunBotOptions } from '../src/bot/run.js';
import { BotApi } from '../src/bot/api.js';
import { DEFAULT_CALENDAR, type CalendarSettings } from '../src/core/settings.js';
import { reminderPing } from '../src/bot/ping.js';
import { makeHarness, seedSent, T0 } from './support/secretary.js';

interface Call { method: string; raw: string }
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function setup(over: { cal?: Partial<CalendarSettings> | null; fail?: Record<string, number>; rounds?: number } = {}) {
  const h = makeHarness();
  const calls: Call[] = [];
  const logs: string[] = [];
  const fail = { ...over.fail };
  const fetchImpl: typeof fetch = async (url, init) => {
    const method = String(url).split('/').pop() ?? '';
    const raw = init?.body === undefined ? '' : Buffer.from(init.body as Uint8Array | string).toString('utf8');
    calls.push({ method, raw });
    if (method === 'getWebhookInfo') return new Response(JSON.stringify({ ok: true, result: { url: '' } }));
    if (method === 'getUpdates') return new Response(JSON.stringify({ ok: true, result: [] }));
    if ((fail[method] ?? 0) > 0) {
      fail[method] = fail[method]! - 1;
      return new Response(JSON.stringify({ ok: false, description: 'refused' }), { status: 400 });
    }
    return new Response(JSON.stringify({ ok: true, result: method === 'sendMediaGroup' ? [{}, {}] : { message_id: 1 } }));
  };
  const api = new BotApi('T', { fetchImpl });
  const cal: CalendarSettings | null = over.cal === undefined || over.cal === null ? null : { ...DEFAULT_CALENDAR, ...over.cal };
  const opts: RunBotOptions = {
    api, store: h.store, deps: h.deps, ownerChatId: 999, log: (l) => logs.push(l),
    stopAfterIdleRounds: over.rounds ?? 1, sleep: async () => {},
    ...(cal === null ? {} : { calendar: () => cal }),
  };
  const meeting = (extra: Partial<Parameters<typeof h.store.saveMeeting>[0]> = {}) => h.store.saveMeeting({
    chatId: -77, username: 'rec', queueId: null, meetAt: T0 + DAY, raw: 'давай завтра', createdAt: T0,
    channel: 'business', peerChatId: 77, ...extra,
  });
  const by = (method: string): Call[] => calls.filter((c) => c.method === method);
  return { h, calls, logs, by, meeting, run: () => runBot(opts), cal };
}

describe('пинг о собеседовании с календарём', () => {
  it('вакансия и .ics приходят одним альбомом с подписью-пингом', async () => {
    const t = setup({ cal: {} });
    const queueId = seedSent(t.h);
    t.meeting({ queueId });
    await t.run();
    expect(t.by('sendMediaGroup')).toHaveLength(1);
    const body = t.by('sendMediaGroup')[0]!.raw;
    expect(body).toContain(`filename="vacancy-${queueId}.txt"`);
    expect(body).toMatch(/filename="meeting-\d+\.ics"/);
    expect(body).toContain('Рекрутёр: @rec (личка @аккаунта)');
    expect(body).toContain('"caption"');
    expect(t.by('sendDocument')).toHaveLength(0);
    expect(t.h.store.pendingMeetings()).toEqual([]);
  });

  it('вакансии нет — .ics одним документом, подпись — сам пинг', async () => {
    const t = setup({ cal: {} });
    t.meeting();
    await t.run();
    expect(t.by('sendMediaGroup')).toHaveLength(0);
    const doc = t.by('sendDocument')[0]!.raw;
    expect(doc).toMatch(/filename="meeting-\d+\.ics"/);
    expect(doc).toContain('Рекрутёр: @rec (личка @аккаунта)');
    expect(doc).toContain('BEGIN:VCALENDAR');
  });

  it('альбом не вышел — прежний путь: документ с вакансией и подписью, договорённость не потеряна', async () => {
    const t = setup({ cal: {}, fail: { sendMediaGroup: 1 } });
    const queueId = seedSent(t.h);
    t.meeting({ queueId });
    await t.run();
    expect(t.by('sendDocument')).toHaveLength(1);
    expect(t.by('sendDocument')[0]!.raw).toContain(`filename="vacancy-${queueId}.txt"`);
    expect(t.logs.some((l) => l.includes('альбом'))).toBe(true);
    expect(t.h.store.pendingMeetings()).toEqual([]);
  });

  it('.ics не ушёл и без вакансии — обычное сообщение', async () => {
    const t = setup({ cal: {}, fail: { sendDocument: 1 } });
    t.meeting();
    await t.run();
    expect(t.by('sendMessage')).toHaveLength(1);
    expect(t.h.store.pendingMeetings()).toEqual([]);
  });

  it('календарь не передан или icsInPing выключен — пинги как раньше, без .ics', async () => {
    for (const cal of [undefined, { icsInPing: false }] as const) {
      const t = setup({ cal });
      const queueId = seedSent(t.h);
      t.meeting({ queueId });
      await t.run();
      expect(t.by('sendMediaGroup')).toHaveLength(0);
      expect(t.by('sendDocument')).toHaveLength(1);
      expect(t.by('sendDocument')[0]!.raw).not.toContain('.ics');
    }
  });
});

describe('напоминания', () => {
  const due = (t: ReturnType<typeof setup>, over: Parameters<typeof t.meeting>[0] = {}) => {
    const id = t.meeting({ meetAt: T0 + 25 * MIN, createdAt: T0 - DAY, ...over });
    t.h.store.markMeetingNotified(id, T0 - DAY);
    return id;
  };

  it('за 30 минут до встречи владельцу приходит напоминание — один раз', async () => {
    const t = setup({ cal: {}, rounds: 2 });
    due(t);
    await t.run();
    const sent = t.by('sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.raw).toContain('Через 25 мин собеседование');
    expect(sent[0]!.raw).toContain('Рекрутёр: @rec (личка @аккаунта)');
    expect(sent[0]!.raw).not.toContain('Он написал');
  });

  it('встречу записали только что — напоминание не второе подряд, запись помечается без отправки', async () => {
    const t = setup({ cal: {} });
    const id = due(t, { createdAt: T0 - 5 * MIN });
    await t.run();
    expect(t.by('sendMessage')).toHaveLength(0);
    expect(t.h.store.meetingById(id)?.remindedAt).toBe(T0 - 5 * MIN);
  });

  it('далёкая, прошедшая, перенесённая встречи и выключенный тумблер — тишина', async () => {
    const far = setup({ cal: {} });
    due(far, { meetAt: T0 + 3 * 60 * MIN });
    await far.run();
    expect(far.by('sendMessage')).toHaveLength(0);

    const past = setup({ cal: {} });
    due(past, { meetAt: T0 - MIN });
    await past.run();
    expect(past.by('sendMessage')).toHaveLength(0);

    const moved = setup({ cal: {} });
    moved.h.store.supersedeMeeting(due(moved), T0);
    await moved.run();
    expect(moved.by('sendMessage')).toHaveLength(0);

    const off = setup({ cal: { remindEnabled: false } });
    due(off);
    await off.run();
    expect(off.by('sendMessage')).toHaveLength(0);

    const none = setup({ cal: undefined });
    due(none);
    await none.run();
    expect(none.by('sendMessage')).toHaveLength(0);
  });

  it('сбой отправки — повтор на следующем круге', async () => {
    const t = setup({ cal: {}, fail: { sendMessage: 1 }, rounds: 2 });
    const id = due(t);
    await t.run();
    expect(t.by('sendMessage')).toHaveLength(2);
    expect(t.h.store.meetingById(id)?.remindedAt).not.toBeNull();
    expect(t.logs.some((l) => l.includes('напоминание'))).toBe(true);
  });

  it('текст напоминания: время, рекрутёр, вакансия; слов рекрутёра нет', () => {
    const t = setup({ cal: {} });
    const id = due(t);
    const text = reminderPing(t.h.store.meetingById(id)!, null, T0, { account: 'HIRE_agent' });
    expect(text.split('\n')[0]).toMatch(/^Через 25 мин собеседование: /);
    expect(text).toContain('Рекрутёр: @rec (личка @HIRE_agent)');
    expect(text).toContain('вакансию он не присылал');
    expect(text).not.toContain('давай завтра');
  });
});
