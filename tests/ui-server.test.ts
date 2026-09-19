import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, networkInterfaces } from 'node:os';
import { startPanel, type PanelDeps } from '../src/ui/server.js';
import { Queue } from '../src/core/queue.js';
import { normalizeVacancy } from '../src/core/vacancy.js';
import { seedSettings, validateSettings, type Settings } from '../src/core/settings.js';

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
      source: 'hh', sourceId: '1', title: 'Бизнес-аналитик', company: 'Сбер',
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


describe('панель — состояние прокси', () => {
  /**
   * Без прокси панель ищет и «пишет» письма как обычно, только все они
   * выходят пустыми. Консоль человек не смотрит — сказать обязана страница.
   * Состояние живое: прокси ищется на каждый запрос, VPN включают и
   * выключают, не перезапуская панель.
   */
  async function withStatus(
    proxyStatus: NonNullable<PanelDeps['proxyStatus']>,
    fn: (port: number) => Promise<void>,
  ): Promise<void> {
    const q2 = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-px-')), 'test.db'));
    const p2 = await startPanel(q2, 0, { proxyStatus });
    try { await fn(p2.port); } finally { await p2.close(); q2.close(); }
  }

  async function status(port: number): Promise<{ usable: boolean | null; address?: string | null; checked?: string[] }> {
    return await (await fetch(`http://127.0.0.1:${port}/api/proxy/status`)).json() as
      { usable: boolean | null; address?: string | null; checked?: string[] };
  }

  it('прокси найден — годен, и называет адрес', async () => {
    await withStatus(async () => ({
      found: { host: '127.0.0.1', port: 10809, source: 'windows' }, checked: ['127.0.0.1:10809'],
    }), async (port) => {
      expect(await status(port)).toMatchObject({ usable: true, address: '127.0.0.1:10809' });
    });
  });

  it('прокси не найден — не годен, и говорит, где искал', async () => {
    await withStatus(async () => ({ found: null, checked: ['127.0.0.1:10809', '127.0.0.1:10801'] }),
      async (port) => {
        expect(await status(port)).toEqual({
          usable: false, address: null, checked: ['127.0.0.1:10809', '127.0.0.1:10801'],
        });
      });
  });

  it('VPN включили при открытой панели — ручка это видит без перезапуска', async () => {
    let on = false;
    await withStatus(async () => (on
      ? { found: { host: '127.0.0.1', port: 10809, source: 'vpn-process' }, checked: ['127.0.0.1:10809'] }
      : { found: null, checked: ['127.0.0.1:10809'] }),
    async (port) => {
      expect((await status(port)).usable).toBe(false);
      on = true;
      expect((await status(port)).usable).toBe(true);
    });
  });

  it('панель поднята не из cli — не знает и не пугает зря', async () => {
    // Так её поднимают тесты: настоящий поиск прокси тут не нужен.
    expect(await status(PORT)).toEqual({ usable: null });
  });
});

describe('панель — настройки', () => {
  let stored: Settings;
  let settingsPanel: { port: number; close(): Promise<void> };
  const suggestCalls: string[] = [];

  beforeEach(async () => {
    stored = seedSettings(undefined, null);
    settingsPanel = await startPanel(q, 0, {
      settings: {
        get: () => stored,
        save: async (raw) => {
          const r = validateSettings(raw);
          if (r.ok) stored = r.settings;
          return r;
        },
        suggest: async (name) => {
          suggestCalls.push(name);
          return name === 'сбой'
            ? { ok: false, error: 'VPN выключен' }
            : { ok: true, suggestion: { titleWords: ['x'], skills: [{ name: 'A', synonyms: ['a'], weight: 10, core: true }] } };
        },
      },
    });
  });
  afterEach(async () => { await settingsPanel.close(); });

  const url = (p: string) => `http://127.0.0.1:${settingsPanel.port}${p}`;

  it('GET /api/settings отдаёт настройки', async () => {
    const body = await (await fetch(url('/api/settings'))).json() as Settings;
    expect(body.specialties[0]!.name).toBe('Бизнес-аналитик');
  });

  it('POST /api/settings сохраняет правку веса', async () => {
    const next = structuredClone(stored);
    next.specialties[0]!.skills[0]!.weight = 30;
    const res = await post(url('/api/settings'), next);
    expect(res.status).toBe(200);
    expect(stored.specialties[0]!.skills[0]!.weight).toBe(30);
  });

  it('плохие настройки — 400 с причиной, сохранённое не меняется', async () => {
    const bad = structuredClone(stored);
    bad.specialties[0]!.name = '';
    const res = await post(url('/api/settings'), bad);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/название/);
    expect(stored.specialties[0]!.name).toBe('Бизнес-аналитик');
  });

  it('POST /api/settings/suggest — предложение или 502 с причиной', async () => {
    const ok = await post(url('/api/settings/suggest'), { name: 'Менеджер продукта', resumePdf: null });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { suggestion: { titleWords: string[] } }).suggestion.titleWords).toEqual(['x']);
    const fail = await post(url('/api/settings/suggest'), { name: 'сбой', resumePdf: null });
    expect(fail.status).toBe(502);
    expect((await fail.json() as { error: string }).error).toBe('VPN выключен');
  });

  it('suggest без названия — 400, модель не зовётся', async () => {
    const before = suggestCalls.length;
    const res = await post(url('/api/settings/suggest'), { name: '  ' });
    expect(res.status).toBe(400);
    expect(suggestCalls.length).toBe(before);
  });
});

describe('панель без настроек', () => {
  it('GET /api/settings — 409, а не падение', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/settings`);
    expect(res.status).toBe(409);
  });

  it('Telegram-ручки без зависимости — 409', async () => {
    expect((await fetch(`http://127.0.0.1:${PORT}/api/telegram/dialogs`)).status).toBe(409);
    expect((await post(`http://127.0.0.1:${PORT}/api/telegram/resolve`, { ref: '@x' })).status).toBe(409);
  });
});

describe('панель — Telegram', () => {
  const CHAT = { id: '-1001', title: 'Работа в ИТ', username: 'workayte', kind: 'channel' as const };
  let tgPanel: { port: number; close(): Promise<void> };
  beforeEach(async () => {
    tgPanel = await startPanel(q, 0, {
      telegram: {
        dialogs: async () => ({ ok: true, chats: [CHAT] }),
        resolve: async (ref) => (ref === 'bad' ? { ok: false, error: 'не найден' } : { ok: true, chat: CHAT }),
      },
    });
  });
  afterEach(async () => { await tgPanel.close(); });
  const url = (p: string) => `http://127.0.0.1:${tgPanel.port}${p}`;

  it('dialogs и resolve отдаются; ошибка — 502 с причиной', async () => {
    expect(await (await fetch(url('/api/telegram/dialogs'))).json()).toEqual({ chats: [CHAT] });
    expect(await (await post(url('/api/telegram/resolve'), { ref: '@workayte' })).json()).toEqual({ chat: CHAT });
    const bad = await post(url('/api/telegram/resolve'), { ref: 'bad' });
    expect(bad.status).toBe(502);
    expect((await bad.json() as { error: string }).error).toBe('не найден');
  });

  it('строка с контактом, которому уже писали, приходит с предупреждением; первая — без', async () => {
    function tg(id: string, title: string) {
      return normalizeVacancy({
        source: 'tg', sourceId: `-1001:${id}`, title, company: '', url: `https://t.me/workayte/${id}`,
        description: 'd', geo: '', postedAt: '2026-09-19T00:00:00Z', contact: 'hr_a', channel: 'Работа в ИТ',
      });
    }
    q.insertPending(tg('1', 'Первая'), 60, [], 'п', 'dm');
    const first = q.listByStatus('pending').find((r) => r.sourceId === '-1001:1')!;
    q.approve(first.id);
    q.markSent(first.id);
    q.insertPending(tg('2', 'Вторая'), 60, [], 'п', 'dm');

    const rows = await (await fetch(url('/api/pending'))).json() as Array<{ sourceId: string; contactWarning: string | null }>;
    const second = rows.find((r) => r.sourceId === '-1001:2')!;
    expect(second.contactWarning).toMatch(/@hr_a/);
    expect(second.contactWarning).toMatch(/«Первая»/);
    // Строки без контакта (hh) — без предупреждения.
    expect(rows.find((r) => r.sourceId === '1')!.contactWarning).toBeNull();
  });
});
