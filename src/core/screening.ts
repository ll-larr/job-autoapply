import type { ExperienceLevel, Vacancy } from './vacancy.js';
import { countInNormalized, hasInNormalized, normalizeForMatch } from './matching.js';
import { BA_TITLE_WORDS, DEFAULT_EXPERIENCE_YEARS, DEFAULT_STOP_WORDS } from './specialty-defaults.js';

/**
 * Жёсткие фильтры-исключения. В отличие от scorer.ts (который ранжирует и
 * мягко отсеивает по порогу) они не про скор: вакансия, споткнувшаяся об один
 * из них, не должна доходить до генерации письма вообще, потому что письмо
 * стоит денег (вызов LLM), а чтение письма — время пользователя. См. wiring в
 * src/pipeline.ts — screenVacancy вызывается до scoreVacancy и до generate().
 *
 * С 2026-09-18 параметры отсева — стаж, слова заголовка, стоп-слова — берутся
 * из специальности и настроек (спека 2026-09-18, разделы 3.4–3.6). В коде
 * остались только стажировки и грейд lead/head/ведущий.
 *
 * Регулярки на кириллице ниже сознательно НЕ используют \b и \w — оба в JS
 * определены через ASCII word-class и не видят кириллицу вовсе. Совпадение
 * слов из настроек — core/matching.ts.
 */

export type ScreenReason =
  | 'experience'
  | 'grade'
  /** Стоп-слово из настроек (спека 3.5). Раньше — 'platform' для 1С и Битрикса. */
  | 'stopword'
  | 'internship'
  /** В заголовке нет ни одного слова заголовка специальности. Раньше — 'not_analyst'. */
  | 'not_title';

export type ScreenResult =
  | { passed: true }
  | { passed: false; reason: ScreenReason; detail: string; stopWord?: string };

/** Что отсев берёт из специальности и настроек. */
export interface ScreeningProfile {
  titleWords: readonly string[];
  experienceYears: number;
  stopWords: readonly string[];
  /**
   * Не проверять заголовок. Для постов Telegram: слова заголовка там ищутся по
   * всему посту ещё до конвейера, а заголовок из запасного правила может их
   * не содержать (спека 4.6).
   */
  skipTitleGate?: boolean;
}

export const DEFAULT_SCREENING: ScreeningProfile = {
  titleWords: BA_TITLE_WORDS,
  experienceYears: DEFAULT_EXPERIENCE_YEARS,
  stopWords: DEFAULT_STOP_WORDS,
};

// ============================================================================
// 1. Опыт — минимум бакета против «мой опыт» специальности.
// ============================================================================

/**
 * Минимум лет, который требует бакет. Вакансия проходит, если этот минимум не
 * выше «мой опыт» специальности (спека 3.4). «1–3 года» требует минимум 1,
 * поэтому при опыте 2 проходит, а «3–6 лет» — нет: ровно прежний
 * ACCEPTABLE_EXPERIENCE. При опыте 0 проходит только «без опыта» — прежний
 * juniorOnly.
 */
const MIN_YEARS: Readonly<Record<ExperienceLevel, number>> = {
  noExperience: 0,
  between1And3: 1,
  between3And6: 3,
  moreThan6: 6,
};

/**
 * null (сигнал отсутствует и структурно, и текстом) обязан пройти — иначе
 * гейт тихо вырезал бы любую вакансию, не заявившую требование к опыту явно,
 * а таких на реальном hh.ru большинство описаний без карточного маркера.
 */
export function isExperienceWithin(level: ExperienceLevel | null, years: number): boolean {
  if (level === null) return true;
  return MIN_YEARS[level] <= years;
}

const NO_EXPERIENCE_RE = /без\s+опыта|опыт[а-яё]*\s+не\s+требуется|не\s+требует[а-яё]*\s+опыт/i;

// "1-3 года", "3–6 лет", "от 2 до 4 лет" — оба числа диапазона, берём потолок.
const RANGE_YEARS_RE = /(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*(?:лет|года|год)/gi;

/**
 * "от N лет" / "не менее N лет" — включительная нижняя граница: N лет уже
 * удовлетворяет требованию.
 *
 * Тире между числом и «лет» допускается: в постах Telegram пишут «от 3 – лет»
 * (снято 2026-09-19). «от 3 – 6 лет» сюда не попадает — после тире стоит
 * число, а не «лет», и его разбирает RANGE_YEARS_RE.
 */
const AT_LEAST_YEARS_RE = /(?:опыт\s*работы\s*)?(?:от|не\s*менее)\s*(\d{1,2})\s*(?:[-–—]\s*)?(?:лет|года|год)/gi;

/**
 * "более N лет" — исключительная граница: "более 6 лет" значит минимум 7,
 * а не 6, отсюда +1 при сборе (см. ниже). Сознательно НЕ матчится внутри
 * "не более": "не более 6 лет" — разрешающая формулировка ("не нужно
 * больше 6"), а не требование минимума, и её нельзя путать с "не менее"
 * (та же длина фразы, противоположный смысл).
 */
const MORE_THAN_YEARS_RE = /(?<!не )более\s*(\d{1,2})\s*(?:лет|года|год)/gi;

function yearsToLevel(years: number): ExperienceLevel {
  if (years <= 3) return 'between1And3';
  if (years <= 6) return 'between3And6';
  return 'moreThan6';
}

/**
 * Фолбэк на случай, когда структурного сигнала нет (hr.ge всегда, hh —
 * теоретически, если разметка карточки когда-нибудь изменится). Разбирает
 * русские формулировки требуемого стажа. Ничего не найдено → null
 * ("неизвестно"), а не жёсткий отказ — см. isExperienceWithin.
 */
export function parseExperienceFromText(text: string): ExperienceLevel | null {
  const years: number[] = [];

  for (const m of text.matchAll(RANGE_YEARS_RE)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    years.push(Math.max(a, b));
  }
  for (const m of text.matchAll(AT_LEAST_YEARS_RE)) {
    years.push(Number(m[1]));
  }
  for (const m of text.matchAll(MORE_THAN_YEARS_RE)) {
    years.push(Number(m[1]) + 1);
  }

  if (years.length > 0) return yearsToLevel(Math.max(...years));
  if (NO_EXPERIENCE_RE.test(text)) return 'noExperience';
  return null;
}

// ============================================================================
// 2. Грейд — только заголовок. "ведущий" — пример грейда заведомо выше его.
// ============================================================================

/**
 * Стемы вместо целых слов + явный кириллический класс окончаний — тот же
 * приём, что "процессн[а-яё]*" в scorer.ts. Общее правило матчинга по
 * подстроке (без границ слова) безопасно здесь: "директор" не встречается
 * как подстрока внутри "дирекция" (расходятся после общего "дирек"), а
 * остальные стемы достаточно длинные и специфичные, чтобы не ловить
 * случайные слова — проверено на всех 50 реальных заголовков фикстуры.
 */
const SENIOR_TITLE_PATTERNS: readonly RegExp[] = [
  /ведущ[а-яё]*/i,
  /главн[а-яё]*/i,
  /руководител[а-яё]*/i,
  /начальник[а-яё]*/i,
  /директор[а-яё]*/i,
  // Латиница — обычные ASCII \b тут работают, кириллицы в паттерне нет.
  /\bsenior\b/i,
  /\blead\b/i,
  /\bhead\s+of\b/i,
];

/** Только заголовок: "работа с ведущими специалистами" в описании — не заявка на лид-роль. */
export function isSeniorTitle(title: string): boolean {
  return SENIOR_TITLE_PATTERNS.some((re) => re.test(title));
}

// ============================================================================
// 3. Стоп-слова — платформы и прочее, что владельцу не подходит.
// ============================================================================

/**
 * Одно правило на все стоп-слова (спека 3.5, выбор владельца 2026-09-18):
 * слово в заголовке — отсев сразу; в описании — если встретилось 2 раза и
 * больше. Одно упоминание — это обычно пункт в списке систем («Jira, 1С,
 * ELMA»), и резать за него значит терять нормальные вакансии.
 *
 * Для 1С это строже прежнего порога 3 — осознанно.
 */
export const STOPWORD_DESCRIPTION_THRESHOLD = 2;

/** Первое сработавшее стоп-слово в порядке списка, либо null. */
export function findStopWord(
  v: Pick<Vacancy, 'title' | 'description'>,
  stopWords: readonly string[],
): string | null {
  const title = normalizeForMatch(v.title);
  const description = normalizeForMatch(v.description);
  for (const word of stopWords) {
    if (hasInNormalized(title, word)) return word;
    if (countInNormalized(description, word) >= STOPWORD_DESCRIPTION_THRESHOLD) return word;
  }
  return null;
}

// ============================================================================
// 4. Заголовок обязан называть специальность.
// ============================================================================

/**
 * Скор говорит, ЧЕМ занимаются; заголовок — кем зовут. 2026-09-01 владелец
 * отменил «Менеджера по операционному консалтингу» и подобных: лексика
 * процессов в описании у них честно была, а роль — не его. Слова берутся из
 * специальности (у БА — «аналитик», «analyst», «BA», «SA»).
 */
export function hasTitleWord(title: string, titleWords: readonly string[]): boolean {
  const normalized = normalizeForMatch(title);
  return titleWords.some((w) => hasInNormalized(normalized, w));
}

// ============================================================================
// 5. Стажировки.
// ============================================================================

/**
 * Стажировка — не его уровень: 2026-09-01 владелец отменил «Аналитик
 * внедрения-стажер» со словами «стажерская вакансия не по профилю».
 *
 * Это отменяет прежнее правило письма («если откликаемся на стажировку —
 * сказать, что рассматриваем junior+/middle»): откликаться на них больше не
 * будем вовсе, так что писать эту фразу негде.
 */
const INTERNSHIP_TITLE_PATTERNS: readonly RegExp[] = [
  /стажёр|стажер|стажиров/i,
  /\bintern(ship)?\b/i,
  /\btrainee\b/i,
];

export function isInternshipTitle(title: string): boolean {
  return INTERNSHIP_TITLE_PATTERNS.some((re) => re.test(title));
}

// ============================================================================
// 6. Грейд выше junior — для специальностей с опытом 0.
// ============================================================================

/**
 * «Старший» и прочие маркеры не-начального грейда В ЗАГОЛОВКЕ.
 *
 * Отдельно от SENIOR_TITLE_PATTERNS и намеренно: «старший» там нет и быть не
 * должно. Владелец отправил отклик на «Старший ИТ аналитик» и в тот же день
 * отменил «Старший системный аналитик», объяснив: системный аналитик он
 * максимум младший. То есть «старший» отсекается не везде, а только у
 * специальности с опытом 0 — сейчас это «Системный аналитик» (прежний juniorOnly).
 */
const ABOVE_JUNIOR_TITLE_RE = /старш[а-яё]*|\bsenior\b|\bмиддл\b|\bmiddle\b/i;

export function isAboveJuniorTitle(title: string): boolean {
  return ABOVE_JUNIOR_TITLE_RE.test(title) || isSeniorTitle(title);
}

// ============================================================================
// Сборка
// ============================================================================

/**
 * Чистая функция: без сети, БД, часов. Порядок проверок (опыт → грейд →
 * стоп-слова → стажировка → заголовок) определяет, какая причина попадёт в
 * отчёт, если вакансия нарушает сразу несколько условий.
 */
export function screenVacancy(v: Vacancy, profile: ScreeningProfile = DEFAULT_SCREENING): ScreenResult {
  const level = v.experience ?? parseExperienceFromText(v.description);
  if (!isExperienceWithin(level, profile.experienceYears)) {
    return {
      passed: false,
      reason: 'experience',
      detail: `требуемый опыт выше заданных ${profile.experienceYears} лет (структурно: ${v.experience ?? 'нет'})`,
    };
  }
  if (isSeniorTitle(v.title)) {
    return {
      passed: false,
      reason: 'grade',
      detail: 'заголовок содержит маркер грейда выше начального/среднего уровня',
    };
  }
  if (profile.experienceYears < 1 && isAboveJuniorTitle(v.title)) {
    return {
      passed: false,
      reason: 'grade',
      detail: 'при опыте 0 отсекаются «старший», senior и middle в заголовке',
    };
  }
  const stopWord = findStopWord(v, profile.stopWords);
  if (stopWord !== null) {
    return { passed: false, reason: 'stopword', detail: `стоп-слово: ${stopWord}`, stopWord };
  }
  if (isInternshipTitle(v.title)) {
    return { passed: false, reason: 'internship', detail: 'стажировка' };
  }
  if (profile.skipTitleGate !== true && !hasTitleWord(v.title, profile.titleWords)) {
    return {
      passed: false,
      reason: 'not_title',
      detail: 'заголовок не называет специальность, каким бы ни был скор описания',
    };
  }
  return { passed: true };
}
