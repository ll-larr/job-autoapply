import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/core/config.js';

function withConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'jaa-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify(obj), 'utf8');
  return p;
}

const LETTER_MODELS = ['model-a:free', 'model-b:free'];
const SEARCH_QUERIES = [{ query: 'бизнес-аналитик' }];

describe('loadConfig', () => {
  it('читает пороги и лимиты', () => {
    const p = withConfig({
      minScore: 40,
      letterFullThreshold: 75,
      letterModels: LETTER_MODELS,
      searchQueries: SEARCH_QUERIES,
      throttle: { hh: { maxPerHour: 10, maxPerDay: 40, minDelayMs: 20000, maxDelayMs: 90000 } },
    });
    const c = loadConfig(p);
    expect(c.minScore).toBe(40);
    expect(c.letterFullThreshold).toBe(75);
    expect(c.letterModels).toEqual(LETTER_MODELS);
    expect(c.throttle.hh?.maxPerDay).toBe(40);
  });

  it('бросает, если letterFullThreshold ниже minScore — такая пара бессмысленна', () => {
    const p = withConfig({
      minScore: 80, letterFullThreshold: 50, letterModels: LETTER_MODELS,
      searchQueries: SEARCH_QUERIES, throttle: {},
    });
    expect(() => loadConfig(p)).toThrow('letterFullThreshold');
  });

  it('бросает, если minDelayMs больше maxDelayMs', () => {
    const p = withConfig({
      minScore: 40, letterFullThreshold: 75, letterModels: LETTER_MODELS,
      searchQueries: SEARCH_QUERIES,
      throttle: { hh: { maxPerHour: 10, maxPerDay: 40, minDelayMs: 90000, maxDelayMs: 20000 } },
    });
    expect(() => loadConfig(p)).toThrow('minDelayMs');
  });

  it('бросает, если letterModels отсутствует или пуст — пробовать нечего', () => {
    const withoutModels = withConfig({
      minScore: 40, letterFullThreshold: 75, searchQueries: SEARCH_QUERIES, throttle: {},
    });
    expect(() => loadConfig(withoutModels)).toThrow('letterModels');

    const emptyModels = withConfig({
      minScore: 40, letterFullThreshold: 75, letterModels: [],
      searchQueries: SEARCH_QUERIES, throttle: {},
    });
    expect(() => loadConfig(emptyModels)).toThrow('letterModels');
  });

  describe('searchQueries', () => {
    it('бросает, если searchQueries отсутствует или пуст — search без аргумента не с чем запускать', () => {
      const withoutQueries = withConfig({
        minScore: 40, letterFullThreshold: 75, letterModels: LETTER_MODELS, throttle: {},
      });
      expect(() => loadConfig(withoutQueries)).toThrow('searchQueries');

      const emptyQueries = withConfig({
        minScore: 40, letterFullThreshold: 75, letterModels: LETTER_MODELS,
        searchQueries: [], throttle: {},
      });
      expect(() => loadConfig(emptyQueries)).toThrow('searchQueries');
    });

    it('бросает на записи без непустого query', () => {
      const p = withConfig({
        minScore: 40, letterFullThreshold: 75, letterModels: LETTER_MODELS,
        searchQueries: [{ query: 'ок' }, { query: '   ' }], throttle: {},
      });
      expect(() => loadConfig(p)).toThrow('searchQueries[1].query');
    });

    it('бросает, если constraints.juniorOnly не boolean', () => {
      const p = withConfig({
        minScore: 40, letterFullThreshold: 75, letterModels: LETTER_MODELS,
        searchQueries: [{ query: 'системный аналитик', constraints: { juniorOnly: 'да' } }],
        throttle: {},
      });
      expect(() => loadConfig(p)).toThrow('juniorOnly');
    });

    it('читает несколько запросов, часть — с constraints.juniorOnly', () => {
      const queries = [
        { query: 'бизнес-аналитик' },
        { query: 'системный аналитик', constraints: { juniorOnly: true } },
      ];
      const p = withConfig({
        minScore: 40, letterFullThreshold: 75, letterModels: LETTER_MODELS,
        searchQueries: queries, throttle: {},
      });
      const c = loadConfig(p);
      expect(c.searchQueries).toEqual(queries);
    });
  });
});
