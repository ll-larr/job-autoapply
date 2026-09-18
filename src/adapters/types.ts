import type { Vacancy } from '../core/vacancy.js';

export interface SearchFilters {
  query: string;
  geo?: string;
  remoteOnly?: boolean;
  maxResults?: number;
  /**
   * Vacancy keys (see vacancyKey in core/vacancy.ts — "source:sourceId")
   * already processed earlier in THIS run, by any query phrasing tried so
   * far. Set by the pipeline (src/pipeline.ts), which accumulates it across
   * calls to every adapter/query pair in the run.
   *
   * An adapter that fetches a vacancy's full page/description as a separate,
   * costly step (hh.ru: a browser navigation per vacancy) SHOULD skip that
   * step for ids already in this set — five configured query phrasings
   * finding the same vacancy would otherwise open its page five times, with
   * four of those five reads discarded as duplicates by the pipeline anyway.
   *
   * Optional and adapter-respected on a best-effort basis: an adapter that
   * ignores it is still correct, just less bandwidth/time-frugal. hr.ge
   * currently ignores it — its per-item cost is one cheap HTTP call already
   * budgeted by maxResults, not a browser page open.
   */
  seenThisRun?: ReadonlySet<string>;
  /**
   * How many raw result cards to step over before collecting. Pagination,
   * expressed as an offset rather than a page number so the caller does not
   * have to know each site's page size.
   *
   * The pipeline searches in batches now — it asks for a slice, filters it,
   * and comes back for the next slice only if the run still needs more
   * vacancies (see runSearch: the user asks for N vacancies DELIVERED, not N
   * cards read, so how deep the listing has to be walked is not knowable in
   * advance). `skip` is what makes the next call continue instead of
   * re-reading the same first page.
   *
   * An adapter that ignores it stays correct but will hand the pipeline the
   * same cards on every batch, which the run-level dedupe then discards — so
   * the run would stall rather than break. Both current adapters honour it.
   */
  skip?: number;
  /**
   * «Мой опыт, лет» специальности, по которой идёт этот запрос (спека
   * 2026-09-18, 3.4). Адаптер, который отсеивает по опыту до дочитки описания
   * (hh.ru), обязан брать порог отсюда, а не из общего значения: иначе запрос
   * системного аналитика (опыт 0) пропускал бы «1–3 года». undefined — порог по
   * умолчанию, DEFAULT_EXPERIENCE_YEARS.
   */
  experienceYears?: number;
}

export type ApplyResult =
  | { status: 'sent' }
  | { status: 'already_applied' }
  | { status: 'captcha' }
  | { status: 'auth_required' }
  | { status: 'failed'; reason: string };

export interface Adapter {
  readonly name: string;
  search(filters: SearchFilters): Promise<Vacancy[]>;
  apply(vacancy: Vacancy, letter: string): Promise<ApplyResult>;
}

/**
 * captcha и auth_required требуют человека. Всё остальное — обычный исход
 * одной подачи, очередь продолжает работу.
 */
export function isHaltingResult(r: ApplyResult): boolean {
  return r.status === 'captcha' || r.status === 'auth_required';
}
