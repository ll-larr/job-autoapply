import type { Skill, Specialty } from './specialty.js';

/**
 * То, что до 2026-09-18 было зашито в код, переложенное в данные. Отсюда
 * засевается data/settings.json при первом запуске (core/settings.ts).
 *
 * BA_SKILLS — перенос DEFAULT_WEIGHTS из прежнего scorer.ts: те же ключи, те
 * же веса, те же ядра. Регэкспы превращены в синонимы по правилам
 * core/matching.ts; равенство скоров проверяет tests/scorer-parity.test.ts.
 * Там, где регэксп покрывал несколько написаний («бизнес[- ]?процесс»), здесь
 * столько же синонимов.
 */

export const BA_SPECIALTY_ID = 'business-analyst';
export const SYSTEM_ANALYST_SPECIALTY_ID = 'system-analyst';

/** Прежний ACCEPTABLE_EXPERIENCE (без опыта и 1–3 года) — это ровно «мой опыт 2 года». */
export const DEFAULT_EXPERIENCE_YEARS = 2;

export const BA_SKILLS: Skill[] = [
  {
    id: 'process-design', name: 'Процессы', weight: 28, core: true,
    synonyms: [
      'BPMN', 'AS-IS', 'TO-BE',
      'gap-анализ', 'gap анализ', 'геп-анализ', 'гэп-анализ', 'геп анализ', 'гэп анализ',
      'регламент', 'бизнес-процесс', 'бизнес процесс', 'бизнеспроцесс',
      'процессная модель', 'оптимизация процесс*',
    ],
  },
  {
    id: 'requirements-docs', name: 'Требования и документация', weight: 24, core: true,
    synonyms: [
      'BRD', 'FSD', 'SRS', 'ТЗ',
      'бизнес-требования', 'бизнес требования', 'бизнестребования',
      'функциональные требования', 'нефункциональные требования',
      'user stor*', 'acceptance criteria', 'DoR', 'definition of ready', 'постановка задач',
    ],
  },
  {
    id: 'ai-llm', name: 'AI / LLM', weight: 22, core: false,
    synonyms: ['LLM', 'AI-агент', 'AI агент', 'AIагент', 'GenAI', 'мультиагент', 'RAG'],
  },
  {
    id: 'product', name: 'Продукт', weight: 8, core: false,
    synonyms: ['CJM', 'A/B', 'юнит-эконом*', 'юнит эконом*', 'ROI', 'когортн*'],
  },
  { id: 'kafka', name: 'Kafka', weight: 8, core: false, synonyms: ['Kafka'] },
  { id: 'uml', name: 'UML', weight: 6, core: false, synonyms: ['UML'] },
  {
    id: 'integrations', name: 'Интеграции', weight: 6, core: false,
    synonyms: ['REST', 'SOAP', 'микросервис', 'Swagger', 'Postman'],
  },
  { id: 'sql', name: 'SQL', weight: 6, core: false, synonyms: ['SQL'] },
  {
    id: 'dwh', name: 'DWH / BI', weight: 5, core: false,
    synonyms: ['DWH', 'ClickHouse', 'Vertica', 'Superset', 'Tableau', 'Power BI', 'PowerBI'],
  },
];

/** Прежний ANALYST_TITLE_PATTERNS. */
export const BA_TITLE_WORDS: string[] = ['аналитик', 'analyst', 'BA', 'SA'];

/** Прежние 1С и Битрикс24 из screening.ts. Битрикс — двумя алфавитами, как было в регэкспе. */
export const DEFAULT_STOP_WORDS: string[] = ['1С', 'Битрикс', 'Bitrix'];

/** Фразы, если в config.json нет searchQueries. Совпадают с config.json на 2026-09-18. */
export const BA_DEFAULT_QUERIES: string[] = [
  'аналитик бизнес-процессов', 'аналитик бизнес процессов', 'бизнес-аналитик', 'бизнес аналитик',
];
export const SYSTEM_ANALYST_DEFAULT_QUERIES: string[] = ['системный аналитик'];

function cloneSkills(): Skill[] {
  return BA_SKILLS.map((s) => ({ ...s, synonyms: [...s.synonyms] }));
}

export function makeBaSpecialty(queries: string[], resumePdf: string | null): Specialty {
  return {
    id: BA_SPECIALTY_ID, name: 'Бизнес-аналитик', enabled: true, queries: [...queries],
    titleWords: [...BA_TITLE_WORDS], skills: cloneSkills(),
    experienceYears: DEFAULT_EXPERIENCE_YEARS, resumePdf, legacyLetters: true,
  };
}

/**
 * Прежний запрос «системный аналитик» с juniorOnly. Опыт 0 — это и есть
 * juniorOnly: проходит только «без опыта», плюс отсев «старший/senior/middle»
 * в заголовке (core/screening.ts). Навыки и слова заголовка — как у БА:
 * раньше все фразы оценивались одним скорингом.
 */
export function makeSystemAnalystSpecialty(queries: string[], resumePdf: string | null): Specialty {
  return {
    ...makeBaSpecialty(queries, resumePdf),
    id: SYSTEM_ANALYST_SPECIALTY_ID, name: 'Системный аналитик', experienceYears: 0,
  };
}

/** Специальность по умолчанию там, где её не передали (старые вызовы, тесты). */
export const DEFAULT_SPECIALTY: Specialty = makeBaSpecialty(BA_DEFAULT_QUERIES, null);
