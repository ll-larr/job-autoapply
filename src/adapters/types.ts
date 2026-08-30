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
