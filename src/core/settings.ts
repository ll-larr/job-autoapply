import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SearchQueryConfig } from './config.js';
import type { Skill, Specialty } from './specialty.js';
import type { TgChat } from '../telegram/types.js';
import { isValidTimeZone } from '../bot/tz.js';
import {
  BA_DEFAULT_QUERIES, DEFAULT_STOP_WORDS, SYSTEM_ANALYST_DEFAULT_QUERIES,
  makeBaSpecialty, makeSystemAnalystSpecialty,
} from './specialty-defaults.js';

/**
 * Настройки поиска, которые человек правит в панели (спека 3.1): специальности
 * и стоп-слова. Лежат в data/ — вне git, рядом с queue.db. Техника, которую не
 * крутят каждый день (модели, пороги, паузы), остаётся в config.json.
 */
export type TgChatSetting = TgChat & { enabled: boolean };

/**
 * Ключ OpenRouter и модель, которой писать письма (2026-09-20). Лежит здесь, а
 * не в config.json, по двум причинам: data/ не попадает в git, а копию проекта
 * отдают другому человеку — у него свой ключ и свои предпочтения по модели, и
 * трогать ради этого config.json (который в git) ему незачем.
 */
export interface LlmSettings {
  /**
   * null — ключа в настройках нет, берётся OPENROUTER_API_KEY из окружения или
   * .env. Заданный здесь главнее окружения (см. openrouter.ts#resolveApiKey).
   */
  apiKey: string | null;
  /**
   * id модели OpenRouter, например `deepseek/deepseek-v4-flash`. null — модели
   * из config.json letterModels, как было до появления этого поля. Заданная
   * модель пробуется первой, остальные остаются запасными (core/llm.ts).
   */
  model: string | null;
}

/** Секретарь в личке рабочего аккаунта (спека 2026-10-09). Тумблер нужен, чтобы быстро выключить бота, не заходя в Telegram. */
export interface SecretarySettings {
  enabled: boolean;
}

/** Календарь секретаря — локальный, без Google: рабочие окна владельца, слоты, .ics, напоминание. */
export interface CalendarSettings {
  /** Предлагать рекрутёру слоты и проверять его время по рабочим окнам. По умолчанию выключено: без настоящих часов бот предлагал бы выдуманное время. */
  slotsEnabled: boolean;
  /** Имя IANA, например Europe/Moscow. */
  timeZone: string;
  /** ISO-дни недели 1–7, понедельник — 1. */
  workDays: number[];
  /** «ЧЧ:ММ». */
  workStart: string;
  workEnd: string;
  slotMinutes: number;
  bufferMinutes: number;
  horizonDays: number;
  minLeadHours: number;
  /** Файл .ics к пингу о собеседовании. */
  icsInPing: boolean;
  /** Второй пинг о том же собеседовании за remindMinutes минут. */
  remindEnabled: boolean;
  remindMinutes: number;
}

/** Дожимы: повторное сообщение молчащему рекрутёру с аккаунта. Выключено по умолчанию — это необратимо. */
export interface FollowupsSettings {
  enabled: boolean;
  afterDays: number;
  maxAgeDays: number;
}

/** Ящик откликов hh.ru: чтение и (отдельным тумблером) ответы работодателям. */
export interface HhInboxSettings {
  enabled: boolean;
  replyEnabled: boolean;
  intervalMinutes: number;
  maxRepliesPerDay: number;
}

export const DEFAULT_CALENDAR: CalendarSettings = {
  slotsEnabled: false,
  timeZone: 'Europe/Moscow',
  workDays: [1, 2, 3, 4, 5],
  workStart: '10:00',
  workEnd: '19:00',
  slotMinutes: 60,
  bufferMinutes: 30,
  horizonDays: 14,
  minLeadHours: 18,
  icsInPing: true,
  remindEnabled: true,
  remindMinutes: 30,
};

export interface Settings {
  version: 1;
  /**
   * Кто откликается. Имя подставляется в промпты писем, личных сообщений,
   * анкет и ответов бота (core/profile.ts). Пусто — модель говорит про
   * «кандидата» и подписи не ставит.
   */
  profile: { name: string | null };
  specialties: Specialty[];
  stopWords: string[];
  /** Каналы и группы, где искать (спека 4.4). */
  telegram: { chats: TgChatSetting[]; firstReadDays: number };
  /**
   * Автоотклик (спека 7.1). По умолчанию выключен. minScore null — общий
   * minScore из config.json, то есть уходит всё, что прошло фильтры.
   */
  autoApply: { enabled: boolean; minScore: number | null };
  /** Ключ OpenRouter и модель для писем (правятся в панели). */
  llm: LlmSettings;
  secretary: SecretarySettings;
  calendar: CalendarSettings;
  followups: FollowupsSettings;
  hhInbox: HhInboxSettings;
}

export const SETTINGS_PATH = 'data/settings.json';

/** Глубина первого чтения чата, дней (спека 4.4). */
export const DEFAULT_FIRST_READ_DAYS = 14;

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

  // Секции Telegram и автоотклика появились 2026-09-19: файл, записанный
  // раньше, их не содержит — отсутствие значит «по умолчанию», а не ошибку.
  const tgRaw = isRecord(raw['telegram']) ? raw['telegram'] : {};
  const days = tgRaw['firstReadDays'] ?? DEFAULT_FIRST_READ_DAYS;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 90) {
    return { ok: false, error: 'Telegram: глубина первого чтения — целое число дней от 1 до 90' };
  }
  const chats: TgChatSetting[] = [];
  const seenChats = new Set<string>();
  for (const [i, c] of (Array.isArray(tgRaw['chats']) ? tgRaw['chats'] as unknown[] : []).entries()) {
    if (!isRecord(c) || typeof c['id'] !== 'string' || c['id'].trim() === ''
      || typeof c['title'] !== 'string' || c['title'].trim() === '') {
      return { ok: false, error: `Telegram, чат №${i + 1}: нужны id и название` };
    }
    const id = c['id'].trim();
    if (seenChats.has(id)) continue;
    seenChats.add(id);
    chats.push({
      id,
      title: c['title'].trim(),
      username: typeof c['username'] === 'string' && c['username'].trim() !== ''
        ? c['username'].trim().replace(/^@/, '')
        : null,
      kind: c['kind'] === 'channel' ? 'channel' : 'group',
      enabled: c['enabled'] !== false,
    });
  }

  const aaRaw = isRecord(raw['autoApply']) ? raw['autoApply'] : {};
  const aaMin = aaRaw['minScore'] ?? null;
  if (aaMin !== null && (typeof aaMin !== 'number' || !Number.isInteger(aaMin) || aaMin < 0 || aaMin > 100)) {
    return { ok: false, error: 'Автоотклик: порог — целое от 0 до 100 или пусто' };
  }

  // Секция profile появилась 2026-09-20 вместе с llm; старый файл её не
  // содержит, и это значит «имя не задано», а не ошибка.
  const profileRaw = isRecord(raw['profile']) ? raw['profile'] : {};
  const personName = typeof profileRaw['name'] === 'string' ? profileRaw['name'].trim() : '';

  // Секция llm появилась 2026-09-20; файла без неё это не ломает — пусто
  // значит «ключ из .env, модели из config.json», то есть прежнее поведение.
  const llmRaw = isRecord(raw['llm']) ? raw['llm'] : {};
  const keyRaw = typeof llmRaw['apiKey'] === 'string' ? llmRaw['apiKey'].trim() : '';
  const modelRaw = typeof llmRaw['model'] === 'string' ? llmRaw['model'].trim() : '';
  // Пробел внутри id — почти наверняка вписано название модели («Claude
  // Sonnet 5») вместо её id. Молча сохранить это значит получить 400 от
  // OpenRouter на каждом письме и пустую очередь без внятной причины.
  if (/\s/.test(modelRaw)) {
    return {
      ok: false,
      error: 'Модель: нужен id модели OpenRouter без пробелов, например deepseek/deepseek-v4-flash',
    };
  }

  // Секретарь, календарь, дожимы и ящик hh появились 2026-10-09; файл без них
  // это не ломает — разделы берутся по умолчанию.
  const sec = validateSecretarySections(raw);
  if (!sec.ok) return sec;

  return {
    ok: true,
    settings: {
      version: 1,
      profile: { name: personName === '' ? null : personName },
      specialties,
      stopWords: cleanList(raw['stopWords']),
      telegram: { chats, firstReadDays: days },
      autoApply: { enabled: aaRaw['enabled'] === true, minScore: aaMin },
      llm: { apiKey: keyRaw === '' ? null : keyRaw, model: modelRaw === '' ? null : modelRaw },
      secretary: sec.secretary,
      calendar: sec.calendar,
      followups: sec.followups,
      hhInbox: sec.hhInbox,
    },
  };
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Целое из диапазона; отсутствие значения — умолчание, а не ошибка. */
function intIn(v: unknown, def: number, lo: number, hi: number): number | null {
  const x = v ?? def;
  return typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi ? x : null;
}

function validateSecretarySections(raw: Record<string, unknown>):
  | { ok: true; secretary: SecretarySettings; calendar: CalendarSettings; followups: FollowupsSettings; hhInbox: HhInboxSettings }
  | { ok: false; error: string } {
  const secRaw = isRecord(raw['secretary']) ? raw['secretary'] : {};
  const secretary: SecretarySettings = { enabled: secRaw['enabled'] !== false };

  const c = isRecord(raw['calendar']) ? raw['calendar'] : {};
  const d = DEFAULT_CALENDAR;
  const timeZone = c['timeZone'] ?? d.timeZone;
  if (!isValidTimeZone(timeZone)) return { ok: false, error: 'Календарь: часовой пояс — имя IANA, например Europe/Moscow' };
  const daysRaw = c['workDays'] ?? d.workDays;
  if (!Array.isArray(daysRaw) || daysRaw.length === 0
    || !daysRaw.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 7)
    || new Set(daysRaw).size !== daysRaw.length) {
    return { ok: false, error: 'Календарь: рабочие дни — непустой список без повторов из чисел 1–7 (понедельник — 1)' };
  }
  const workDays = [...(daysRaw as number[])].sort((a, b) => a - b);
  const workStart = c['workStart'] ?? d.workStart;
  const workEnd = c['workEnd'] ?? d.workEnd;
  if (typeof workStart !== 'string' || !HHMM.test(workStart) || typeof workEnd !== 'string' || !HHMM.test(workEnd)) {
    return { ok: false, error: 'Календарь: начало и конец рабочего дня — время вида 10:00' };
  }
  const slotMinutes = intIn(c['slotMinutes'], d.slotMinutes, 15, 240);
  if (slotMinutes === null) return { ok: false, error: 'Календарь: длительность встречи — целое число минут от 15 до 240' };
  if (minutesOf(workStart) >= minutesOf(workEnd) || minutesOf(workEnd) - minutesOf(workStart) < slotMinutes) {
    return { ok: false, error: 'Календарь: рабочий день должен быть длиннее одной встречи, начало — раньше конца' };
  }
  const bufferMinutes = intIn(c['bufferMinutes'], d.bufferMinutes, 0, 120);
  if (bufferMinutes === null) return { ok: false, error: 'Календарь: отступ между встречами — целое число минут от 0 до 120' };
  const horizonDays = intIn(c['horizonDays'], d.horizonDays, 1, 60);
  if (horizonDays === null) return { ok: false, error: 'Календарь: горизонт — целое число дней от 1 до 60' };
  const minLeadHours = intIn(c['minLeadHours'], d.minLeadHours, 0, 168);
  if (minLeadHours === null) return { ok: false, error: 'Календарь: запас до встречи — целое число часов от 0 до 168' };
  const remindMinutes = intIn(c['remindMinutes'], d.remindMinutes, 5, 1440);
  if (remindMinutes === null) return { ok: false, error: 'Календарь: напоминание — целое число минут от 5 до 1440' };
  const calendar: CalendarSettings = {
    slotsEnabled: c['slotsEnabled'] === true,
    timeZone, workDays, workStart, workEnd, slotMinutes, bufferMinutes, horizonDays, minLeadHours,
    icsInPing: c['icsInPing'] !== false,
    remindEnabled: c['remindEnabled'] !== false,
    remindMinutes,
  };

  const f = isRecord(raw['followups']) ? raw['followups'] : {};
  const afterDays = intIn(f['afterDays'], 4, 1, 30);
  if (afterDays === null) return { ok: false, error: 'Дожимы: через сколько дней молчания — целое число от 1 до 30' };
  const maxAgeDays = intIn(f['maxAgeDays'], Math.max(14, afterDays), afterDays, 60);
  if (maxAgeDays === null) return { ok: false, error: `Дожимы: давность сообщения — целое число дней от ${afterDays} до 60` };
  const followups: FollowupsSettings = { enabled: f['enabled'] === true, afterDays, maxAgeDays };

  const h = isRecord(raw['hhInbox']) ? raw['hhInbox'] : {};
  const intervalMinutes = intIn(h['intervalMinutes'], 30, 10, 1440);
  if (intervalMinutes === null) return { ok: false, error: 'Ящик hh.ru: интервал проверки — целое число минут от 10 до 1440' };
  const maxRepliesPerDay = intIn(h['maxRepliesPerDay'], 20, 1, 100);
  if (maxRepliesPerDay === null) return { ok: false, error: 'Ящик hh.ru: ответов в сутки — целое число от 1 до 100' };
  const hhEnabled = h['enabled'] === true;
  const replyEnabled = h['replyEnabled'] === true;
  if (replyEnabled && !hhEnabled) {
    return { ok: false, error: 'Ответы на hh.ru работают только при включённом чтении ящика' };
  }
  const hhInbox: HhInboxSettings = { enabled: hhEnabled, replyEnabled, intervalMinutes, maxRepliesPerDay };

  return { ok: true, secretary, calendar, followups, hhInbox };
}

/**
 * Страница, открытая до обновления, не знает новых разделов и при сохранении
 * прислала бы настройки без них — они вернулись бы к умолчаниям (тумблеры
 * дожимов и ответов hh молча выключились бы). Недостающие верхние разделы
 * берутся из текущих настроек.
 */
export function mergeMissingSections(current: Settings, raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };
  for (const key of ['profile', 'telegram', 'autoApply', 'llm', 'secretary', 'calendar', 'followups', 'hhInbox'] as const) {
    if (out[key] === undefined) out[key] = current[key];
  }
  return out;
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
    profile: { name: null },
    specialties: [
      makeBaSpecialty(baQueries, baResumePdf),
      makeSystemAnalystSpecialty(saQueries, baResumePdf),
    ],
    stopWords: [...DEFAULT_STOP_WORDS],
    telegram: { chats: [], firstReadDays: DEFAULT_FIRST_READ_DAYS },
    autoApply: { enabled: false, minScore: null },
    llm: { apiKey: null, model: null },
    secretary: { enabled: true },
    calendar: { ...DEFAULT_CALENDAR, workDays: [...DEFAULT_CALENDAR.workDays] },
    followups: { enabled: false, afterDays: 4, maxAgeDays: 14 },
    hhInbox: { enabled: false, replyEnabled: false, intervalMinutes: 30, maxRepliesPerDay: 20 },
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
