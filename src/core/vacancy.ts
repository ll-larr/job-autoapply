/**
 * Бакеты требуемого опыта — ровно словарь hh.ru (суффикс data-qa карточки
 * выдачи вида `vacancy-serp__vacancy-work-experience-between1And3`, снят
 * прямым чтением tests/fixtures/hh-search.html: там встречаются все четыре
 * значения на 50 карточках). Источники без структурного сигнала (hr.ge)
 * матчятся в этот же словарь через разбор текста — см.
 * src/core/screening.ts#parseExperienceFromText — чтобы гейт опыта работал
 * одинаково независимо от площадки.
 */
export type ExperienceLevel = 'noExperience' | 'between1And3' | 'between3And6' | 'moreThan6';

export interface RawVacancy {
  source: string;
  sourceId: string;
  title: string;
  company: string;
  url: string;
  description: string;
  geo: string;
  postedAt: string | Date;
  salaryFrom?: number | null;
  salaryTo?: number | null;
  currency?: string | null;
  isRemote?: boolean;
  hasSponsorship?: boolean;
  /** Отсутствует у источников без структурного сигнала (hr.ge) — остаётся null. */
  experience?: ExperienceLevel | null;
  /**
   * Только у Telegram (спека 2026-09-18, 4.6): @username рекрутёра из поста,
   * без @. Ему уходит первое сообщение.
   */
  contact?: string | null;
  /** Только у Telegram (спека 4.7): хэш нормализованного текста поста — ловит репосты. */
  contentHash?: string | null;
  /** Только у Telegram: название чата, где нашёлся пост, — для карточки и письма. */
  channel?: string | null;
}

export interface Vacancy {
  source: string;
  sourceId: string;
  title: string;
  company: string;
  url: string;
  description: string;
  geo: string;
  postedAt: Date;
  salaryFrom: number | null;
  salaryTo: number | null;
  currency: string | null;
  isRemote: boolean;
  hasSponsorship: boolean;
  experience: ExperienceLevel | null;
  /** См. RawVacancy.contact: только Telegram, без @. */
  contact: string | null;
  contentHash: string | null;
  channel: string | null;
}

function clean(s: string): string {
  return s.trim().replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
}

export function normalizeVacancy(raw: RawVacancy): Vacancy {
  const sourceId = raw.sourceId.trim();
  if (sourceId === '') {
    throw new Error('normalizeVacancy: sourceId is required — без него дедупликация невозможна');
  }
  return {
    source: raw.source.trim(),
    sourceId,
    title: clean(raw.title),
    company: clean(raw.company),
    url: raw.url.trim(),
    description: clean(raw.description),
    geo: clean(raw.geo),
    postedAt: raw.postedAt instanceof Date ? raw.postedAt : new Date(raw.postedAt),
    salaryFrom: raw.salaryFrom ?? null,
    salaryTo: raw.salaryTo ?? null,
    currency: raw.currency ?? null,
    isRemote: raw.isRemote ?? false,
    hasSponsorship: raw.hasSponsorship ?? false,
    experience: raw.experience ?? null,
    contact: raw.contact == null ? null : (raw.contact.trim().replace(/^@/, '') || null),
    contentHash: raw.contentHash ?? null,
    channel: raw.channel ?? null,
  };
}

export function vacancyKey(v: Vacancy): string {
  return `${v.source}:${v.sourceId}`;
}
