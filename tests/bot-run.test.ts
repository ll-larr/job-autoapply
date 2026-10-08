import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBot } from '../src/bot/run.js';
import { BotApi } from '../src/bot/api.js';
import { BotStore } from '../src/bot/state.js';
import { Queue } from '../src/core/queue.js';
import { normalizeVacancy } from '../src/core/vacancy.js';
import { seedSettings } from '../src/core/settings.js';
import { DEFAULT_BOT_LIMITS } from '../src/core/config.js';
import { TEXTS } from '../src/bot/texts.js';
import type { HandlerDeps } from '../src/bot/handlers.js';
import type { TgBotUpdate } from '../src/bot/types.js';

interface Call { method: string; body: Record<string, unknown>; /** Тело multipart-запроса (sendDocument) как текст. */ raw?: string }

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

/**
 * Транспорт для пингов владельцу: sendDocument (multipart, тело — буфер) и
 * sendMessage (JSON) отказывают отдельно, столько раз, сколько попросили.
 */
const pingTransport = (
  rounds: TgBotUpdate[][], fails: { documents?: number; messages?: number } = {},
) => {
  const sent: Call[] = [];
  let documents = fails.documents ?? 0;
  let messages = fails.messages ?? 0;
  let round = 0;
  const ok = (result: unknown): Response => new Response(JSON.stringify({ ok: true, result }));
  const refuse = (status: number, description: string): Response =>
    new Response(JSON.stringify({ ok: false, description }), { status });
  const fetchImpl: typeof fetch = async (url, init) => {
    const method = String(url).split('/').pop() ?? '';
    if (method === 'getWebhookInfo') return ok({ url: '' });
    if (method === 'getUpdates') {
      const batch = rounds[round] ?? [];
      round += 1;
      return ok(batch);
    }
    if (method === 'sendDocument') {
      if (documents > 0) {
        documents -= 1;
        return refuse(400, 'Bad Request: boom');
      }
      sent.push({ method, body: {}, raw: Buffer.from(init?.body as Uint8Array).toString('utf8') });
      return ok({ message_id: 1, document: { file_id: 'F' } });
    }
    if (messages > 0) {
      messages -= 1;
      return refuse(500, 'boom');
    }
    sent.push({ method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return ok({ message_id: 1 });
  };
  return { fetchImpl, sent };
};

/** Вакансия, присланная рекрутёром через бота и уже ушедшая в skipped, как #197. */
const skippedBotVacancy = (deps: HandlerDeps): number => {
  deps.queue.insertPending(
    normalizeVacancy({
      source: 'tg-bot', sourceId: '5:30', title: 'Бизнес анализ процессов банка', company: '', url: '',
      description: 'Бизнес анализ процессов банка', geo: '', postedAt: new Date(2026, 8, 20, 20, 58),
      contact: 'rec',
    }),
    0, [], '', 'none',
  );
  const id = deps.queue.idOf('tg-bot', '5:30');
  if (id === null) throw new Error('строка вакансии не создалась');
  deps.queue.skip(id);
  return id;
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

  it('собеседование с прикреплённой вакансией: владельцу уходит ОДИН документ с текстом вакансии, подписью служит пинг', async () => {
    const { store: s, path } = store();
    const deps = makeDeps(path, s);
    const id = skippedBotVacancy(deps);
    s.saveMeeting({
      chatId: 5, username: 'rec', queueId: id, meetAt: new Date(2026, 9, 6, 11, 0).getTime(), raw: '06.10; 11:00',
      createdAt: new Date(2026, 9, 5, 16, 49).getTime(),
    });
    const { fetchImpl, sent } = pingTransport([[], []]);
    await runBot({
      api: new BotApi('T', { fetchImpl }), store: s, deps,
      ownerChatId: 999, log: () => {}, stopAfterIdleRounds: 1, sleep: async () => {},
    });

    const docs = sent.filter((c) => c.method === 'sendDocument');
    expect(docs).toHaveLength(1);
    const raw = docs[0]!.raw ?? '';
    expect(raw).toContain('name="chat_id"\r\n\r\n999\r\n');
    expect(raw).toContain(`filename="vacancy-${id}.txt"`);
    // Описание — последнее в файле: после шапки пустая строка, дальше граница части.
    expect(raw).toContain('\n\nБизнес анализ процессов банка\r\n--');
    const caption = /name="caption"\r\n\r\n([\s\S]*?)\r\n--/.exec(raw)?.[1] ?? '';
    expect(caption).toContain('6 октября (вторник), 11:00');
    expect(caption).toContain('«06.10; 11:00»');
    expect(caption).toContain('@rec');
    expect(caption).toContain(`#${id}`);
    expect(caption).toContain('Бизнес анализ процессов банка');
    // Пинг не дублируется отдельным сообщением.
    expect(sent.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
    expect(s.pendingMeetings()).toEqual([]);
    s.close();
  });

  it('файл не загрузился: пинг уходит обычным сообщением, причина видна в логе', async () => {
    const { store: s, path } = store();
    const deps = makeDeps(path, s);
    const id = skippedBotVacancy(deps);
    s.saveMeeting({
      chatId: 5, username: 'rec', queueId: id, meetAt: new Date(2026, 9, 6, 11, 0).getTime(), raw: '06.10; 11:00',
      createdAt: new Date(2026, 9, 5, 16, 49).getTime(),
    });
    const lines: string[] = [];
    const { fetchImpl, sent } = pingTransport([[], []], { documents: 1 });
    await runBot({
      api: new BotApi('T', { fetchImpl }), store: s, deps,
      ownerChatId: 999, log: (l) => lines.push(l), stopAfterIdleRounds: 1, sleep: async () => {},
    });

    const texts = sent
      .filter((c) => c.method === 'sendMessage' && c.body['chat_id'] === 999)
      .map((c) => String(c.body['text']));
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('06.10; 11:00');
    expect(texts[0]).toContain(`#${id}`);
    expect(texts[0]).toContain('Бизнес анализ процессов банка');
    expect(sent.some((c) => c.method === 'sendDocument')).toBe(false);
    expect(s.pendingMeetings()).toEqual([]);
    expect(lines.join('\n')).toContain('Bad Request: boom');
    s.close();
  });

  it('не прошло ничего — запись остаётся, и следующий круг доставляет пинг с файлом', async () => {
    const { store: s, path } = store();
    const deps = makeDeps(path, s);
    const id = skippedBotVacancy(deps);
    s.saveMeeting({
      chatId: 5, username: 'rec', queueId: id, meetAt: new Date(2026, 9, 6, 11, 0).getTime(), raw: '06.10; 11:00',
      createdAt: new Date(2026, 9, 5, 16, 49).getTime(),
    });
    const { fetchImpl, sent } = pingTransport([[], []], { documents: 1, messages: 1 });
    await runBot({
      api: new BotApi('T', { fetchImpl }), store: s, deps,
      ownerChatId: 999, log: () => {}, stopAfterIdleRounds: 2, sleep: async () => {},
    });

    expect(sent.filter((c) => c.method === 'sendDocument')).toHaveLength(1);
    expect(s.pendingMeetings()).toEqual([]);
    s.close();
  });

  it('вакансию не прикрепляли — обычное сообщение, документа нет', async () => {
    const { store: s, path } = store();
    s.saveMeeting({
      chatId: 5, username: 'rec', queueId: null, meetAt: new Date(2026, 9, 6, 11, 0).getTime(), raw: '06.10; 11:00',
      createdAt: new Date(2026, 9, 5, 16, 49).getTime(),
    });
    const { fetchImpl, sent } = pingTransport([[], []]);
    await runBot({
      api: new BotApi('T', { fetchImpl }), store: s, deps: makeDeps(path, s),
      ownerChatId: 999, log: () => {}, stopAfterIdleRounds: 1, sleep: async () => {},
    });

    expect(sent.some((c) => c.method === 'sendDocument')).toBe(false);
    const texts = sent.filter((c) => c.method === 'sendMessage').map((c) => String(c.body['text']));
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('06.10; 11:00');
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
