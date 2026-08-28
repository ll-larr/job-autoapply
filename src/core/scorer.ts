import type { Vacancy } from './vacancy.js';

export type KeywordWeights = Record<string, { weight: number; patterns: RegExp[] }>;

export interface ScoreResult {
  score: number;
  matched: string[];
}

/**
 * Веса из карты рынка БА 1–3 года (14 вакансий бигтеха/финтеха, 2026-08-25).
 * AI/LLM — главный дифференциатор года, поэтому весит больше всего.
 * BPMN/UML — базовая гигиена, весят мало: они есть у всех и никого не отличают.
 */
export const DEFAULT_WEIGHTS: KeywordWeights = {
  'ai-llm':     { weight: 22, patterns: [/\bLLM\b/i, /\bAI[- ]?агент/i, /\bGenAI\b/i, /мультиагент/i, /\bRAG\b/i] },
  sql:          { weight: 18, patterns: [/\bSQL\b/i] },
  dwh:          { weight: 12, patterns: [/\bDWH\b/i, /ClickHouse/i, /Vertica/i, /Superset/i, /Tableau/i, /Power ?BI/i] },
  integrations: { weight: 12, patterns: [/\bREST\b/i, /\bSOAP\b/i, /микросервис/i, /Swagger/i, /Postman/i] },
  artifacts:    { weight: 10, patterns: [/\bBRD\b/i, /\bFSD\b/i, /\bSRS\b/i, /user stor/i, /Gherkin/i, /acceptance criteria/i] },
  product:      { weight: 8,  patterns: [/\bCJM\b/i, /A\/B/i, /юнит[- ]эконом/i, /\bROI\b/i, /когортн/i] },
  bpmn:         { weight: 6,  patterns: [/\bBPMN\b/i] },
  uml:          { weight: 6,  patterns: [/\bUML\b/i] },
  kafka:        { weight: 8,  patterns: [/\bKafka\b/i] },
};

export function scoreVacancy(v: Vacancy, weights: KeywordWeights = DEFAULT_WEIGHTS): ScoreResult {
  const haystack = `${v.title}\n${v.description}`;
  const matched: string[] = [];
  let total = 0;

  for (const [key, { weight, patterns }] of Object.entries(weights)) {
    if (patterns.some((re) => re.test(haystack))) {
      matched.push(key);
      total += weight;
    }
  }

  return { score: Math.min(100, total), matched: matched.sort() };
}
