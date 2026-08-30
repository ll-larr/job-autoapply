import type { Queue, LetterMode } from './core/queue.js';
import type { Config, SearchQueryConfig } from './core/config.js';
import type { Adapter } from './adapters/types.js';
import { scoreVacancy } from './core/scorer.js';
import { screenVacancy, isJuniorExperience } from './core/screening.js';
import { pickMode } from './core/letter.js';
import { vacancyKey, type Vacancy } from './core/vacancy.js';

/**
 * Необязательная статистика, которую адаптер МОЖЕТ выставить на себе после
 * search() — что он реально прочитал и что отсеял ДО того, как вернуть
 * вакансии. НЕ часть контракта Adapter (types.ts осознанно остаётся с двумя
 * методами search/apply, см. отчёт задачи) — читается по утиной типизации,
 * необязательно. Сейчас это выставляет только HhAdapter (src/adapters/hh.ts,
 * HhSearchStats): он отсеивает по опыту и грейду ДО открытия страницы
 * вакансии, так что возвращённый массив — лишь часть реально прочитанного.
 * Адаптер, который ничего не отсеивает сам (hr.ge), это поле не выставляет —
 * pipeline в этом случае считает по длине возвращённого массива, как раньше.
 */
interface AdapterSearchStats {
  read: number;
  rejectedExperience: number;
  rejectedGrade: number;
  duplicatesSkipped?: number;
}

interface AdapterWithSearchStats {
  lastSearchStats?: AdapterSearchStats;
}

/**
 * Сколько сырых карточек адаптер читает за один заход, когда задана цель
 * (RunSearchOptions.target). Порция меньше цели, чтобы прогон не проскакивал
 * её далеко: перебор в пределах одной порции — это уже потраченные открытия
 * страниц вакансий.
 */
const DEFAULT_BATCH_SIZE = 25;

/**
 * Во сколько раз больше карточек прогону разрешено прочитать, чем он должен
 * доставить, когда потолок явно не задан. Не расчёт, а предохранитель:
 * реальная доля прохождения фильтров на живой выдаче держалась около
 * нескольких процентов, так что сорокакратного запаса хватает, чтобы цель
 * достигалась, и при этом прогон не листает hh.ru бесконечно, если запрос
 * вдруг не даёт ничего подходящего.
 */
const SCAN_PER_DELIVERED = 40;

/** Нижняя граница того же потолка: цель в одну вакансию не должна упираться в 40 карточек. */
const MIN_SCAN_CAP = 200;

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
  /**
   * Почему прогон остановился. Нужно панели: «нашли 12 из 20» само по себе
   * неотличимо от «нашли 12, а больше на площадках и нет», а человеку это
   * разные новости — в первом случае стоит поднять потолок, во втором нет.
   *
   * - `target`     — набрали столько, сколько просили. Норма.
   * - `exhausted`  — выдача кончилась по всем формулировкам, больше нечего читать.
   * - `scan_cap`   — упёрлись в потолок просмотра (см. RunSearchOptions.maxResults).
   */
  stoppedBecause: 'target' | 'exhausted' | 'scan_cap';
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
   * Сколько вакансий должно ЛЕЧЬ В ОЧЕРЕДЬ по итогам прогона. Это то число,
   * которое человек вводит в панели: попросил 20 — получил 20 карточек на
   * рассмотрение, а не «20 просмотренных, из которых прошло три».
   *
   * Сколько для этого придётся прочитать — считает сам прогон: фильтры
   * (screening, minScore, core-гейт) отсеивают большую часть выдачи, и во
   * сколько раз именно — заранее не известно. Поэтому адаптеры вызываются
   * порциями (см. batchSize и SearchFilters.skip), после каждой порции
   * проверяется, набрано ли нужное, и следующая порция берётся только если
   * нет.
   *
   * Порции распределяются между ФОРМУЛИРОВКАМИ ЗАПРОСА равномерно: очередной
   * заход делает та формулировка, которая пока доставила меньше всех. Это
   * само собой перераспределяет остаток, когда чья-то выдача кончается
   * раньше других — доля выбывшей формулировки не пропадает, её добирают
   * оставшиеся.
   *
   * undefined — цели нет: каждая пара «формулировка × адаптер» опрашивается
   * ровно один раз, а прогон ограничен только maxResults (поведение до
   * 2026-08-30, на нём стоят тесты конвейера).
   */
  target?: number;
  /**
   * Жёсткий потолок на СЫРЫЕ КАРТОЧКИ, прочитанные за весь прогон (все
   * запросы и адаптеры вместе). Предохранитель, а не настройка: цель задаётся
   * через target, но фильтры могут отсеивать почти всё, и без потолка прогон
   * листал бы выдачу до конца, стуча по площадке часами.
   *
   * Считается по реально прочитанному адаптерами (report.found — через
   * AdapterSearchStats.read, когда адаптер его выставляет, иначе по длине
   * возвращённого массива), а не по числу уникальных после дедупа: это то,
   * что действительно стоит времени.
   *
   * undefined вместе с заданным target — потолок берётся производным от цели
   * (см. SCAN_PER_DELIVERED). undefined вместе с undefined target — без
   * потолка.
   */
  maxResults?: number;
  /**
   * Сколько сырых карточек адаптер читает за один заход. Меньше — точнее
   * останов у цели и меньше лишней работы, больше — меньше повторных
   * навигаций по страницам выдачи. Параметр ради тестов; в бою хватает
   * значения по умолчанию.
   */
  batchSize?: number;
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
    adapterErrors: [], stoppedBecause: 'exhausted',
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
  //
  // Передаётся адаптеру через SearchFilters.seenThisRun (см. adapters/types.ts)
  // ДО следующего вызова search() — по мере обработки очередной формулировки
  // сюда добавляются ключи всех обработанных вакансий, так что второй и
  // последующий вызовы adapter.search() в этом же прогоне видят уже
  // накопленное. Адаптер, который умеет читать это поле (hh.ru), пропускает
  // открытие страницы вакансии для уже виденных id вместо того, чтобы
  // прочитать и тут же выбросить дубль — см. HhAdapter.search.
  const seenThisRun = new Set<string>();

  interface Task {
    qc: SearchQueryConfig;
    adapter: Adapter;
    /** Индекс формулировки в opts.queries — по нему считается равномерность. */
    queryIndex: number;
    /** Сколько сырых карточек этой пары уже прочитано; смещение следующей порции. */
    skip: number;
    /** Выдача кончилась или адаптер упал — больше сюда не ходим. */
    done: boolean;
  }

  const tasks: Task[] = [];
  opts.queries.forEach((qc, queryIndex) => {
    for (const adapter of opts.adapters) {
      tasks.push({ qc, adapter, queryIndex, skip: 0, done: false });
    }
  });

  const target = opts.target;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const scanCap = opts.maxResults ?? (
    target === undefined ? undefined : Math.max(MIN_SCAN_CAP, target * SCAN_PER_DELIVERED)
  );

  // Сколько вакансий доставила каждая ФОРМУЛИРОВКА (не пара формулировка+
  // адаптер): равномерность человек ожидает между запросами, а не между
  // площадками — площадки разного размера, и делить поровну между ними
  // означало бы искусственно душить большую.
  const deliveredByQuery = new Array<number>(opts.queries.length).fill(0);

  report.stoppedBecause = 'exhausted';

  for (;;) {
    if (target !== undefined && report.queued >= target) {
      report.stoppedBecause = 'target';
      break;
    }
    if (scanCap !== undefined && report.found >= scanCap) {
      report.stoppedBecause = 'scan_cap';
      break;
    }

    const live = tasks.filter((t) => !t.done);
    if (live.length === 0) break;

    // Без цели порядок остаётся прежним — по списку, каждая пара по одному
    // разу. С целью очередной заход достаётся отстающей формулировке; при
    // равенстве строгое "<" оставляет первую, то есть исходный порядок.
    const task = target === undefined
      ? live[0]!
      : live.reduce((a, b) => (deliveredByQuery[b.queryIndex]! < deliveredByQuery[a.queryIndex]! ? b : a));

    const remainingScan = scanCap === undefined ? undefined : scanCap - report.found;
    const budget = target === undefined
      ? remainingScan
      : Math.min(batchSize, remainingScan ?? batchSize);

    let vacancies: Vacancy[];
    try {
      vacancies = await task.adapter.search({
        query: task.qc.query,
        maxResults: budget,
        skip: task.skip,
        seenThisRun,
      });
    } catch (e) {
      // Частичный результат — валидный результат. Остальные площадки/запросы
      // работают; упавшая пара выбывает, чтобы прогон не крутился на ней.
      report.adapterErrors.push({
        adapter: task.adapter.name,
        message: e instanceof Error ? e.message : String(e),
      });
      task.done = true;
      continue;
    }

    // Бюджет и отчёт о фильтрах должны отражать РЕАЛЬНО прочитанное адаптером,
    // а не длину того, что он вернул после собственного предфильтра (см.
    // AdapterSearchStats выше) — иначе потолок не ограничивает настоящую
    // работу, а rejectedExperience/rejectedGrade показывают почти ноль для
    // источников, которые отсеивают дёшево ещё до дочитки описания.
    const stats = (task.adapter as unknown as AdapterWithSearchStats).lastSearchStats;
    const read = stats ? stats.read : vacancies.length;
    if (stats) {
      report.found += stats.read;
      report.rejectedExperience += stats.rejectedExperience;
      report.rejectedGrade += stats.rejectedGrade;
      report.duplicates += stats.duplicatesSkipped ?? 0;
    } else {
      report.found += vacancies.length;
    }

    // Ноль прочитанных карточек означает конец выдачи по этой формулировке:
    // смещение ушло за последнюю страницу. Иначе двигаем смещение на
    // прочитанное — следующая порция продолжит, а не перечитает то же самое.
    if (read === 0) task.done = true;
    else task.skip += read;
    // Без цели пара опрашивается ровно один раз (прежнее поведение).
    if (target === undefined) task.done = true;

    for (const v of vacancies) {
      if (target !== undefined && report.queued >= target) break;

      const key = vacancyKey(v);
      if (seenThisRun.has(key)) { report.duplicates++; continue; }
      seenThisRun.add(key);

      if (task.qc.constraints?.juniorOnly === true && !isJuniorExperience(v.experience)) {
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

      if (opts.queue.insertPending(v, score, matched, letter, usedMode)) {
        report.queued++;
        deliveredByQuery[task.queryIndex]!++;
      } else {
        report.duplicates++;
      }
    }
  }

  return report;
}
