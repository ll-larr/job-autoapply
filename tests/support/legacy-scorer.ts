/**
 * Скорер ДО 2026-09-18, дословно. Живёт только ради tests/scorer-parity.test.ts:
 * перенос весов бизнес-аналитика из регэкспов в синонимы обязан давать ровно
 * те же скоры. Не править — это эталон, а не код.
 */
import type { Vacancy } from '../../src/core/vacancy.js';

export type KeywordWeights = Readonly<
  Record<
    string,
    {
      readonly weight: number;
      readonly patterns: readonly RegExp[];
      /**
       * Группа определяет ядро роли: процессный дизайн или требования/документация.
       * Вакансия без совпадения хотя бы в одной core-группе не про то, чем он
       * реально занимается, сколько бы других ключевиков она ни набрала —
       * см. ScoreResult.hasCoreMatch и гейт в src/pipeline.ts.
       */
      readonly core?: boolean;
    }
  >
>;

export interface ScoreResult {
  score: number;
  matched: string[];
  /** true, если сработала хотя бы одна core-группа (process-design или requirements-docs). */
  hasCoreMatch: boolean;
}

/**
 * Веса переписаны 2026-08-29 под прямой ответ пользователя о том, что он
 * реально умеет — не под карту рынка. Карта рынка мерила спрос, а не его
 * профиль, и в результате вакансия чистого дата-экстрактора когда-то обошла
 * по скору вакансию с процессным дизайном.
 *
 * Ядро — то, что он реально делал руками от начала до конца — весит
 * тяжелее всего: полный цикл AS-IS → TO-BE (process-design) и сбор
 * требований с документацией (requirements-docs). AI/LLM — второй по силе
 * дифференциатор, он строил LLM-пайплайны сам, вес не трогаем. SQL и DWH/BI
 * уронены намеренно и сильно: он читает и правит чужой SQL, но не пишет
 * сложные запросы с нуля, и он не дата-аналитик — совпадение по SQL не
 * должно тащить скор вверх так, как раньше. REST/API-интеграции тоже вниз:
 * он потребитель API (гоняет запросы руками через Postman), а не автор
 * контрактов — это не то, что отличает его среди БА.
 *
 * Сумма весов всех девяти групп — 113 (28+24+22+8+8+6+6+6+5), сознательно
 * больше ста: это делает потолок в scoreVacancy (Math.min(100, total))
 * реально достижимым, а не защитным кодом на случай, которого не бывает.
 *
 * Регулярки на кириллице сознательно НЕ используют \b и \w: в JS оба
 * основаны на ASCII-определении "словного" символа и не видят кириллицу —
 * \bбизнес\b не находит "бизнес" ни в каком реальном тексте. Переменные
 * суффиксы (падежные окончания) собираются через явный класс [а-яё], а не
 * через \w*.
 */
export const DEFAULT_WEIGHTS: KeywordWeights = {
  'process-design': {
    weight: 28,
    core: true,
    patterns: [
      /\bBPMN\b/i,
      /\bAS-IS\b/i,
      /\bTO-BE\b/i,
      /gap[- ]?анализ/i,
      /г[еэ]п[- ]?анализ/i,
      /регламент/i,
      /бизнес[- ]?процесс/i,
      /процессн[а-яё]*\s+модел/i,
      /оптимизаци[а-яё]*\s+процесс/i,
    ],
  },
  'requirements-docs': {
    weight: 24,
    core: true,
    patterns: [
      /\bBRD\b/i,
      /\bFSD\b/i,
      /\bSRS\b/i,
      // "ТЗ" всегда пишут заглавными — сознательно чувствительно к регистру
      // и без \b (см. комментарий выше), чтобы не поймать случайную
      // подстроку внутри кириллического слова.
      /(?<![а-яёА-ЯЁ])ТЗ(?![а-яёА-ЯЁ])/,
      /бизнес[- ]?требовани/i,
      // Русский часто элидирует повтор существительного при перечислении:
      // "бизнес- и функциональных требований" — здесь "бизнес[- ]?требовани"
      // не совпадёт (между корнями чужие слова), а этот паттерн ловит
      // функциональные/нефункциональные требования отдельно и тем самым
      // закрывает и этот случай тоже. Проверено на реальной формулировке
      // из tests/fixtures/hh-search.html.
      /функциональн[а-яё]*\s+требовани/i,
      /user stor/i,
      /acceptance criteria/i,
      /\bDoR\b/i,
      /definition of ready/i,
      /постановк[а-яё]*\s+задач/i,
    ],
  },
  'ai-llm': {
    weight: 22,
    patterns: [/\bLLM\b/i, /\bAI[- ]?агент/i, /\bGenAI\b/i, /мультиагент/i, /\bRAG\b/i],
  },
  product: {
    weight: 8,
    patterns: [/\bCJM\b/i, /A\/B/i, /юнит[- ]эконом/i, /\bROI\b/i, /когортн/i],
  },
  kafka: { weight: 8, patterns: [/\bKafka\b/i] },
  uml: { weight: 6, patterns: [/\bUML\b/i] },
  // Понижено с 12: он потребитель API (читает контракты, гоняет запросы
  // руками через Postman/curl), а не автор контрактов — не дифференциатор.
  integrations: {
    weight: 6,
    patterns: [/\bREST\b/i, /\bSOAP\b/i, /микросервис/i, /Swagger/i, /Postman/i],
  },
  // Уронено с 18 до 6: читает и правит чужой SQL, сложные запросы с нуля
  // не пишет. Он explicitly не дата-аналитик — высокий вес здесь раньше
  // затягивал в очередь вакансии дата-экстракции, а не процессного БА.
  sql: { weight: 6, patterns: [/\bSQL\b/i] },
  // Ниже SQL: DWH/BI-инструментарий (ClickHouse, Тableau, Power BI) ещё
  // дальше от его профиля, чем чтение SQL-запросов.
  dwh: {
    weight: 5,
    patterns: [/\bDWH\b/i, /ClickHouse/i, /Vertica/i, /Superset/i, /Tableau/i, /Power ?BI/i],
  },
};

export function legacyScoreVacancy(v: Vacancy, weights: KeywordWeights = DEFAULT_WEIGHTS): ScoreResult {
  const haystack = `${v.title}\n${v.description}`;
  const matched: string[] = [];
  let total = 0;
  let hasCoreMatch = false;

  for (const [key, { weight, patterns, core }] of Object.entries(weights)) {
    if (patterns.some((re) => re.test(haystack))) {
      matched.push(key);
      total += weight;
      if (core === true) hasCoreMatch = true;
    }
  }

  return { score: Math.min(100, total), matched: matched.sort(), hasCoreMatch };
}
