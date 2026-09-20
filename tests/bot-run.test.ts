import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBot } from '../src/bot/run.js';
import { BotApi } from '../src/bot/api.js';
import { BotStore } from '../src/bot/state.js';
import { Queue } from '../src/core/queue.js';
import { seedSettings } from '../src/core/settings.js';
import { DEFAULT_BOT_LIMITS } from '../src/core/config.js';
import { TEXTS } from '../src/bot/texts.js';
import type { HandlerDeps } from '../src/bot/handlers.js';
import type { TgBotUpdate } from '../src/bot/types.js';

interface Call { method: string; body: Record<string, unknown> }

const transport = (rounds: TgBotUpdate[][], failFirst?: { status: number; body: unknown }) => {
  const sent: Call[] = [];
  let round = 0;
  let failedOnce = false;
  const fetchImpl: typeof fetch = async (url, init) => {
    const method = String(url).split('/').pop() ?? '';
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
    if (method === 'getWebhookInfo') return new Response(JSON.stringify({ ok: true, result: { url: '' } }));
    if (method === 'getUpdates') {
      const batch = rounds[round] ?? [];
      round += 1;
      return new Response(JSON.stringify({ ok: true, result: batch }));
    }
    if (failFirst !== undefined && !failedOnce) {
      failedOnce = true;
      return new Response(JSON.stringify(failFirst.body), { status: failFirst.status });
    }
    sent.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  };
  return { fetchImpl, sent };
};

const message = (chatId: number, text: string, updateId: number): TgBotUpdate => ({
  update_id: updateId,
  message: {
    message_id: updateId, date: 0, chat: { id: chatId, type: 'private' },
    from: { id: chatId, username: 'rec', is_bot: false }, text,
  },
});

const makeDeps = (path: string, store: BotStore): HandlerDeps => ({
  store,
  queue: new Queue(path),
  settings: () => seedSettings(undefined, null),
  limits: DEFAULT_BOT_LIMITS,
  profile: { github: 'https://github.com/x', telegram: '@ll_larr' },
  salaryExpectation: 'по договорённости',
  resume: () => 'резюме',
  askModel: async () => ({ kind: 'text', text: 'ответ модели' }),
  readLink: async () => null,
  readFile: async () => ({ ok: false, reason: 'type' }),
  now: () => new Date(2026, 8, 20, 12, 0),
});

const store = (): { store: BotStore; path: string } => {
  const path = join(mkdtempSync(join(tmpdir(), 'jaa-run-')), 'queue.db');
  return { store: new BotStore(path), path };
};

describe('runBot', () => {
  it('обрабатывает пачку, двигает offset и выходит на пустом круге', async () => {
    const { store: s, path } = store();
    const { fetchImpl, sent } = transport([[message(5, '/start', 10)], []]);
    await runBot({
      api: new BotApi('T', { fetchImpl }), store: s, deps: makeDeps(path, s),
      ownerChatId: null, log: () => {}, stopAfterIdleRounds: 1, sleep: async () => {},
    });
    expect(sent.find((c) => c.method === 'sendMessage')?.body['text']).toBe(TEXTS.start);
    expect(s.kvGet('offset')).toBe('11');
    s.close();
  });

  it('вебхук стоит — long polling не запускается, настройки бота не трогаются', async () => {
    const { store: s, path } = store();
    const lines: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      const method = String(url).split('/').pop() ?? '';
      if (method === 'getWebhookInfo') {
        return new Response(JSON.stringify({ ok: true, result: { url: 'https://example.com/hook' } }));
      }
      throw new Error(`не должно вызываться: ${method}`);
    };
    await runBot({
      api: new BotApi('T', { fetchImpl }), store: s, deps: makeDeps(path, s),
      ownerChatId: 1, log: (l) => lines.push(l), stopAfterIdleRounds: 1, sleep: async () => {},
    });
    expect(lines.join('\n')).toMatch(/вебхук/);
    s.close();
  });

  it('409 — рядом второй экземпляр, выходим с ненулевым кодом', async () => {
    const { store: s, path } = store();
    const previous = process.exitCode;
    const lines: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      const method = String(url).split('/').pop() ?? '';
      if (method === 'getWebhookInfo') return new Response(JSON.stringify({ ok: true, result: { url: '' } }));
      return new Response(JSON.stringify({ ok: false, description: 'Conflict' }), { status: 409 });
    };
    await runBot({
      api: new BotApi('T', { fetchImpl }), store: s, deps: makeDeps(path, s),
      ownerChatId: 1, log: (l) => lines.push(l), sleep: async () => {},
    });
    expect(lines.join('\n')).toMatch(/другой экземпляр/);
    expect(process.exitCode).toBe(1);
    process.exitCode = previous;
    s.close();
  });

  it('сеть отвалилась — бот ждёт и пробует снова, а не выходит', async () => {
    const { store: s, path } = store();
    let calls = 0;
    const pauses: number[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      const method = String(url).split('/').pop() ?? '';
      if (method === 'getWebhookInfo') return new Response(JSON.stringify({ ok: true, result: { url: '' } }));
      calls += 1;
      if (calls <= 2) throw new Error('socket hang up');
      return new Response(JSON.stringify({ ok: true, result: [] }));
    };
    await runBot({
      api: new BotApi('T', { fetchImpl }), store: s, deps: makeDeps(path, s), ownerChatId: 1,
      log: () => {}, stopAfterIdleRounds: 1, sleep: async (ms) => { pauses.push(ms); },
    });
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(pauses).toEqual([1000, 2000]);
    s.close();
  });

  it('повторяет пинг о встрече, пока он не ушёл', async () => {
    const { store: s, path } = store();
    s.saveMeeting({
      chatId: 5, username: 'rec', queueId: null, meetAt: Date.now(), raw: '07.10;15:30', createdAt: Date.now(),
    });
    const { fetchImpl, sent } = transport([[], []], { status: 500, body: { ok: false, description: 'boom' } });
    await runBot({
      api: new BotApi('T', { fetchImpl }), store: s, deps: makeDeps(path, s),
      ownerChatId: 999, log: () => {}, stopAfterIdleRounds: 2, sleep: async () => {},
    });
    // Первый круг — отправка упала, запись осталась; второй — ушла.
    expect(sent.some((c) => c.body['chat_id'] === 999)).toBe(true);
    expect(s.pendingMeetings()).toEqual([]);
    s.close();
  });

  it('владелец не задан — бот подсказывает chat_id и не падает', async () => {
    const { store: s, path } = store();
    const lines: string[] = [];
    const { fetchImpl } = transport([[message(777, 'привет', 1)], []]);
    await runBot({
      api: new BotApi('T', { fetchImpl }), store: s, deps: makeDeps(path, s),
      ownerChatId: null, log: (l) => lines.push(l), stopAfterIdleRounds: 1, sleep: async () => {},
    });
    expect(lines.join('\n')).toMatch(/777/);
    expect(lines.join('\n')).toMatch(/TG_OWNER_CHAT_ID/);
    s.close();
  });

  it('вакансия из бота доходит до очереди через полный круг', async () => {
    const { store: s, path } = store();
    const { fetchImpl } = transport([
      [message(5, '/add_vacancy', 1)],
      [message(5, 'Бизнес-аналитик\nBPMN, SQL, интеграции, требования', 2)],
      [],
    ]);
    const deps = makeDeps(path, s);
    let minute = 0;
    deps.now = (): Date => new Date(2026, 8, 20, 12, minute++);
    await runBot({
      api: new BotApi('T', { fetchImpl }), store: s, deps,
      ownerChatId: 999, log: () => {}, stopAfterIdleRounds: 1, sleep: async () => {},
    });
    expect(deps.queue.listByStatus('pending')).toHaveLength(1);
    s.close();
  });
});
