import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, networkInterfaces } from 'node:os';
import { startPanel } from '../src/ui/server.js';
import { Queue } from '../src/core/queue.js';
import { normalizeVacancy } from '../src/core/vacancy.js';

// Порт 0 = система выдаёт свободный. Фиксированный порт создавал гонку между
// перезапусками панели в beforeEach: следующий тест мог не достучаться до
// ещё не освободившегося сокета и падал с ECONNRESET.
let PORT = 0;
let q: Queue;
let panel: { port: number; close(): Promise<void> };

beforeEach(async () => {
  q = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-ui-')), 'test.db'));
  q.insertPending(
    normalizeVacancy({
      source: 'hh', sourceId: '1', title: 'БА', company: 'Сбер',
      url: 'https://hh.ru/vacancy/1', description: 'd', geo: 'Москва',
      postedAt: '2026-08-20T00:00:00Z',
    }),
    80, ['sql'], 'исходное письмо', 'full',
  );
  panel = await startPanel(q, 0);
  PORT = panel.port;
});
afterEach(async () => { await panel.close(); q.close(); });

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('панель', () => {
  it('GET /api/pending отдаёт ожидающие записи', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/pending`);
    const rows = await res.json() as Array<{ id: number; score: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.score).toBe(80);
  });

  it('POST /api/approve с изменённым письмом сохраняет правку', async () => {
    const [row] = q.listByStatus('pending');
    await post(`http://127.0.0.1:${PORT}/api/approve`, { id: row!.id, letter: 'моя правка' });
    expect(q.listByStatus('approved')[0]!.letter).toBe('моя правка');
  });

  it('POST /api/skip убирает запись из pending', async () => {
    const [row] = q.listByStatus('pending');
    await post(`http://127.0.0.1:${PORT}/api/skip`, { id: row!.id });
    expect(q.listByStatus('pending')).toHaveLength(0);
    expect(q.listByStatus('skipped')).toHaveLength(1);
  });

  it('GET / отдаёт HTML страницы', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/`);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<html');
  });
});

describe('панель — одобренные, но ещё не отправленные заявки', () => {
  it('GET /api/approved отдаёт одобренные записи, ожидающие отправки', async () => {
    const [row] = q.listByStatus('pending');
    q.approve(row!.id, 'письмо после одобрения');

    const res = await fetch(`http://127.0.0.1:${PORT}/api/approved`);
    const rows = await res.json() as Array<{ id: number; status: string; letter: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.letter).toBe('письмо после одобрения');
  });

  it('POST /api/skip на approved-строке отменяет её — человек передумал после одобрения', async () => {
    const [row] = q.listByStatus('pending');
    q.approve(row!.id);

    const res = await post(`http://127.0.0.1:${PORT}/api/skip`, { id: row!.id });
    expect(res.status).toBe(200);
    expect(q.listByStatus('approved')).toHaveLength(0);
    expect(q.listByStatus('skipped')).toHaveLength(1);
  });
});

describe('панель — нелегальный переход статуса не роняет сервер 500-кой', () => {
  it('повторный approve уже одобренной строки отвечает 409 и не перезаписывает письмо', async () => {
    const [row] = q.listByStatus('pending');
    const first = await post(`http://127.0.0.1:${PORT}/api/approve`, { id: row!.id, letter: 'первая правка' });
    expect(first.status).toBe(200);

    const second = await post(`http://127.0.0.1:${PORT}/api/approve`, { id: row!.id, letter: 'вторая правка' });
    expect(second.status).toBe(409);
    const body = await second.json() as { error: string };
    expect(body.error).toMatch(/illegal transition/);
    expect(body.error).toMatch(/approved/);

    // Второй вызов не должен был затронуть уже одобренную строку.
    expect(q.listByStatus('approved')[0]!.letter).toBe('первая правка');
  });

  it('skip несуществующего id отвечает 409, а не необработанной 500-кой', async () => {
    const res = await post(`http://127.0.0.1:${PORT}/api/skip`, { id: 999999 });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/no application with id=999999/);
  });
});

describe('панель слушает только loopback', () => {
  function externalIPv4(): string | undefined {
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) return a.address;
      }
    }
    return undefined;
  }

  it('запрос на адрес внешнего сетевого интерфейса не доходит до сервера', async () => {
    const ip = externalIPv4();
    if (ip === undefined) return; // на этой машине нет внешнего IPv4-интерфейса — тест неприменим

    await expect(
      fetch(`http://${ip}:${PORT}/api/pending`, { signal: AbortSignal.timeout(1500) }),
    ).rejects.toThrow();
  });
});

describe('панель — отправка', () => {
  it('без адаптеров отправка недоступна и не запускается', async () => {
    // Панель, поднятая без адаптеров (например, из теста), не должна уметь
    // подавать заявки: это необратимое действие вовне.
    const st = await (await fetch(`http://127.0.0.1:${PORT}/api/send/status`)).json() as
      { canSend: boolean; running: boolean };
    expect(st.canSend).toBe(false);
    expect(st.running).toBe(false);

    const res = await fetch(`http://127.0.0.1:${PORT}/api/send/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(409);
  });

  it('статус сообщает, сколько заявок ждёт отправки', async () => {
    // Одобряем напрямую через очередь, а не через HTTP: здесь проверяется
    // именно отчёт статуса, а не эндпоинт одобрения (он покрыт выше).
    const row = q.listByStatus('pending')[0]!;
    q.approve(row.id);

    const st = await (await fetch(`http://127.0.0.1:${PORT}/api/send/status`)).json() as
      { approved: number; running: boolean };
    expect(st.approved).toBe(1);
    expect(st.running).toBe(false);
  });
});

describe('панель — поиск', () => {
  it('без проводки поиска кнопка недоступна и запуск отклоняется', async () => {
    const st = await (await fetch(`http://127.0.0.1:${PORT}/api/search/status`)).json() as
      { canSearch: boolean; running: boolean };
    expect(st.canSearch).toBe(false);
    expect(st.running).toBe(false);

    const res = await fetch(`http://127.0.0.1:${PORT}/api/search/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 5 }),
    });
    expect(res.status).toBe(409);
  });
});

describe('панель — поиск с проводкой', () => {
  let p: { port: number; close(): Promise<void> };
  let started: number[] = [];

  beforeEach(async () => {
    started = [];
    p = await startPanel(q, 0, {
      startSearch: async (limit) => {
        started.push(limit);
        return { report: { found: 3, queued: 2 }, emptyLetters: 0 };
      },
    });
  });
  afterEach(async () => { await p.close(); });

  it('запускает поиск с переданным числом вакансий', async () => {
    const res = await fetch(`http://127.0.0.1:${p.port}/api/search/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 42 }),
    });
    expect(res.status).toBe(202);

    // Поиск запускается асинхронно, поэтому даём ему дойти до конца.
    for (let i = 0; i < 40 && started.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(started).toEqual([42]);
  });

  it('отклоняет мусорное число, не запуская поиск', async () => {
    for (const limit of [0, -3, 'много']) {
      const res = await fetch(`http://127.0.0.1:${p.port}/api/search/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit }),
      });
      expect(res.status).toBe(400);
    }
    expect(started).toEqual([]);
  });
});
