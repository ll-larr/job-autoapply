import type { Queue, LetterMode } from './core/queue.js';
import type { Config } from './core/config.js';
import type { Adapter, SearchFilters } from './adapters/types.js';
import { scoreVacancy } from './core/scorer.js';
import { pickMode } from './core/letter.js';
import type { Vacancy } from './core/vacancy.js';

export interface SearchReport {
  found: number;
  queued: number;
  duplicates: number;
  belowThreshold: number;
  /**
   * Отброшено гейтом core-релевантности: скор выше minScore, но ни одна
   * core-группа (process-design или requirements-docs, см. core/scorer.ts)
   * не сработала. Вакансия набрала очки на SQL/DWH/Kafka/UML/интеграциях/
   * продукте/AI, но ни разу не упомянула процессный дизайн или требования —
   * то есть не про то, чем он реально занимается, сколько бы других
   * ключевиков ни нашлось. Считается и отбрасывается до генерации письма,
   * до generate() ни разу не доходит — деньги на LLM не тратятся.
   */
  noCoreMatch: number;
  adapterErrors: Array<{ adapter: string; message: string }>;
}

export interface RunSearchOptions {
  queue: Queue;
  config: Config;
  filters: SearchFilters;
  adapters: Adapter[];
  generate: (v: Vacancy, matched: string[], mode: LetterMode)
    => Promise<{ letter: string; mode: LetterMode }>;
}

/**
 * Собирает вакансии со всех адаптеров, отсеивает дубли, мусор ниже minScore
 * и вакансии без core-совпадения, генерирует письма только для того, что
 * прошло все фильтры, и складывает результат в очередь. Падение одного
 * адаптера не останавливает остальные — частичный результат остаётся
 * валидным результатом.
 */
export async function runSearch(opts: RunSearchOptions): Promise<SearchReport> {
  const report: SearchReport = {
    found: 0, queued: 0, duplicates: 0, belowThreshold: 0, noCoreMatch: 0, adapterErrors: [],
  };

  for (const adapter of opts.adapters) {
    let vacancies: Vacancy[];
    try {
      vacancies = await adapter.search(opts.filters);
    } catch (e) {
      // Частичный результат — валидный результат. Остальные площадки работают.
      report.adapterErrors.push({
        adapter: adapter.name,
        message: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    report.found += vacancies.length;

    for (const v of vacancies) {
      if (opts.queue.has(v)) { report.duplicates++; continue; }

      const { score, matched, hasCoreMatch } = scoreVacancy(v);
      if (score < opts.config.minScore) { report.belowThreshold++; continue; }
      if (!hasCoreMatch) { report.noCoreMatch++; continue; }

      const mode = pickMode(score, opts.config.letterFullThreshold);
      const { letter, mode: usedMode } = await opts.generate(v, matched, mode);

      if (opts.queue.insertPending(v, score, matched, letter, usedMode)) report.queued++;
      else report.duplicates++;
    }
  }

  return report;
}
