import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SearchQueryConfig } from './config.js';
import type { Skill, Specialty } from './specialty.js';
import {
  BA_DEFAULT_QUERIES, DEFAULT_STOP_WORDS, SYSTEM_ANALYST_DEFAULT_QUERIES,
  makeBaSpecialty, makeSystemAnalystSpecialty,
} from './specialty-defaults.js';

/**
 * Настройки поиска, которые человек правит в панели (спека 3.1): специальности
 * и стоп-слова. Лежат в data/ — вне git, рядом с queue.db. Техника, которую не
 * крутят каждый день (модели, пороги, паузы), остаётся в config.json.
 */
export interface Settings {
  version: 1;
  specialties: Specialty[];
  stopWords: string[];
}

export const SETTINGS_PATH = 'data/settings.json';

const MAX_EXPERIENCE_YEARS = 50;

type Result = { ok: true; settings: Settings } | { ok: false; error: string };

function cleanList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    const key = t.toLowerCase();
    if (t === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function nextId(prefix: string, taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const id = `${prefix}${n}`;
    if (!taken.has(id)) { taken.add(id); return id; }
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Проверяет и нормализует то, что пришло из панели или с диска. Пустые строки в
 * списках и пробелы по краям чистятся молча — это мусор от пустых полей формы,
 * а не ошибка человека. Всё остальное, что сделало бы поиск бессмысленным,
 * отклоняется с причиной по-русски: панель показывает её как есть.
 */
export function validateSettings(raw: unknown): Result {
  if (!isRecord(raw) || !Array.isArray(raw['specialties'])) {
    return { ok: false, error: 'настройки: ожидался объект со списком specialties' };
  }

  const takenSpecialtyIds = new Set<string>();
  for (const s of raw['specialties']) {
    if (isRecord(s) && typeof s['id'] === 'string' && s['id'].trim() !== '') takenSpecialtyIds.add(s['id'].trim());
  }

  const names = new Set<string>();
  const specialties: Specialty[] = [];

  for (const [i, s] of (raw['specialties'] as unknown[]).entries()) {
    const where = `специальность №${i + 1}`;
    if (!isRecord(s)) return { ok: false, error: `${where}: ожидался объект` };

    const name = typeof s['name'] === 'string' ? s['name'].trim() : '';
    if (name === '') return { ok: false, error: `${where}: пустое название` };
    const key = name.toLowerCase();
    if (names.has(key)) return { ok: false, error: `«${name}»: повтор названия` };
    names.add(key);

    const id = typeof s['id'] === 'string' && s['id'].trim() !== ''
      ? s['id'].trim()
      : nextId('s', takenSpecialtyIds);

    const titleWords = cleanList(s['titleWords']);
    if (titleWords.length === 0) {
      return { ok: false, error: `«${name}»: нужно хотя бы одно слово заголовка` };
    }

    const years = s['experienceYears'];
    if (typeof years !== 'number' || !Number.isInteger(years) || years < 0 || years > MAX_EXPERIENCE_YEARS) {
      return { ok: false, error: `«${name}»: опыт — целое число лет от 0 до ${MAX_EXPERIENCE_YEARS}` };
    }

    const resumeRaw = s['resumePdf'];
    const resumePdf = typeof resumeRaw === 'string' && resumeRaw.trim() !== '' ? resumeRaw.trim() : null;

    if (!Array.isArray(s['skills'])) return { ok: false, error: `«${name}»: ожидался список навыков` };
    const takenSkillIds = new Set<string>();
    for (const k of s['skills']) {
      if (isRecord(k) && typeof k['id'] === 'string' && k['id'].trim() !== '') takenSkillIds.add(k['id'].trim());
    }
    const skills: Skill[] = [];
    for (const [j, k] of (s['skills'] as unknown[]).entries()) {
      const at = `«${name}», навык №${j + 1}`;
      if (!isRecord(k)) return { ok: false, error: `${at}: ожидался объект` };
      const skillName = typeof k['name'] === 'string' ? k['name'].trim() : '';
      if (skillName === '') return { ok: false, error: `${at}: пустое название навыка` };
      const synonyms = cleanList(k['synonyms']);
      if (synonyms.length === 0) return { ok: false, error: `«${name}», «${skillName}»: нужен хотя бы один синоним` };
      const weight = k['weight'];
      if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 0 || weight > 100) {
        return { ok: false, error: `«${name}», «${skillName}»: вес — целое от 0 до 100` };
      }
      const skillId = typeof k['id'] === 'string' && k['id'].trim() !== ''
        ? k['id'].trim()
        : nextId('k', takenSkillIds);
      skills.push({ id: skillId, name: skillName, synonyms, weight, core: k['core'] === true });
    }

    specialties.push({
      id,
      name,
      enabled: s['enabled'] !== false,
      queries: cleanList(s['queries']),
      titleWords,
      skills,
      experienceYears: years,
      resumePdf,
      legacyLetters: s['legacyLetters'] === true,
    });
  }

  return { ok: true, settings: { version: 1, specialties, stopWords: cleanList(raw['stopWords']) } };
}

/**
 * Первый запуск: переносит то, что было в config.json и в коде. Фразы с
 * juniorOnly становятся «Системным аналитиком» с опытом 0, остальные —
 * «Бизнес-аналитиком» (спека 3.1).
 */
export function seedSettings(
  searchQueries: readonly SearchQueryConfig[] | undefined,
  baResumePdf: string | null,
): Settings {
  const baQueries = searchQueries === undefined
    ? BA_DEFAULT_QUERIES
    : searchQueries.filter((q) => q.constraints?.juniorOnly !== true).map((q) => q.query);
  const saQueries = searchQueries === undefined
    ? SYSTEM_ANALYST_DEFAULT_QUERIES
    : searchQueries.filter((q) => q.constraints?.juniorOnly === true).map((q) => q.query);
  return {
    version: 1,
    specialties: [
      makeBaSpecialty(baQueries, baResumePdf),
      makeSystemAnalystSpecialty(saQueries, baResumePdf),
    ],
    stopWords: [...DEFAULT_STOP_WORDS],
  };
}

function writeAtomic(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  // rename в пределах каталога атомарен и на NTFS: читатель видит либо
  // старый файл целиком, либо новый целиком, но не половину.
  renameSync(tmp, path);
}

export function loadSettings(path: string, seed: () => Settings): Settings {
  if (!existsSync(path)) {
    const seeded = seed();
    writeAtomic(path, seeded);
    return seeded;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    // Не пересеваем молча: пересев стёр бы настройки человека. Пусть он
    // увидит, что файл битый, и решит сам.
    throw new Error(`${path}: не читается как JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const r = validateSettings(raw);
  if (!r.ok) throw new Error(`${path}: ${r.error}`);
  return r.settings;
}

export function saveSettings(path: string, settings: unknown): Settings {
  const r = validateSettings(settings);
  if (!r.ok) throw new Error(r.error);
  writeAtomic(path, r.settings);
  return r.settings;
}

export function enabledSpecialties(s: Settings): Specialty[] {
  return s.specialties.filter((x) => x.enabled);
}
