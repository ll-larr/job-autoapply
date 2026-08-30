import type { Queue, LetterMode } from './core/queue.js';
import type { Config, SearchQueryConfig } from './core/config.js';
import type { Adapter } from './adapters/types.js';
import { scoreVacancy } from './core/scorer.js';
import { screenVacancy, isJuniorExperience } from './core/screening.js';
import { pickMode } from './core/letter.js';
import { vacancyKey, type Vacancy } from './core/vacancy.js';

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
  /**
   * Три жёстких фильтра-исключения (см. src/core/screening.ts), добавленных
   * по разбору пользователем первой живой очереди — 2026-08-30. В отличие
   * от noCoreMatch/belowThreshold выше, это не про скор: вакансия,
   * споткнувшаяся об один из них, отбрасывается сразу, до scoreVacancy и до
   * generate(), деньги на письмо не тратятся ни разу.
   */
  rejectedExperience: number;
  rejectedGrade: number;
  rejected1c: number;
  /**
   * Per-query ограничение "только junior" (config.json →
   * searchQueries[].constraints.juniorOnly, добавлено 2026-08-30 для
   * запроса "системный аналитик"). Считается и отбрасывается ДО
   * screenVacancy/scoreVacancy/generate() — та же экономия, что и у трёх
   * жёстких фильтров выше. См. core/screening.ts#isJuniorExperience.
   */
  rejectedJuniorOnly: number;
  adapterErrors: Array<{ adapter: string; message: string }>;
}

export interface RunSearchOptions {
  queue: Queue;
  config: Config;
  /**
   * Список формулировок запроса — разные фразы находят разные вакансии на
   * одной и той же площадке (см. config.json#searchQueries и
   * cli.ts#resolveSearchQueries). Каждая формулировка прогоняется через
   * каждый адаптер по очереди; результаты сливаются и дедуплицируются В
   * ПРЕДЕЛАХ этого прогона ДО screening — см. комментарий у seenThisRun
   * ниже.
   */
  queries: SearchQueryConfig[];
  /**
   * Общий потолок на ВЕСЬ прогон (все запросы и адаптеры вместе), а не на
   * каждый запрос по отдельности — иначе пять формулировок означали бы
   * впятеро больше открытий страниц вакансий, чем пользователь попросил
   * флагом --limit. Бюджет считается по количеству СЫРЫХ вакансий, реально
   * прочитанных адаптерами (report.found), а не по числу уникальных после
   * дедупа — это то, что действительно стоит денег/времени (страница
   * вакансии открывается и читается ради описания ДО того, как pipeline
   * узнаёт, что вакансия уже встречалась под другой формулировкой; убрать
   * этот момент нельзя, не меняя SearchFilters, а это вне рамок задачи —
   * см. отчёт задачи). Каждый следующий вызов adapter.search() получает
   * оставшийся бюджет как maxResults, так что суммарно все вызовы за
   * прогон не могут прочитать больше maxResults вакансий. undefined —
   * без потолка (как раньше).
   */
  maxResults?: number;
  adapters: Adapter[];
  generate: (v: Vacancy, matched: string[], mode: LetterMode)
    => Promise<{ letter: string; mode: LetterMode }>;
}

/**
 * Собирает вакансии со всех адаптеров по каждой формулировке запроса,
 * отсеивает дубли (и в пределах прогона, и по сравнению с прошлыми
 * прогонами через Queue), per-query ограничение "только junior", три
 * жёстких screening-фильтра (опыт/грейд/1С — см. core/screening.ts), мусор
 * ниже minScore и вакансии без core-совпадения, генерирует письма только
 * для того, что прошло все фильтры, и складывает результат в очередь.
 * Порядок фильтров — от дешёвого к дорогому: дедуп → per-query junior-гейт
 * → screening → scoring → generate() — чем раньше вакансия выбывает, тем
 * меньше на неё потрачено. Падение одного адаптера не останавливает
 * остальные — частичный результат остаётся валидным результатом.
 */
export async function runSearch(opts: RunSearchOptions): Promise<SearchReport> {
  const report: SearchReport = {
    found: 0, queued: 0, duplicates: 0, belowThreshold: 0, noCoreMatch: 0,
    rejectedExperience: 0, rejectedGrade: 0, rejected1c: 0, rejectedJuniorOnly: 0,
    adapterErrors: [],
  };

  // Дедуп В ПРЕДЕЛАХ этого прогона: разные формулировки запроса находят одну
  // и ту же вакансию по нескольку раз. Queue.has() ниже ловит дубли МЕЖДУ
  // прогонами (то, что уже осело в БД с прошлого npm run search) — этого
  // одного недостаточно: вакансия, найденная первой формулировкой этого же
  // прогона, ещё не в БД в момент, когда вторая формулировка вернёт её же,
  // если письмо для неё ещё генерируется/не вставлено. seenThisRun закрывает
  // именно этот разрыв — вакансия проверяется и обрабатывается (screening,
  // scoring, письмо) не больше одного раза за прогон, независимо от того,
  // сколько формулировок её нашли.
  const seenThisRun = new Set<string>();

  const tasks: Array<{ qc: SearchQueryConfig; adapter: Adapter }> = [];
  for (const qc of opts.queries) {
    for (const adapter of opts.adapters) tasks.push({ qc, adapter });
  }

  for (const { qc, adapter } of tasks) {
    const remaining = opts.maxResults === undefined
      ? undefined
      : Math.max(0, opts.maxResults - report.found);
    // Бюджет прогона исчерпан — не открываем больше ни одной страницы
    // вакансии, даже под ещё не опробованной формулировкой/адаптером.
    if (remaining === 0) break;

    let vacancies: Vacancy[];
    try {
      vacancies = await adapter.search({ query: qc.query, maxResults: remaining });
    } catch (e) {
      // Частичный результат — валидный результат. Остальные площадки/запросы работают.
      report.adapterErrors.push({
        adapter: adapter.name,
        message: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    report.found += vacancies.length;

    for (const v of vacancies) {
      const key = vacancyKey(v);
      if (seenThisRun.has(key)) { report.duplicates++; continue; }
      seenThisRun.add(key);

      if (qc.constraints?.juniorOnly === true && !isJuniorExperience(v.experience)) {
        report.rejectedJuniorOnly++;
        continue;
      }

      if (opts.queue.has(v)) { report.duplicates++; continue; }

      const screen = screenVacancy(v);
      if (!screen.passed) {
        if (screen.reason === 'experience') report.rejectedExperience++;
        else if (screen.reason === 'grade') report.rejectedGrade++;
        else report.rejected1c++;
        continue;
      }

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
