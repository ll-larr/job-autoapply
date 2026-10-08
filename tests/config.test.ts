import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadConfig, resolveGigarecruiterConfig, DEFAULT_GIGARECRUITER, type Config, type GigarecruiterConfig,
} from '../src/core/config.js';

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
      letterModels: LETTER_MODELS,
      searchQueries: SEARCH_QUERIES,
      throttle: { hh: { maxPerHour: 10, maxPerDay: 40, minDelayMs: 20000, maxDelayMs: 90000 } },
    });
    const c = loadConfig(p);
    expect(c.minScore).toBe(40);
    expect(c.letterModels).toEqual(LETTER_MODELS);
    expect(c.throttle.hh?.maxPerDay).toBe(40);
  });

  it('бросает, если minDelayMs больше maxDelayMs', () => {
    const p = withConfig({
      minScore: 40, letterModels: LETTER_MODELS,
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
      minScore: 40, letterModels: LETTER_MODELS,
      searchQueries: SEARCH_QUERIES,
      throttle: { hh: {} },
    });
    expect(() => loadConfig(p)).toThrow('minDelayMs');
  });

  it('бросает, если задан только maxDelayMs, а minDelayMs отсутствует', () => {
    const p = withConfig({
      minScore: 40, letterModels: LETTER_MODELS,
      searchQueries: SEARCH_QUERIES,
      throttle: { hh: { maxDelayMs: 5000 } },
    });
    expect(() => loadConfig(p)).toThrow('minDelayMs');
  });

  it('бросает, если minDelayMs/maxDelayMs не числа (например, строки)', () => {
    const p = withConfig({
      minScore: 40, letterModels: LETTER_MODELS,
      searchQueries: SEARCH_QUERIES,
      throttle: { hh: { minDelayMs: '1000', maxDelayMs: '2000' } },
    });
    expect(() => loadConfig(p)).toThrow('minDelayMs');
  });

  it('бросает, если minDelayMs отрицательный', () => {
    const p = withConfig({
      minScore: 40, letterModels: LETTER_MODELS,
      searchQueries: SEARCH_QUERIES,
      throttle: { hh: { minDelayMs: -1, maxDelayMs: 1000 } },
    });
    expect(() => loadConfig(p)).toThrow('minDelayMs');
  });

  it('minDelayMs === maxDelayMs === 0 — легально (фиксированная нулевая пауза, не "без правила")', () => {
    const p = withConfig({
      minScore: 40, letterModels: LETTER_MODELS,
      searchQueries: SEARCH_QUERIES,
      throttle: { hh: { minDelayMs: 0, maxDelayMs: 0 } },
    });
    expect(() => loadConfig(p)).not.toThrow();
  });

  it('бросает, если maxPerHour задан, но не положительное конечное число', () => {
    for (const bad of [0, -5, Infinity, NaN]) {
      const p = withConfig({
        minScore: 40, letterModels: LETTER_MODELS,
        searchQueries: SEARCH_QUERIES,
        throttle: { hh: { minDelayMs: 0, maxDelayMs: 0, maxPerHour: bad } },
      });
      expect(() => loadConfig(p)).toThrow('maxPerHour');
    }
  });

  it('бросает, если maxPerDay задан, но не положительное конечное число', () => {
    const p = withConfig({
      minScore: 40, letterModels: LETTER_MODELS,
      searchQueries: SEARCH_QUERIES,
      throttle: { hh: { minDelayMs: 0, maxDelayMs: 0, maxPerDay: 0 } },
    });
    expect(() => loadConfig(p)).toThrow('maxPerDay');
  });

  it('отсутствие maxPerHour/maxPerDay по-прежнему легально — это "без ограничения", а не ошибка', () => {
    const p = withConfig({
      minScore: 40, letterModels: LETTER_MODELS,
      searchQueries: SEARCH_QUERIES,
      throttle: { hh: { minDelayMs: 0, maxDelayMs: 0 } },
    });
    expect(() => loadConfig(p)).not.toThrow();
  });

  it('бросает, если letterModels отсутствует или пуст — пробовать нечего', () => {
    const withoutModels = withConfig({
      minScore: 40, searchQueries: SEARCH_QUERIES, throttle: {},
    });
    expect(() => loadConfig(withoutModels)).toThrow('letterModels');

    const emptyModels = withConfig({
      minScore: 40, letterModels: [],
      searchQueries: SEARCH_QUERIES, throttle: {},
    });
    expect(() => loadConfig(emptyModels)).toThrow('letterModels');
  });

  describe('searchQueries', () => {
    it('searchQueries необязателен: фразы живут в data/settings.json', () => {
      const withoutQueries = withConfig({
        minScore: 40, letterModels: LETTER_MODELS, throttle: {},
      });
      expect(loadConfig(withoutQueries).searchQueries).toBeUndefined();
    });

    it('бросает, если searchQueries задан не списком', () => {
      const p = withConfig({
        minScore: 40, letterModels: LETTER_MODELS,
        searchQueries: 'бизнес', throttle: {},
      });
      expect(() => loadConfig(p)).toThrow('searchQueries');
    });

    it('бросает на записи без непустого query', () => {
      const p = withConfig({
        minScore: 40, letterModels: LETTER_MODELS,
        searchQueries: [{ query: 'ок' }, { query: '   ' }], throttle: {},
      });
      expect(() => loadConfig(p)).toThrow('searchQueries[1].query');
    });

    it('бросает, если constraints.juniorOnly не boolean', () => {
      const p = withConfig({
        minScore: 40, letterModels: LETTER_MODELS,
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
        minScore: 40, letterModels: LETTER_MODELS,
        searchQueries: queries, throttle: {},
      });
      const c = loadConfig(p);
      expect(c.searchQueries).toEqual(queries);
    });
  });
});

describe('resolveGigarecruiterConfig', () => {
  const base = (g?: unknown): Config => ({
    minScore: 40, letterModels: ['m1'], throttle: {},
    ...(g === undefined ? {} : { gigarecruiter: g as GigarecruiterConfig }),
  });
  const minimal = { username: 'Giga_recruiter_bot' };

  it('без блока — внятная ошибка, команда не запускается', () => {
    expect(() => resolveGigarecruiterConfig(base())).toThrow(/config\.json.*gigarecruiter/);
  });

  it('недостающие поля добираются умолчаниями, models не задан', () => {
    const r = resolveGigarecruiterConfig(base(minimal));
    expect(r).toEqual({ ...DEFAULT_GIGARECRUITER, ...minimal });
    expect(r.maxRepliesPerSession).toBe(12);
    expect(r.models).toBeUndefined();
  });

  it('VPN по умолчанию — служба HappService и GUI D:\\Happ\\Happ.exe (FU-2)', () => {
    const r = resolveGigarecruiterConfig(base(minimal));
    expect(r.vpnService).toBe('HappService');
    expect(r.vpnApp).toBe('D:\\Happ\\Happ.exe');
    expect(DEFAULT_GIGARECRUITER.vpnService).toBe('HappService');
    expect(DEFAULT_GIGARECRUITER.vpnApp).toBe('D:\\Happ\\Happ.exe');
  });

  it('vpnService и vpnApp из блока перекрывают умолчания', () => {
    const r = resolveGigarecruiterConfig(base({ ...minimal, vpnService: 'OtherVpn', vpnApp: 'C:\\Other\\Gui.exe' }));
    expect(r.vpnService).toBe('OtherVpn');
    expect(r.vpnApp).toBe('C:\\Other\\Gui.exe');
  });

  it('пустой или нестроковый username, vpnService, vpnApp — отказ', () => {
    expect(() => resolveGigarecruiterConfig(base({ ...minimal, username: ' ' }))).toThrow(/username/);
    expect(() => resolveGigarecruiterConfig(base({ ...minimal, vpnService: '' }))).toThrow(/vpnService/);
    expect(() => resolveGigarecruiterConfig(base({ ...minimal, vpnService: 5 }))).toThrow(/vpnService/);
    expect(() => resolveGigarecruiterConfig(base({ ...minimal, vpnApp: ' ' }))).toThrow(/vpnApp/);
    expect(() => resolveGigarecruiterConfig(base({ ...minimal, vpnApp: null }))).toThrow(/vpnApp/);
  });

  it('число строкой, ноль или NaN — отказ: иначе цикл никогда не гаснет', () => {
    expect(() => resolveGigarecruiterConfig(base({ ...minimal, idleMinutes: '10' }))).toThrow(/idleMinutes/);
    expect(() => resolveGigarecruiterConfig(base({ ...minimal, windowMinutes: 0 }))).toThrow(/windowMinutes/);
    expect(() => resolveGigarecruiterConfig(base({ ...minimal, maxReplyLength: null }))).toThrow(/maxReplyLength/);
    expect(() => resolveGigarecruiterConfig(base({ ...minimal, maxRepliesPerSession: 0 }))).toThrow(/maxRepliesPerSession/);
    expect(() => resolveGigarecruiterConfig(base({ ...minimal, maxRepliesPerSession: '12' }))).toThrow(/maxRepliesPerSession/);
  });

  it('replyDelaySec — пара неотрицательных чисел, минимум не больше максимума', () => {
    expect(() => resolveGigarecruiterConfig(base({ ...minimal, replyDelaySec: [120, 40] }))).toThrow(/replyDelaySec/);
    expect(() => resolveGigarecruiterConfig(base({ ...minimal, replyDelaySec: [40] }))).toThrow(/replyDelaySec/);
    expect(resolveGigarecruiterConfig(base({ ...minimal, replyDelaySec: [0, 0] })).replyDelaySec).toEqual([0, 0]);
  });

  it('сессия интервью по умолчанию — отдельный файл личного аккаунта, не рабочая сессия (G1)', () => {
    const r = resolveGigarecruiterConfig(base(minimal));
    expect(r.sessionPath).toBe('data/telegram-interview.session');
    expect(DEFAULT_GIGARECRUITER.sessionPath).toBe('data/telegram-interview.session');
    expect(r.sessionPath).not.toBe('data/telegram.session');
  });

  it('sessionPath из блока перекрывает умолчание; пустой или нестроковый — отказ (G1)', () => {
    expect(resolveGigarecruiterConfig(base({ ...minimal, sessionPath: 'D:\\tg\\personal.session' })).sessionPath)
      .toBe('D:\\tg\\personal.session');
    expect(() => resolveGigarecruiterConfig(base({ ...minimal, sessionPath: ' ' }))).toThrow(/sessionPath/);
    expect(() => resolveGigarecruiterConfig(base({ ...minimal, sessionPath: 5 }))).toThrow(/sessionPath/);
    expect(() => resolveGigarecruiterConfig(base({ ...minimal, sessionPath: null }))).toThrow(/sessionPath/);
  });

  it('sessionPath, ведущий в рабочую сессию data/telegram.session, — отказ в любом написании (M5)', () => {
    for (const p of ['data/telegram.session', './data/telegram.session', 'data\\telegram.session', 'Data/Telegram.session',
      resolve('data/telegram.session')]) {
      expect(() => resolveGigarecruiterConfig(base({ ...minimal, sessionPath: p }))).toThrow(/sessionPath.*рабоч/);
    }
    expect(resolveGigarecruiterConfig(base({ ...minimal, sessionPath: 'data/other.session' })).sessionPath).toBe('data/other.session');
  });

  it('потолок интервью за окно — 6 по умолчанию; из блока перекрывается; ноль, строка, NaN — отказ (C2)', () => {
    expect(resolveGigarecruiterConfig(base(minimal)).maxInterviewsPerWindow).toBe(6);
    expect(DEFAULT_GIGARECRUITER.maxInterviewsPerWindow).toBe(6);
    expect(resolveGigarecruiterConfig(base({ ...minimal, maxInterviewsPerWindow: 3 })).maxInterviewsPerWindow).toBe(3);
    for (const bad of [0, -1, '6', null, Number.NaN]) {
      expect(() => resolveGigarecruiterConfig(base({ ...minimal, maxInterviewsPerWindow: bad }))).toThrow(/maxInterviewsPerWindow/);
    }
  });

  it('пустой models — как незаданный, кривой — отказ', () => {
    expect(resolveGigarecruiterConfig(base({ ...minimal, models: [] })).models).toBeUndefined();
    expect(resolveGigarecruiterConfig(base({ ...minimal, models: ['x/y'] })).models).toEqual(['x/y']);
    expect(() => resolveGigarecruiterConfig(base({ ...minimal, models: [''] }))).toThrow(/models/);
  });

  it('config.json в репозитории содержит рабочий блок gigarecruiter', () => {
    const c = JSON.parse(readFileSync('config.json', 'utf8')) as Config;
    const r = resolveGigarecruiterConfig(c);
    expect(r.username).toBe('Giga_recruiter_bot');
    expect(r.vpnService).toBe('HappService');
    expect(r.vpnApp).toBe('D:\\Happ\\Happ.exe');
    expect(c.gigarecruiter).not.toHaveProperty('vpnExe');
    expect(r.windowMinutes).toBe(120);
    expect(r.idleMinutes).toBe(10);
    expect(c.gigarecruiter?.maxRepliesPerSession).toBe(12);
    expect(c.gigarecruiter?.sessionPath).toBe('data/telegram-interview.session');
    expect(c.gigarecruiter?.maxInterviewsPerWindow).toBe(6);
  });

  it('loadConfig принимает config.json с новым блоком', () => {
    expect(loadConfig('config.json').gigarecruiter?.username).toBe('Giga_recruiter_bot');
  });
});
