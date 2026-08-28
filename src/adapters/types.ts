import type { Vacancy } from '../core/vacancy.js';

export interface SearchFilters {
  query: string;
  geo?: string;
  remoteOnly?: boolean;
  maxResults?: number;
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
