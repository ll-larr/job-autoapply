import type { Queue, LetterMode } from './core/queue.js';
import type { Config } from './core/config.js';
import type { Adapter } from './adapters/types.js';
import type { Specialty } from './core/specialty.js';
import { scoreVacancy } from './core/scorer.js';
import { screenVacancy, hasTitleWord, type ScreenResult } from './core/screening.js';
import { pickMode } from './core/letter.js';
import { DEFAULT_SPECIALTY, DEFAULT_STOP_WORDS } from './core/specialty-defaults.js';
import { vacancyKey, type Vacancy } from './core/vacancy.js';

/**
 * Одна фраза поиска и специальность, от имени которой она ищет. Специальность
 * решает, как вакансию оценивать: навыки и веса, слова заголовка, стаж
 * (спека 2026-09-18, раздел 3.2). Без неё — бизнес-аналитик, как до этой даты.
 */
export interface SearchQuery {
  query: string;
  specialty?: Specialty;
}

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
  rejectedExperience?: number;
  rejectedGrade?: number;
  duplicatesSkipped?: number;
  /** Telegram (adapters/telegram.ts): пост не похож на вакансию. */
  notVacancy?: number;
  /** Telegram: вакансия, но написать некому — ни @username, ни ссылки на площадку. */
  noContact?: number;
  /** Telegram: чаты, которые не прочитались, и почему. */
  skippedChats?: Array<{ title: string; why: string }>;
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
   * Жёсткие фильтры-исключения (см. src/core/screening.ts). В отличие от
   * noCoreMatch/belowThreshold выше, это не про скор: вакансия, споткнувшаяся
   * об один из них, отбрасывается сразу, до scoreVacancy и до generate(),
   * деньги на письмо не тратятся ни разу.
   *
   * С 2026-09-18 сюда же попадает то, что раньше считалось rejectedJuniorOnly:
   * это теперь «опыт 0» у специальности — опыт или «старший» в заголовке.
   */
  rejectedExperience: number;
  rejectedGrade: number;
  /** Сработало стоп-слово из настроек (спека 3.5). Раньше — rejectedPlatform для 1С/Битрикса. */
  rejectedStopword: number;
  /** Какое стоп-слово сколько раз сработало — отчёт называет слово, а не «платформу». */
  stopwordHits: Record<string, number>;
  /**
   * Заголовок не называет специальность (слова заголовка). Раньше —
   * rejectedNotAnalyst: 2026-09-01 «Менеджер по операционному консалтингу» и
   * подобные набирали проходной скор описанием, но владелец их отменял — скор
   * говорит, чем занимаются, а заголовок отвечает, кем при этом зовут.
   */
  rejectedTitle: number;
  /** Стажировки. */
  rejectedInternship: number;
  /** Telegram: прочитанные посты, не похожие на вакансию (спека 4.6). */
  tgNotVacancy: number;
  /** Telegram: вакансии, где некому писать. */
  tgNoContact: number;
  /** Telegram: чаты, пропущенные в этом прогоне, и почему (закрыт, FloodWait). */
  tgSkippedChats: Array<{ title: string; why: string }>;
  /** Репосты: тот же текст, что у уже виденного поста (спека 4.7). */
  textDuplicates: number;
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
   * одной и той же площадке (см. cli.ts#buildSearchQueries: фразы берутся из
   * специальностей data/settings.json). Каждая формулировка прогоняется через
   * каждый адаптер по очереди; результаты сливаются и дедуплицируются В
   * ПРЕДЕЛАХ этого прогона ДО screening — см. комментарий у seenThisRun
   * ниже.
   */
  queries: SearchQuery[];
  /** Стоп-слова из настроек. undefined — прежние 1С и Битрикс. */
  stopWords?: readonly string[];
  /**
   * Включённые специальности — для бесфразовых адаптеров (Telegram): пост
   * найден не фразой, и оценивает его та специальность, чьи слова заголовка
   * в нём есть. undefined — специальности, стоящие за фразами.
   */
  specialties?: Specialty[];
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
  generate: (v: Vacancy, matched: string[], mode: LetterMode, specialty: Specialty)
    => Promise<{ letter: string; mode: LetterMode }>;
}

/**
 * Собирает вакансии со всех адаптеров по каждой формулировке запроса,
 * отсеивает дубли (и в пределах прогона, и по сравнению с прошлыми
 * прогонами через Queue), жёсткие фильтры по профилю специальности фразы
 * (опыт/грейд/стоп-слова/стажировка/заголовок — см. core/screening.ts), мусор
 * ниже minScore и вакансии без core-совпадения, генерирует письма только
 * для того, что прошло все фильтры, и складывает результат в очередь.
 * Порядок фильтров — от дешёвого к дорогому: дедуп → screening по профилю
 * специальности → scoring навыками специальности → generate() — чем раньше вакансия выбывает, тем
 * меньше на неё потрачено. Падение одного адаптера не останавливает
 * остальные — частичный результат остаётся валидным результатом.
 */
export async function runSearch(opts: RunSearchOptions): Promise<SearchReport> {
  const report: SearchReport = {
    found: 0, queued: 0, duplicates: 0, belowThreshold: 0, noCoreMatch: 0,
    rejectedExperience: 0, rejectedGrade: 0, rejectedStopword: 0, stopwordHits: {},
    rejectedTitle: 0, rejectedInternship: 0,
    tgNotVacancy: 0, tgNoContact: 0, tgSkippedChats: [], textDuplicates: 0,
    adapterErrors: [], stoppedBecause: 'exhausted',
  };
  const stopWords = opts.stopWords ?? DEFAULT_STOP_WORDS;

  // Каждая причина отсева считается своей строкой. Ссыпать их в одну кучу
  // значило бы врать в отчёте: «отсеяно по 1С: 9» при девяти вакансиях, где
  // 1С никто не упоминал.
  const countReject = (screen: Extract<ScreenResult, { passed: false }>): void => {
    if (screen.reason === 'experience') report.rejectedExperience++;
    else if (screen.reason === 'grade') report.rejectedGrade++;
    else if (screen.reason === 'not_title') report.rejectedTitle++;
    else if (screen.reason === 'internship') report.rejectedInternship++;
    else {
      report.rejectedStopword++;
      const word = screen.stopWord ?? '?';
      report.stopwordHits[word] = (report.stopwordHits[word] ?? 0) + 1;
    }
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
    qc: SearchQuery;
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
      // Бесфразовый адаптер (Telegram) читает ленту, а не выдачу по фразе:
      // одна задача на весь прогон, сколько бы фраз ни было.
      if (adapter.queryless === true && queryIndex > 0) continue;
      tasks.push({ qc, adapter, queryIndex, skip: 0, done: false });
    }
  });
  const specialtiesForQueryless = opts.specialties ?? [
    ...new Map(opts.queries.map((q) => {
      const s = q.specialty ?? DEFAULT_SPECIALTY;
      return [s.id, s] as const;
    })).values(),
  ];
  // Репосты (спека 4.7): хэши текстов, уже обработанных в этом прогоне.
  const seenHashes = new Set<string>();

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
        experienceYears: (task.qc.specialty ?? DEFAULT_SPECIALTY).experienceYears,
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
      report.rejectedExperience += stats.rejectedExperience ?? 0;
      report.rejectedGrade += stats.rejectedGrade ?? 0;
      report.duplicates += stats.duplicatesSkipped ?? 0;
      report.tgNotVacancy += stats.notVacancy ?? 0;
      report.tgNoContact += stats.noContact ?? 0;
      report.tgSkippedChats.push(...(stats.skippedChats ?? []));
    } else {
      report.found += vacancies.length;
    }

    // Ноль прочитанных карточек означает конец выдачи по этой формулировке:
    // смещение ушло за последнюю страницу. Иначе двигаем смещение на
    // прочитанное — следующая порция продолжит, а не перечитает то же самое.
    if (read === 0) task.done = true;
    else task.skip += read;
    // Без цели пара опрашивается ровно один раз (прежнее поведение). Лента
    // Telegram читается за один заход целиком — повторять незачем.
    if (target === undefined || task.adapter.queryless === true) task.done = true;

    for (const v of vacancies) {
      if (target !== undefined && report.queued >= target) break;

      const key = vacancyKey(v);
      if (seenThisRun.has(key)) { report.duplicates++; continue; }
      seenThisRun.add(key);

      if (opts.queue.has(v)) { report.duplicates++; continue; }

      // Один пост часто перепощен в несколько каналов (спека 4.7): ключ дубля —
      // хэш текста, и в прогоне, и между прогонами.
      if (v.contentHash !== null) {
        if (seenHashes.has(v.contentHash) || opts.queue.hasContentHash(v.contentHash)) {
          report.textDuplicates++;
          continue;
        }
        seenHashes.add(v.contentHash);
      }

      // Кто оценивает вакансию. Найденную фразой — специальность фразы. Пост
      // Telegram фразой не найден: его оценивает та из включённых
      // специальностей, чьи слова заголовка в нём есть, а если таких
      // несколько — давшая лучший скор (при равенстве — первая в настройках).
      const queryless = task.adapter.queryless === true;
      const candidates = queryless
        ? specialtiesForQueryless.filter((s) => hasTitleWord(`${v.title}\n${v.description}`, s.titleWords))
        : [task.qc.specialty ?? DEFAULT_SPECIALTY];
      if (candidates.length === 0) { report.rejectedTitle++; continue; }

      let best: { specialty: Specialty; score: number; matched: string[] } | null = null;
      let firstReject: ScreenResult | null = null;
      let lowScore = false;
      let noCore = false;
      for (const candidate of candidates) {
        // Опыт 0 (прежний juniorOnly) смотрит и на ЗАГОЛОВОК: «Старший
        // системный аналитик» пришёл с careerist без маркера опыта вообще, и
        // владелец его отменил — системный аналитик он максимум младший.
        const screen = screenVacancy(v, {
          titleWords: candidate.titleWords,
          experienceYears: candidate.experienceYears,
          stopWords,
          // Гейт заголовка для поста уже сыграла проверка слов по всему посту
          // выше, а заголовок из запасного правила может слов не содержать.
          skipTitleGate: queryless,
        });
        if (!screen.passed) { firstReject ??= screen; continue; }
        const s = scoreVacancy(v, candidate.skills);
        if (s.score < opts.config.minScore) { lowScore = true; continue; }
        if (!s.hasCoreMatch) { noCore = true; continue; }
        if (best === null || s.score > best.score) best = { specialty: candidate, score: s.score, matched: s.matched };
      }
      if (best === null) {
        // Причина — самая поздняя стадия, до которой дошёл хоть один кандидат:
        // «ниже порога» честнее, чем «стоп-слово», если другой кандидат
        // стоп-слово прошёл. У вакансии, найденной фразой, кандидат один, и
        // это ровно прежний подсчёт.
        if (noCore) report.noCoreMatch++;
        else if (lowScore) report.belowThreshold++;
        else if (firstReject !== null && !firstReject.passed) countReject(firstReject);
        continue;
      }
      const { specialty, score, matched } = best;

      // Скелеты писем и выбор hybrid/full — только у засеянных специальностей
      // (legacyLetters). У остальных скелетов нет, письмо пишется целиком
      // (спека 3.7).
      const mode = specialty.legacyLetters ? pickMode(score, opts.config.letterFullThreshold) : 'full';
      const { letter, mode: usedMode } = await opts.generate(v, matched, mode, specialty);

      if (opts.queue.insertPending(v, score, matched, letter, usedMode, specialty.id)) {
        report.queued++;
        deliveredByQuery[task.queryIndex]!++;
      } else {
        report.duplicates++;
      }
    }
  }

  return report;
}
