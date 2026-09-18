import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateSettings, seedSettings, loadSettings, saveSettings, enabledSpecialties, type Settings,
} from '../src/core/settings.js';
import { BA_SPECIALTY_ID, SYSTEM_ANALYST_SPECIALTY_ID, BA_SKILLS } from '../src/core/specialty-defaults.js';

const CONFIG_QUERIES = [
  { query: 'аналитик бизнес-процессов' },
  { query: 'бизнес-аналитик' },
  { query: 'системный аналитик', constraints: { juniorOnly: true } },
];

function tmp(): string {
  return join(mkdtempSync(join(tmpdir(), 'jaa-settings-')), 'settings.json');
}

describe('seedSettings', () => {
  it('фразы без juniorOnly — БА, с juniorOnly — системный аналитик с опытом 0', () => {
    const s = seedSettings(CONFIG_QUERIES, '/cv.pdf');
    const [ba, sa] = s.specialties;
    expect(ba!.id).toBe(BA_SPECIALTY_ID);
    expect(ba!.queries).toEqual(['аналитик бизнес-процессов', 'бизнес-аналитик']);
    expect(ba!.experienceYears).toBe(2);
    expect(ba!.resumePdf).toBe('/cv.pdf');
    expect(ba!.legacyLetters).toBe(true);
    expect(sa!.id).toBe(SYSTEM_ANALYST_SPECIALTY_ID);
    expect(sa!.queries).toEqual(['системный аналитик']);
    expect(sa!.experienceYears).toBe(0);
    expect(sa!.skills).toEqual(ba!.skills);
  });

  it('без searchQueries в config — фразы по умолчанию', () => {
    const s = seedSettings(undefined, null);
    expect(s.specialties[0]!.queries.length).toBeGreaterThan(0);
    expect(s.specialties[1]!.queries).toEqual(['системный аналитик']);
  });

  it('стоп-слова — 1С и Битрикс', () => {
    expect(seedSettings(undefined, null).stopWords).toEqual(['1С', 'Битрикс', 'Bitrix']);
  });

  it('засев проходит собственную валидацию', () => {
    expect(validateSettings(seedSettings(CONFIG_QUERIES, null)).ok).toBe(true);
  });
});

describe('validateSettings', () => {
  function base(): Settings {
    return seedSettings(CONFIG_QUERIES, null);
  }

  it('чистит пробелы и пустые строки в списках', () => {
    const s = base();
    s.specialties[0]!.queries = ['  бизнес-аналитик ', '', '   '];
    s.stopWords = [' 1С ', '', '1с'];
    const r = validateSettings(s);
    expect(r.ok && r.settings.specialties[0]!.queries).toEqual(['бизнес-аналитик']);
    // дубль без учёта регистра выкидывается
    expect(r.ok && r.settings.stopWords).toEqual(['1С']);
  });

  it.each([
    ['пустое название', (s: Settings) => { s.specialties[0]!.name = '  '; }, /название/],
    ['повтор названия', (s: Settings) => { s.specialties[1]!.name = 'бизнес-аналитик'; }, /повтор/],
    ['нет слов заголовка', (s: Settings) => { s.specialties[0]!.titleWords = ['']; }, /слов[оа] заголовка/],
    ['вес больше 100', (s: Settings) => { s.specialties[0]!.skills[0]!.weight = 101; }, /вес/],
    ['дробный вес', (s: Settings) => { s.specialties[0]!.skills[0]!.weight = 2.5; }, /вес/],
    ['навык без синонимов', (s: Settings) => { s.specialties[0]!.skills[0]!.synonyms = [' ']; }, /синоним/],
    ['опыт -1', (s: Settings) => { s.specialties[0]!.experienceYears = -1; }, /опыт/],
    ['опыт дробный', (s: Settings) => { s.specialties[0]!.experienceYears = 1.5; }, /опыт/],
  ])('отклоняет: %s', (_label, mutate, message) => {
    const s = base();
    mutate(s);
    const r = validateSettings(s);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(message);
  });

  it('новой специальности и новому навыку выдаёт id', () => {
    const s = base() as unknown as { specialties: Array<Record<string, unknown>> };
    s.specialties.push({
      name: 'Менеджер продукта', enabled: true, queries: ['product manager'], titleWords: ['продакт'],
      skills: [{ name: 'Роадмап', synonyms: ['роадмап'], weight: 20, core: true }],
      experienceYears: 1, resumePdf: null,
    });
    const r = validateSettings(s);
    expect(r.ok).toBe(true);
    const added = r.ok ? r.settings.specialties[2]! : undefined;
    expect(added!.id).toMatch(/^s\d+$/);
    expect(added!.skills[0]!.id).toMatch(/^k\d+$/);
    expect(added!.legacyLetters).toBe(false);
  });

  it('не ломает id и порядок навыков БА', () => {
    const r = validateSettings(base());
    expect(r.ok && r.settings.specialties[0]!.skills.map((k) => k.id)).toEqual(BA_SKILLS.map((k) => k.id));
  });

  it('мусор вместо объекта — понятная ошибка, не исключение', () => {
    expect(validateSettings(null).ok).toBe(false);
    expect(validateSettings({ specialties: 'нет' }).ok).toBe(false);
  });
});

describe('loadSettings / saveSettings', () => {
  it('нет файла — засевает и записывает', () => {
    const path = tmp();
    const s = loadSettings(path, () => seedSettings(CONFIG_QUERIES, null));
    expect(s.specialties).toHaveLength(2);
    expect(existsSync(path)).toBe(true);
  });

  it('битый файл — ошибка с путём, а не молчаливый пересев', () => {
    const path = tmp();
    writeFileSync(path, '{ нет', 'utf8');
    expect(() => loadSettings(path, () => seedSettings(undefined, null))).toThrow(path);
    expect(readFileSync(path, 'utf8')).toBe('{ нет');
  });

  it('сохранение отклоняет плохое и не трогает файл', () => {
    const path = tmp();
    const s = loadSettings(path, () => seedSettings(undefined, null));
    const before = readFileSync(path, 'utf8');
    const bad = structuredClone(s);
    bad.specialties[0]!.name = '';
    expect(() => saveSettings(path, bad)).toThrow(/название/);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('сохранение атомарное: временных файлов не остаётся, прочитанное совпадает', () => {
    const path = tmp();
    const s = loadSettings(path, () => seedSettings(undefined, null));
    s.specialties[0]!.skills[0]!.weight = 30;
    saveSettings(path, s);
    expect(readdirSync(join(path, '..'))).toEqual(['settings.json']);
    expect(loadSettings(path, () => { throw new Error('не должен засевать'); }).specialties[0]!.skills[0]!.weight).toBe(30);
  });
});

describe('enabledSpecialties', () => {
  it('только включённые, в порядке настроек', () => {
    const s = seedSettings(CONFIG_QUERIES, null);
    s.specialties[0]!.enabled = false;
    expect(enabledSpecialties(s).map((x) => x.id)).toEqual([SYSTEM_ANALYST_SPECIALTY_ID]);
  });
});
