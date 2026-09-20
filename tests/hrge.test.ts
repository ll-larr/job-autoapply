import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSearchResponse, parseDetailResponse, HrGeAdapter } from '../src/adapters/hrge.js';

const searchFixture = JSON.parse(
  readFileSync('tests/fixtures/hrge-search-response-keyword.json', 'utf8'),
);
const detailFixture = JSON.parse(
  readFileSync('tests/fixtures/hrge-detail-response.json', 'utf8'),
);

describe('parseSearchResponse', () => {
  it('вытаскивает вакансии из настоящего ответа поиска', () => {
    const items = parseSearchResponse(searchFixture);
    expect(items.length).toBeGreaterThan(0);
    const first = items[0]!;
    expect(first.sourceId).toMatch(/^\d+$/);
    expect(first.title).not.toBe('');
    expect(first.company).not.toBe('');
  });

  it('склеивает массив locations в одну строку', () => {
    const items = parseSearchResponse(searchFixture);
    expect(typeof items[0]!.geo).toBe('string');
    expect(items[0]!.geo).not.toBe('');
  });

  it('на пустом списке возвращает пустой массив, а не бросает', () => {
    expect(parseSearchResponse({ data: { announcements: { items: [], totalCount: 0 } } }))
      .toEqual([]);
  });

  it('на мусорном входе возвращает пустой массив', () => {
    expect(parseSearchResponse(null)).toEqual([]);
    expect(parseSearchResponse({ nope: 1 })).toEqual([]);
    expect(parseSearchResponse({ data: {} })).toEqual([]);
  });
});

describe('parseDetailResponse', () => {
  it('достаёт текст описания из настоящего ответа детали и реально декодирует его', () => {
    const text = parseDetailResponse(detailFixture);
    expect(text.length).toBeGreaterThan(50);
    // Голая длина не отличает декодированный текст от неразобранного entity-супа
    // (он даже длиннее) — эти проверки ловят удаление шага декодирования.
    expect(text).not.toMatch(/&#\d+;/);
    expect(text).not.toMatch(/<[^>]+>/);
    // Кусок реального декодированного грузинского текста из фикстуры —
    // пиновка самого преобразования, а не только отсутствия артефактов.
    expect(text).toContain('სამშენებლო კომპანიას');
  });

  it('на мусорном входе возвращает пустую строку', () => {
    expect(parseDetailResponse(null)).toBe('');
    expect(parseDetailResponse({})).toBe('');
  });

  it('декодирует entity-ссылки одним проходом — без двойного декода и без утечки из-под тег-стриппера', () => {
    const html = '<div>&amp;lt; &lt;script&gt; &nbsp;text &#65;</div>';
    const text = parseDetailResponse({ data: { announcement: { description: html } } });
    // &amp;lt; -> буквальное "&lt;" (не "<" — это был бы двойной декод);
    // &lt;/&gt; декодируются в буквальные "<"/">" уже после стриппинга тегов;
    // &nbsp; -> пробел; &#65; -> "A" через десятичную числовую ссылку.
    expect(text).toBe('&lt; <script> text A');
  });
});

describe('HrGeAdapter.search', () => {
  it('шлёт Limit — без него сервер делит на ноль', async () => {
    let sentBody: Record<string, unknown> | null = null;
    const a = new HrGeAdapter({
      fetchImpl: async (_url, init) => {
        sentBody = JSON.parse(String((init as RequestInit).body));
        return new Response(JSON.stringify(searchFixture), { status: 200 });
      },
    });
    await a.search({ query: 'analyst', maxResults: 0 });
    expect(sentBody).not.toBeNull();
    expect(sentBody!['Limit']).toBeGreaterThan(0);
    expect(sentBody!['Query']).toBe('analyst');
  });

  it('skip уезжает в Start — конвейер просит следующий срез, а не тот же первый', async () => {
    // Без этого прогон с целью по доставленным вакансиям встал бы: каждая
    // следующая порция возвращала бы те же карточки, дедуп прогона выбрасывал
    // бы их все, и очередь не росла бы никогда.
    let sentBody: Record<string, unknown> | null = null;
    const a = new HrGeAdapter({
      fetchImpl: async (url, init) => {
        if (String(url).includes('announcement-search')) {
          sentBody = JSON.parse(String((init as RequestInit).body));
          return new Response(JSON.stringify(searchFixture), { status: 200 });
        }
        return new Response(JSON.stringify(detailFixture), { status: 200 });
      },
    });
    await a.search({ query: 'analyst', maxResults: 1, skip: 40 });
    expect(sentBody!['Start']).toBe(40);
  });

  it('без skip начинает с начала выдачи', async () => {
    let sentBody: Record<string, unknown> | null = null;
    const a = new HrGeAdapter({
      fetchImpl: async (_url, init) => {
        sentBody = JSON.parse(String((init as RequestInit).body));
        return new Response(JSON.stringify(searchFixture), { status: 200 });
      },
    });
    await a.search({ query: 'analyst', maxResults: 0 });
    expect(sentBody!['Start']).toBe(0);
  });

  it('дочитывает описание для каждой возвращённой вакансии', async () => {
    let detailCalls = 0;
    const a = new HrGeAdapter({
      fetchImpl: async (url) => {
        if (String(url).includes('announcement-search')) {
          return new Response(JSON.stringify(searchFixture), { status: 200 });
        }
        detailCalls++;
        return new Response(JSON.stringify(detailFixture), { status: 200 });
      },
    });
    const vs = await a.search({ query: 'analyst', maxResults: 2 });
    expect(vs).toHaveLength(2);
    expect(detailCalls).toBe(2);
    for (const v of vs) expect(v.description.length).toBeGreaterThan(50);
  });

  it('падение детали не роняет всю выдачу — вакансия остаётся с пустым описанием', async () => {
    const a = new HrGeAdapter({
      fetchImpl: async (url) => {
        if (String(url).includes('announcement-search')) {
          return new Response(JSON.stringify(searchFixture), { status: 200 });
        }
        return new Response('nope', { status: 500 });
      },
    });
    const vs = await a.search({ query: 'analyst', maxResults: 1 });
    expect(vs).toHaveLength(1);
    expect(vs[0]!.description).toBe('');
  });

  it('падение детали ПЕРВОГО элемента не абортит цикл — второй элемент дочитывается нормально', async () => {
    // maxResults: 1 в тесте выше не может отличить "вернул 1 результат с пустым
    // описанием" от "упал бы и на втором элементе тоже" — здесь их два, и
    // проваливается именно первый по порядку запрос.
    const a = new HrGeAdapter({
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes('announcement-search')) {
          return new Response(JSON.stringify(searchFixture), { status: 200 });
        }
        if (u.includes('/announcement/488233')) {
          return new Response('nope', { status: 500 });
        }
        return new Response(JSON.stringify(detailFixture), { status: 200 });
      },
    });
    const vs = await a.search({ query: 'analyst', maxResults: 2 });
    expect(vs).toHaveLength(2);
    expect(vs[0]!.description).toBe('');
    expect(vs[1]!.description.length).toBeGreaterThan(50);
  });

  it('на ошибке поиска возвращает пустой массив', async () => {
    const a = new HrGeAdapter({
      fetchImpl: async () => new Response('boom', { status: 500 }),
    });
    expect(await a.search({ query: 'analyst' })).toEqual([]);
  });

  // Регрессия (задача task-review-fixes, находка 11): hr.ge не несёт
  // структурного маркера опыта нигде в API — ни в поиске, ни в детали.
  // isJuniorExperience(null)/isExperienceAcceptable(null) намеренно пропускают
  // "неизвестно" (core/screening.ts), так что constraints.juniorOnly на
  // запросе "системный аналитик" не отсеивал НИ ОДНОЙ грузинской вакансии —
  // не потому что все они junior, а потому что experience всегда оставался
  // null и гейту было не на чем сработать. Отчёт поиска показывал это как
  // "ничего не отфильтровано", а не как "ограничение неприменимо".
  it('заполняет experience разбором текста описания — тем же фолбэком, что использует hh.ru', async () => {
    const detailWithExperience = {
      data: {
        announcement: {
          description: 'Опыт работы не менее 5 лет в аналогичной должности требуется.',
        },
      },
    };
    const a = new HrGeAdapter({
      fetchImpl: async (url) => {
        if (String(url).includes('announcement-search')) {
          return new Response(JSON.stringify(searchFixture), { status: 200 });
        }
        return new Response(JSON.stringify(detailWithExperience), { status: 200 });
      },
    });
    const vs = await a.search({ query: 'analyst', maxResults: 1 });
    expect(vs).toHaveLength(1);
    // "не менее 5 лет" -> years=[5] -> yearsToLevel(5) = 'between3And6'.
    expect(vs[0]!.experience).toBe('between3And6');
  });

  it('без упоминания стажа в описании experience остаётся null (не выдумывает сигнал)', async () => {
    const a = new HrGeAdapter({
      fetchImpl: async (url) => {
        if (String(url).includes('announcement-search')) {
          return new Response(JSON.stringify(searchFixture), { status: 200 });
        }
        return new Response(JSON.stringify(detailFixture), { status: 200 });
      },
    });
    const vs = await a.search({ query: 'analyst', maxResults: 1 });
    expect(vs).toHaveLength(1);
    expect(vs[0]!.experience).toBeNull();
  });
});

describe('HrGeAdapter.apply', () => {
  it('возвращает failed с причиной — контракт apply ещё не снят', async () => {
    const a = new HrGeAdapter();
    const r = await a.apply(
      { sourceId: '490990', url: 'https://www.hr.ge/announcement/490990' } as never,
      'письмо',
    );
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.reason).toContain('490990');
    }
  });

  it('не делает ни одного сетевого вызова', async () => {
    let calls = 0;
    const a = new HrGeAdapter({ fetchImpl: async () => { calls++; return new Response('{}'); } });
    await a.apply({ sourceId: '1', url: 'u' } as never, 'письмо');
    expect(calls).toBe(0);
  });
});
