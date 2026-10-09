import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { errors } from 'telegram';
import {
  FollowupStore, followupTemplate, followupTextProblem, generateFollowupText, prepareFollowups, runFollowups,
  type RunFollowupsDeps,
} from '../src/core/followups.js';
import { Dialogs } from '../src/core/dialogs.js';
import { BotStore, businessKey } from '../src/bot/state.js';
import { Queue } from '../src/core/queue.js';
import { seedSettings, type Settings } from '../src/core/settings.js';
import { normalizeVacancy } from '../src/core/vacancy.js';
import type { TgHistory, TgPeer, TgSender } from '../src/telegram/types.js';

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 9, 12, 0).getTime();
const THROTTLE = { maxPerDay: 40, minDelayMs: 60_000, maxDelayMs: 180_000 };

let path: string;
let queue: Queue;
let store: FollowupStore;
let dialogs: Dialogs;
let bot: BotStore;
let raw: DatabaseSync;
let settings: Settings;
let seq = 0;

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), 'jaa-fu-')), 'queue.db');
  queue = new Queue(path);
  store = new FollowupStore(path);
  dialogs = new Dialogs(path);
  bot = new BotStore(path);
  raw = new DatabaseSync(path);
  settings = seedSettings(undefined, null);
  settings.followups = { enabled: true, afterDays: 4, maxAgeDays: 14 };
});

/** Наше первое сообщение контакту: строка очереди tg/sent, отправлена `daysAgo` дней назад. */
function sentTo(contact: string, daysAgo: number, title = 'Системный аналитик', source = 'tg'): number {
  seq += 1;
  const v = normalizeVacancy({
    source, sourceId: `f${seq}`, title, company: '', url: `https://t.me/c/${seq}`, description: 'd', geo: '',
    postedAt: new Date(NOW), contact,
  });
  queue.insertPending(v, 10, [], 'письмо', 'dm');
  const id = queue.idOf(source, `f${seq}`)!;
  queue.approve(id);
  queue.markSent(id);
  raw.prepare('UPDATE applications SET sent_at = ? WHERE id = ?').run(NOW - daysAgo * DAY, id);
  return id;
}

describe('кому пора дожимать', () => {
  const names = () => store.candidates(NOW, settings.followups).map((c) => c.contact);

  it('молчит больше afterDays и не дольше maxAgeDays; самые старые первыми', () => {
    sentTo('fresh', 2);
    sentTo('ok2', 6);
    sentTo('ok1', 10);
    sentTo('stale', 20);
    expect(names()).toEqual(['ok1', 'ok2']);
  });

  it('только Telegram-отправленные: hh, не отправленные и без контакта не берутся', () => {
    sentTo('onhh', 6, 'x', 'hh');
    seq += 1;
    queue.insertPending(normalizeVacancy({
      source: 'tg', sourceId: `p${seq}`, title: 't', company: '', url: 'u', description: 'd', geo: '', postedAt: new Date(NOW), contact: 'pend',
    }), 1, [], '', 'dm');
    expect(names()).toEqual([]);
  });

  it('ответ после отправки, встреча, новая строка на этого контакта и уже существующий дожим исключают', () => {
    const a = sentTo('replied', 6);
    const b = sentTo('meeting', 6);
    sentTo('queued', 6);
    seq += 1;
    queue.insertPending(normalizeVacancy({
      source: 'tg', sourceId: `n${seq}`, title: 'новая', company: '', url: 'u', description: 'd', geo: '', postedAt: new Date(NOW), contact: 'queued',
    }), 1, [], 'письмо', 'dm');
    const c = sentTo('dup', 6);
    sentTo('plain', 6);
    dialogs.incoming({ channel: 'business', peerKey: '1', username: 'replied' }, NOW - 5 * DAY, a);
    bot.saveMeeting({ chatId: businessKey(2), username: 'meeting', queueId: b, meetAt: NOW + DAY, raw: '', createdAt: NOW - 3 * DAY });
    store.insertDraft(c, 'dup', 'x'.repeat(50), 'template', NOW);
    expect(names()).toEqual(['plain']);
  });

  it('ответ ДО нашей отправки дожим не отменяет', () => {
    const a = sentTo('early', 6);
    dialogs.incoming({ channel: 'business', peerKey: '1', username: 'early' }, NOW - 8 * DAY, a);
    expect(names()).toEqual(['early']);
  });

  it('по контакту берётся последняя отправка, а не первая', () => {
    sentTo('twice', 12, 'Старая');
    sentTo('twice', 6, 'Свежая');
    const [c] = store.candidates(NOW, settings.followups);
    expect(c).toMatchObject({ contact: 'twice', title: 'Свежая' });
  });
});

describe('черновики', () => {
  it('один дожим на контакт навсегда; текст правится только у черновика; отмена тоже', () => {
    const q = sentTo('u', 6);
    const id = store.insertDraft(q, 'U', 'а'.repeat(50), 'model', NOW)!;
    expect(store.insertDraft(q, 'u', 'б'.repeat(50), 'model', NOW)).toBeNull();
    expect(store.setText(id, 'новый текст дожима, достаточно длинный для проверки')).toBe(true);
    expect(store.byId(id)).toMatchObject({ contact: 'u', textMode: 'manual', status: 'draft' });
    expect(store.cancel(id, 'вручную')).toBe(true);
    expect(store.setText(id, 'ещё одна правка текста')).toBe(false);
    expect(store.cancel(id, 'снова')).toBe(false);
    expect(store.byId(id)).toMatchObject({ status: 'cancelled', reason: 'вручную' });
  });

  it('list добавляет название вакансии и время первой отправки', () => {
    const q = sentTo('u', 6, 'Аналитик ЖКХ');
    store.insertDraft(q, 'u', 'а'.repeat(50), 'template', NOW);
    expect(store.list()[0]).toMatchObject({ title: 'Аналитик ЖКХ', firstSentAt: NOW - 6 * DAY });
  });
});

describe('текст дожима', () => {
  it('проверка: длина, ссылки, числа вне названия, выдуманные навыки, смесь алфавитов', () => {
    const ok = 'Привет! Напоминаю про вакансию «Аналитик». Если интересно, пришлю резюме или запишу на собеседование.';
    expect(followupTextProblem(ok, 'Аналитик')).toBeNull();
    expect(followupTextProblem('коротко', 'А')).toMatch(/короче/);
    expect(followupTextProblem(`${ok} ${'а'.repeat(400)}`, 'А')).toMatch(/длиннее/);
    expect(followupTextProblem(`${ok} https://t.me/x`, 'А')).toMatch(/ссылка/);
    expect(followupTextProblem(`${ok} Это 3 года опыта.`, 'Аналитик')).toMatch(/число/);
    expect(followupTextProblem(`${ok} Это 1С.`, 'Аналитик 1С')).toBeNull();
    expect(followupTextProblem(`${ok} Знает оконные функции.`, 'А')).toMatch(/навык/);
    expect(followupTextProblem(`${ok} Работает в Figма.`, 'А')).toMatch(/латиницы/);
  });

  it('шаблон сам проходит проверку', () => {
    expect(followupTextProblem(followupTemplate('Бизнес-аналитик (ЖКХ)'), 'Бизнес-аналитик (ЖКХ)')).toBeNull();
    expect(followupTemplate('X')).not.toContain('—');
  });

  it('модель отвечает хорошо — mode model; плохо или молчит — шаблон', async () => {
    process.env['OPENROUTER_API_KEY'] = 'k';
    const reply = (text: string) => async () => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
    const good = 'Привет! Напоминаю про вакансию «Аналитик». Если интересно, пришлю резюме или запишу на собеседование.';
    expect(await generateFollowupText('Аналитик', 5, { models: ['m'], attemptsPerModel: 1, fetchImpl: reply(good) }))
      .toEqual({ text: good, mode: 'model' });
    const bad = await generateFollowupText('Аналитик', 5, { models: ['m'], attemptsPerModel: 1, fetchImpl: reply('Привет, 99 раз!') });
    expect(bad).toEqual({ text: followupTemplate('Аналитик'), mode: 'template' });
    const down = await generateFollowupText('Аналитик', 5, { models: ['m'], attemptsPerModel: 1, fetchImpl: async () => { throw new Error('net'); } });
    expect(down.mode).toBe('template');
  });

  it('prepareFollowups: черновики всем, кому пора, один раз', async () => {
    sentTo('a', 6, 'Аналитик');
    sentTo('b', 7, 'Тестировщик');
    sentTo('young', 1);
    let calls = 0;
    const deps = {
      store, settings: () => settings, now: () => NOW,
      generate: async (title: string, days: number) => { calls += 1; return { text: `${'т'.repeat(45)} ${title} ${days}`, mode: 'model' as const }; },
    };
    expect(await prepareFollowups(deps)).toEqual({ created: 2, fromModel: 2, fromTemplate: 0 });
    expect(await prepareFollowups(deps)).toEqual({ created: 0, fromModel: 0, fromTemplate: 0 });
    expect(calls).toBe(2);
    expect(store.drafts().map((d) => d.contact)).toEqual(['b', 'a']);
  });
});

describe('отправка дожимов', () => {
  interface World {
    deps: RunFollowupsDeps;
    sent: Array<{ to: string; text: string }>;
    sleeps: number[];
    peers: Record<string, TgPeer['kind']>;
    sendError: Error[];
    historyBy: Record<string, { count: number; firstAt: number | null; peerId: number | null } | Error>;
    stop: { on: boolean };
    sentToday: { n: number };
  }

  function world(over: Partial<RunFollowupsDeps> = {}): World {
    const w: World = {
      sent: [], sleeps: [], peers: {}, sendError: [], historyBy: {}, stop: { on: false }, sentToday: { n: 0 },
      deps: undefined as unknown as RunFollowupsDeps,
    };
    const sender: TgSender = {
      resolvePeer: async (u) => ({ kind: w.peers[u] ?? 'user', username: u }),
      sendText: async (u, text) => {
        const err = w.sendError.shift();
        if (err !== undefined) throw err;
        w.sent.push({ to: u, text });
      },
      sendFile: async () => {},
    };
    const history: TgHistory = {
      incomingSince: async (u) => {
        const h = w.historyBy[u] ?? { count: 0, firstAt: null, peerId: 500 };
        if (h instanceof Error) throw h;
        return h;
      },
    };
    w.deps = {
      store, queue: { countSentSince: () => w.sentToday.n }, settings: () => settings, throttle: THROTTLE,
      sender: async () => sender, history: async () => history, dialogs, stopRequested: () => w.stop.on,
      now: () => NOW, sleep: async (ms) => { w.sleeps.push(ms); }, random: () => 0.5, log: () => {}, ...over,
    };
    return w;
  }

  /** Контакт, которому пора дожимать, с готовым черновиком. */
  const draft = (contact: string, daysAgo = 6): number => {
    const q = sentTo(contact, daysAgo);
    return store.insertDraft(q, contact, `Привет! Напоминаю про вакансию. Пришлю резюме для ${contact}.`, 'template', NOW)!;
  };

  it('выключенный тумблер — отказ с причиной, ничего не уходит', async () => {
    settings.followups.enabled = false;
    draft('a');
    const w = world();
    const r = await runFollowups('all', w.deps);
    expect(r).toMatchObject({ halted: 'disabled', sent: 0 });
    expect(r.reason).toContain('Дожимы выключены');
    expect(w.sent).toEqual([]);
  });

  it('нет throttle.tg или нет сессии Telegram — отказ', async () => {
    draft('a');
    expect((await runFollowups('all', world({ throttle: undefined }).deps)).halted).toBe('no_throttle');
    const noSession = await runFollowups('all', world({ sender: async () => ({ error: 'VPN выключен' }) }).deps);
    expect(noSession).toMatchObject({ halted: 'no_session', reason: 'VPN выключен' });
  });

  it('отправка: статус sent, событие «от аккаунта», пауза между сообщениями в диапазоне throttle.tg, после последнего паузы нет', async () => {
    const a = draft('a');
    const b = draft('b');
    const w = world();
    w.historyBy['a'] = { count: 0, firstAt: null, peerId: 501 };
    w.historyBy['b'] = { count: 0, firstAt: null, peerId: 502 };
    const r = await runFollowups('all', w.deps);
    expect(r).toMatchObject({ sent: 2, halted: null });
    expect(w.sent.map((s) => s.to)).toEqual(['a', 'b']);
    expect(store.byId(a)).toMatchObject({ status: 'sent', sentAt: NOW });
    expect(store.byId(b)?.status).toBe('sent');
    expect(w.sleeps).toHaveLength(1);
    expect(w.sleeps[0]).toBeGreaterThanOrEqual(THROTTLE.minDelayMs);
    expect(w.sleeps[0]).toBeLessThanOrEqual(THROTTLE.maxDelayMs);
    expect(dialogs.list(NOW).map((d) => d.outCount)).toEqual([1, 1]);
    // второй прогон не шлёт повторно
    const again = await runFollowups('all', world().deps);
    expect(again.sent).toBe(0);
  });

  it('по списку id уходят только названные', async () => {
    const a = draft('a');
    draft('b');
    const w = world();
    await runFollowups([a], w.deps);
    expect(w.sent.map((s) => s.to)).toEqual(['a']);
  });

  it('живая проверка истории: рекрутёр уже ответил — дожим отменён, событие «входящее» записано', async () => {
    const a = draft('a');
    const w = world();
    w.historyBy['a'] = { count: 2, firstAt: NOW - 2 * DAY, peerId: 4242 };
    const r = await runFollowups('all', w.deps);
    expect(r).toMatchObject({ sent: 0, cancelled: 1 });
    expect(w.sent).toEqual([]);
    expect(store.byId(a)).toMatchObject({ status: 'cancelled', reason: 'рекрутёр уже ответил' });
    const [d] = dialogs.list(NOW);
    expect(d).toMatchObject({ username: 'a', inCount: 1, status: 'replied' });
  });

  it('история не прочиталась — не отправляем (fail closed), черновик цел; протухшая сессия — остановка', async () => {
    const a = draft('a');
    const w = world();
    w.historyBy['a'] = new Error('socket hang up');
    const r = await runFollowups('all', w.deps);
    expect(r).toMatchObject({ sent: 0, skipped: 1, halted: null });
    expect(store.byId(a)?.status).toBe('draft');
    const auth = world();
    auth.historyBy['a'] = new errors.RPCError('AUTH_KEY_UNREGISTERED', {} as never, 401);
    expect((await runFollowups('all', auth.deps)).halted).toBe('auth_required');
  });

  it('условия изменились после подготовки (контакту уже готовят новое сообщение) — отмена без отправки', async () => {
    const a = draft('a');
    seq += 1;
    queue.insertPending(normalizeVacancy({
      source: 'tg', sourceId: `z${seq}`, title: 'новая', company: '', url: 'u', description: 'd', geo: '', postedAt: new Date(NOW), contact: 'a',
    }), 1, [], 'письмо', 'dm');
    const w = world();
    const r = await runFollowups('all', w.deps);
    expect(r.cancelled).toBe(1);
    expect(store.byId(a)?.status).toBe('cancelled');
    expect(w.sent).toEqual([]);
  });

  it('дневной лимит общий с обычными сообщениями Telegram: остаток остаётся черновиками', async () => {
    const a = draft('a');
    const w = world();
    w.sentToday.n = 39;
    const r1 = await runFollowups('all', w.deps);
    expect(r1.sent).toBe(1);
    draft('b');
    const r2 = await runFollowups('all', w.deps);
    expect(r2).toMatchObject({ sent: 0, halted: 'daily_limit' });
    expect(store.drafts().map((d) => d.contact)).toEqual(['b']);
    void a;
  });

  it('PEER_FLOOD и долгий FloodWait — остановка прогона, черновик остаётся', async () => {
    const a = draft('a');
    const w = world();
    w.sendError.push(new errors.RPCError('PEER_FLOOD', {} as never, 400));
    const r = await runFollowups('all', w.deps);
    expect(r.halted).toBe('account_limited');
    expect(store.byId(a)?.status).toBe('draft');

    const slow = world();
    slow.sendError.push(new errors.FloodWaitError({ request: {} as never, capture: 3600 }));
    expect((await runFollowups('all', slow.deps)).halted).toBe('account_limited');
  });

  it('короткий FloodWait: ждём и повторяем один раз', async () => {
    draft('a');
    const w = world();
    w.sendError.push(new errors.FloodWaitError({ request: {} as never, capture: 7 }));
    const r = await runFollowups('all', w.deps);
    expect(r.sent).toBe(1);
    expect(w.sleeps).toContain(7000);
  });

  it('закрытые входящие и «не человек» — failed с причиной, прогон идёт дальше', async () => {
    const a = draft('closed');
    const b = draft('chan');
    const c = draft('fine');
    const w = world();
    w.sendError.push(new errors.RPCError('USER_PRIVACY_RESTRICTED', {} as never, 400));
    w.peers['chan'] = 'channel';
    const r = await runFollowups('all', w.deps);
    expect(r).toMatchObject({ sent: 1, failed: 2 });
    expect(store.byId(a)).toMatchObject({ status: 'failed' });
    expect(store.byId(a)?.reason).toContain('закрыты');
    expect(store.byId(b)?.reason).toContain('не человек');
    expect(store.byId(c)?.status).toBe('sent');
  });

  it('протухшая сессия при отправке — остановка auth_required', async () => {
    draft('a');
    const w = world();
    w.sendError.push(new errors.RPCError('SESSION_REVOKED', {} as never, 401));
    expect((await runFollowups('all', w.deps)).halted).toBe('auth_required');
  });

  it('кнопка «Стоп» останавливает до следующего сообщения', async () => {
    draft('a');
    draft('b');
    const w = world();
    let calls = 0;
    w.deps = { ...w.deps, stopRequested: () => { calls += 1; return calls > 1; } };
    const r = await runFollowups('all', w.deps);
    expect(r).toMatchObject({ sent: 1, halted: 'stopped' });
    expect(store.drafts()).toHaveLength(1);
  });
});
