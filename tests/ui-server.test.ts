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

describe('панель — занятый порт', () => {
  it('вторая панель на том же порту падает объяснимым сообщением, а не дампом стека', async () => {
    // Без обработчика 'error' на server Node роняет процесс необработанным
    // событием: человек, дважды нажавший кнопку запуска, получал двадцать
    // строк трассировки вместо одной фразы про уже открытую панель.
    await expect(startPanel(q, PORT)).rejects.toThrow(/занят/);
  });

  it('сообщение называет адрес, по которому уже работающая панель доступна', async () => {
    await expect(startPanel(q, PORT)).rejects.toThrow(new RegExp(`127\.0\.0\.1:${PORT}`));
  });
});

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

// ============================================================================
// Задача task-review-fixes, находка 2: поиск и отправка держат один и тот же
// браузерный профиль (browser-profile/) — обе команды нужен один и тот же
// Chromium с одной и той же залогиненной сессией. Раньше /api/search/start
// проверял только search.running, а /api/send/start — только send.running,
// так что запуск одного поверх идущего другого падал на первой же странице/
// заявке, и предохранитель maxConsecutiveFailures в sender.ts останавливал
// очередь так, будто площадка сломалась.
// ============================================================================
describe('панель — поиск и отправка не идут одновременно', () => {
  const CONFIG = {
    minScore: 40, letterFullThreshold: 75, letterModels: ['m:free'],
    searchQueries: [{ query: 'бизнес-аналитик' }],
    throttle: { hh: { minDelayMs: 0, maxDelayMs: 0 } },
  };

  it('старт отправки во время идущего поиска отклоняется явным 409, называющим поиск', async () => {
    let resolveSearch: (() => void) | undefined;
    const p2 = await startPanel(q, 0, {
      adapters: [{
        name: 'hh',
        async search() { return []; },
        async apply() { return { status: 'sent' as const }; },
      }],
      config: CONFIG,
      startSearch: async () => {
        await new Promise<void>((r) => { resolveSearch = r; });
        return { report: { found: 0, queued: 0 }, emptyLetters: 0 };
      },
    });
    try {
      const start = await fetch(`http://127.0.0.1:${p2.port}/api/search/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 5 }),
      });
      expect(start.status).toBe(202);
      for (let i = 0; i < 40; i++) {
        const st = await (await fetch(`http://127.0.0.1:${p2.port}/api/search/status`)).json() as { running: boolean };
        if (st.running) break;
        await new Promise((r) => setTimeout(r, 10));
      }

      const res = await fetch(`http://127.0.0.1:${p2.port}/api/send/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(409);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/поиск/i);

      resolveSearch?.();
    } finally {
      await p2.close();
    }
  });

  it('старт поиска во время идущей отправки отклоняется явным 409, называющим отправку', async () => {
    const row = q.listByStatus('pending')[0]!;
    q.approve(row.id);

    let resolveApply: (() => void) | undefined;
    const p2 = await startPanel(q, 0, {
      adapters: [{
        name: 'hh',
        async search() { return []; },
        async apply() {
          await new Promise<void>((r) => { resolveApply = r; });
          return { status: 'sent' as const };
        },
      }],
      config: CONFIG,
      startSearch: async () => ({ report: { found: 0, queued: 0 }, emptyLetters: 0 }),
    });
    try {
      const start = await fetch(`http://127.0.0.1:${p2.port}/api/send/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(start.status).toBe(202);
      for (let i = 0; i < 40; i++) {
        const st = await (await fetch(`http://127.0.0.1:${p2.port}/api/send/status`)).json() as { running: boolean };
        if (st.running) break;
        await new Promise((r) => setTimeout(r, 10));
      }

      const res = await fetch(`http://127.0.0.1:${p2.port}/api/search/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 5 }),
      });
      expect(res.status).toBe(409);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/отправк/i);

      resolveApply?.();
    } finally {
      await p2.close();
    }
  });
});

// ============================================================================
// Задача task-review-fixes, находка 9: startedAt писался в SendState/
// SearchState и никогда не читался ни одной ручкой статуса. Операция идёт
// минутами — "сколько уже прошло" не декоративная мелочь. Решение: отдавать
// его через /api/*/status (панель показывает прошедшее время).
// ============================================================================
describe('панель — startedAt в статусе поиска/отправки (finding 9)', () => {
  it('startedAt отсутствует (null) до первого запуска и появляется числом, пока поиск идёт', async () => {
    let resolveSearch: (() => void) | undefined;
    const p2 = await startPanel(q, 0, {
      startSearch: async () => {
        await new Promise<void>((r) => { resolveSearch = r; });
        return { report: { found: 0, queued: 0 }, emptyLetters: 0 };
      },
    });
    try {
      const before = await (await fetch(`http://127.0.0.1:${p2.port}/api/search/status`)).json() as { startedAt: number | null };
      expect(before.startedAt).toBeNull();

      const t0 = Date.now();
      await fetch(`http://127.0.0.1:${p2.port}/api/search/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 5 }),
      });
      const during = await (await fetch(`http://127.0.0.1:${p2.port}/api/search/status`)).json() as
        { running: boolean; startedAt: number | null };
      expect(during.running).toBe(true);
      expect(typeof during.startedAt).toBe('number');
      expect(during.startedAt as number).toBeGreaterThanOrEqual(t0);

      resolveSearch?.();
    } finally {
      await p2.close();
    }
  });

  it('startedAt появляется в статусе отправки, пока она идёт', async () => {
    const row = q.listByStatus('pending')[0]!;
    q.approve(row.id);

    let resolveApply: (() => void) | undefined;
    const p2 = await startPanel(q, 0, {
      adapters: [{
        name: 'hh',
        async search() { return []; },
        async apply() {
          await new Promise<void>((r) => { resolveApply = r; });
          return { status: 'sent' as const };
        },
      }],
      config: {
        minScore: 40, letterFullThreshold: 75, letterModels: ['m:free'],
        searchQueries: [{ query: 'q' }], throttle: { hh: { minDelayMs: 0, maxDelayMs: 0 } },
      },
    });
    try {
      const t0 = Date.now();
      await fetch(`http://127.0.0.1:${p2.port}/api/send/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const during = await (await fetch(`http://127.0.0.1:${p2.port}/api/send/status`)).json() as
        { running: boolean; startedAt: number | null };
      expect(during.running).toBe(true);
      expect(typeof during.startedAt).toBe('number');
      expect(during.startedAt as number).toBeGreaterThanOrEqual(t0);

      resolveApply?.();
    } finally {
      await p2.close();
    }
  });
});

// ============================================================================
// Задача task-review-fixes, находка 1: панель теперь собирает адаптеры один
// раз и переиспользует их для поиска и отправки (см. cli.ts). Дополнение —
// panel.close() отпускает браузерные контексты адаптеров, у кого они есть,
// а не оставляет их висеть после остановки панели.
// ============================================================================
describe('панель — close() освобождает адаптеры (finding 1)', () => {
  it('вызывает close() у адаптера, если он его предоставляет', async () => {
    let closed = 0;
    const adapter = {
      name: 'hh',
      async search() { return []; },
      async apply() { return { status: 'sent' as const }; },
      async close() { closed++; },
    };
    const p2 = await startPanel(q, 0, {
      adapters: [adapter],
      config: {
        minScore: 40, letterFullThreshold: 75, letterModels: ['m:free'],
        searchQueries: [{ query: 'q' }], throttle: {},
      },
    });
    await p2.close();
    expect(closed).toBe(1);
  });

  it('адаптер без close() не мешает панели закрыться', async () => {
    const adapter = {
      name: 'hrge',
      async search() { return []; },
      async apply() { return { status: 'sent' as const }; },
    };
    const p2 = await startPanel(q, 0, {
      adapters: [adapter],
      config: {
        minScore: 40, letterFullThreshold: 75, letterModels: ['m:free'],
        searchQueries: [{ query: 'q' }], throttle: {},
      },
    });
    await expect(p2.close()).resolves.toBeUndefined();
  });
});
