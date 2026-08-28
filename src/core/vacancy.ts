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
  };
}

export function vacancyKey(v: Vacancy): string {
  return `${v.source}:${v.sourceId}`;
}
