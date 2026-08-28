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
  it('достаёт текст описания из настоящего ответа детали', () => {
    const text = parseDetailResponse(detailFixture);
    expect(text.length).toBeGreaterThan(50);
  });

  it('на мусорном входе возвращает пустую строку', () => {
    expect(parseDetailResponse(null)).toBe('');
    expect(parseDetailResponse({})).toBe('');
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

  it('на ошибке поиска возвращает пустой массив', async () => {
    const a = new HrGeAdapter({
      fetchImpl: async () => new Response('boom', { status: 500 }),
    });
    expect(await a.search({ query: 'analyst' })).toEqual([]);
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
