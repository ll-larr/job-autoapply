import type { Vacancy } from './vacancy.js';
import type { Skill } from './specialty.js';
import { BA_SKILLS } from './specialty-defaults.js';
import { hasInNormalized, normalizeForMatch } from './matching.js';

export interface ScoreResult {
  score: number;
  /** id совпавших навыков, по алфавиту. Идут в письмо и в выбор скелета. */
  matched: string[];
  /**
   * true, если совпал хотя бы один навык-ядро. Также true, если в профиле нет
   * ни одного ядра с ненулевым весом: гейту нечего требовать (спека 3.3).
   */
  hasCoreMatch: boolean;
}

/**
 * Сумма весов бизнес-аналитика на 2026-09-18 (28+24+22+8+8+6+6+6+5). Скор
 * нормируется на сумму весов профиля и растягивается на это число, поэтому
 * для БА формула сводится ровно к прежней `min(100, совпавшие_веса)`, а у
 * любого другого профиля шкала остаётся 0–100 и порог minScore не теряет
 * смысла.
 */
export const SCORE_REFERENCE_TOTAL = 113;

/**
 * Навык совпал, если в заголовке или описании нашёлся любой его синоним (см.
 * core/matching.ts). Навык с весом 0 выключен целиком: не совпадает, не
 * считается в сумму и не участвует в гейте ядра.
 */
export function scoreVacancy(
  v: Pick<Vacancy, 'title' | 'description'>,
  skills: readonly Skill[] = BA_SKILLS,
): ScoreResult {
  const haystack = normalizeForMatch(`${v.title}\n${v.description}`);
  const matched: string[] = [];
  let matchedWeight = 0;
  let totalWeight = 0;
  let hasCore = false;
  let coreRequired = false;

  for (const skill of skills) {
    if (skill.weight <= 0) continue;
    totalWeight += skill.weight;
    if (skill.core) coreRequired = true;
    if (skill.synonyms.some((t) => hasInNormalized(haystack, t))) {
      matched.push(skill.id);
      matchedWeight += skill.weight;
      if (skill.core) hasCore = true;
    }
  }

  const score = totalWeight === 0
    ? 0
    : Math.min(100, Math.round((matchedWeight * SCORE_REFERENCE_TOTAL) / totalWeight));
  return { score, matched: matched.sort(), hasCoreMatch: hasCore || !coreRequired };
}
