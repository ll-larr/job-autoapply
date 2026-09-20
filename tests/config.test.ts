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

  // Регрессия: rule.minDelayMs > rule.maxDelayMs при обоих undefined —
  // `undefined > undefined` — это false, а не true, так что {"hh": {}}
  // раньше молча проходило валидацию. В sender.ts это оборачивается
  // NaN-задержкой (span = undefined - undefined = NaN), а setTimeout(NaN)
  // срабатывает немедленно — заявки на площадку идут без единой паузы.
  // Ровно то, ради чего в sender.ts существует "Fail closed": отсутствующая
  // ЗАПИСЬ про площадку блокирует отправку, а пустая запись не должна была
  // тихо снимать защиту.
  it('бросает на пустой записи throttle (нет ни minDelayMs, ни maxDelayMs)', () => {
    const p = withConfig({
      minScore: 40, letterFullThreshold: 75, letterModels: LETTER_MODELS,
      searchQueries: SEARCH_QUERIES,
      throttle: { hh: {} },
    });
    expect(() => loadConfig(p)).toThrow('minDelayMs');
  });

  it('бросает, если задан только maxDelayMs, а minDelayMs отсутствует', () => {
    const p = withConfig({
      minScore: 40, letterFullThreshold: 75, letterModels: LETTER_MODELS,
      searchQueries: SEARCH_QUERIES,
      throttle: { hh: { maxDelayMs: 5000 } },
    });
    expect(() => loadConfig(p)).toThrow('minDelayMs');
  });

  it('бросает, если minDelayMs/maxDelayMs не числа (например, строки)', () => {
    const p = withConfig({
      minScore: 40, letterFullThreshold: 75, letterModels: LETTER_MODELS,
      searchQueries: SEARCH_QUERIES,
      throttle: { hh: { minDelayMs: '1000', maxDelayMs: '2000' } },
    });
    expect(() => loadConfig(p)).toThrow('minDelayMs');
  });

  it('бросает, если minDelayMs отрицательный', () => {
    const p = withConfig({
      minScore: 40, letterFullThreshold: 75, letterModels: LETTER_MODELS,
      searchQueries: SEARCH_QUERIES,
      throttle: { hh: { minDelayMs: -1, maxDelayMs: 1000 } },
    });
    expect(() => loadConfig(p)).toThrow('minDelayMs');
  });

  it('minDelayMs === maxDelayMs === 0 — легально (фиксированная нулевая пауза, не "без правила")', () => {
    const p = withConfig({
      minScore: 40, letterFullThreshold: 75, letterModels: LETTER_MODELS,
      searchQueries: SEARCH_QUERIES,
      throttle: { hh: { minDelayMs: 0, maxDelayMs: 0 } },
    });
    expect(() => loadConfig(p)).not.toThrow();
  });

  it('бросает, если maxPerHour задан, но не положительное конечное число', () => {
    for (const bad of [0, -5, Infinity, NaN]) {
      const p = withConfig({
        minScore: 40, letterFullThreshold: 75, letterModels: LETTER_MODELS,
        searchQueries: SEARCH_QUERIES,
        throttle: { hh: { minDelayMs: 0, maxDelayMs: 0, maxPerHour: bad } },
      });
      expect(() => loadConfig(p)).toThrow('maxPerHour');
    }
  });

  it('бросает, если maxPerDay задан, но не положительное конечное число', () => {
    const p = withConfig({
      minScore: 40, letterFullThreshold: 75, letterModels: LETTER_MODELS,
      searchQueries: SEARCH_QUERIES,
      throttle: { hh: { minDelayMs: 0, maxDelayMs: 0, maxPerDay: 0 } },
    });
    expect(() => loadConfig(p)).toThrow('maxPerDay');
  });

  it('отсутствие maxPerHour/maxPerDay по-прежнему легально — это "без ограничения", а не ошибка', () => {
    const p = withConfig({
      minScore: 40, letterFullThreshold: 75, letterModels: LETTER_MODELS,
      searchQueries: SEARCH_QUERIES,
      throttle: { hh: { minDelayMs: 0, maxDelayMs: 0 } },
    });
    expect(() => loadConfig(p)).not.toThrow();
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
    it('searchQueries необязателен: фразы живут в data/settings.json', () => {
      const withoutQueries = withConfig({
        minScore: 40, letterFullThreshold: 75, letterModels: LETTER_MODELS, throttle: {},
      });
      expect(loadConfig(withoutQueries).searchQueries).toBeUndefined();
    });

    it('бросает, если searchQueries задан не списком', () => {
      const p = withConfig({
        minScore: 40, letterFullThreshold: 75, letterModels: LETTER_MODELS,
        searchQueries: 'бизнес', throttle: {},
      });
      expect(() => loadConfig(p)).toThrow('searchQueries');
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
