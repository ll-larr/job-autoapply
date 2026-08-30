import { readFileSync } from 'node:fs';

export interface ThrottleRule {
  /**
   * Потолок подач в час. Отсутствие поля означает «без ограничения» — так его
   * задал владелец аккаунта, и это честнее числа-заглушки вроде миллиона:
   * заглушку через полгода прочтут как настоящий лимит и будут гадать, откуда
   * взялась цифра.
   *
   * Обрати внимание: отсутствие ПОЛЯ и отсутствие всей записи про площадку —
   * разные вещи. Записи нет — площадка не шлёт вовсе (см. Sender: это защита
   * от опечатки в конфиге, которая иначе означала бы отправку без лимитов).
   * Запись есть, а поля нет — лимит снят сознательно.
   */
  maxPerHour?: number;
  /** Потолок подач в сутки. Отсутствие поля — без ограничения. См. maxPerHour. */
  maxPerDay?: number;
  minDelayMs: number;
  maxDelayMs: number;
}

/**
 * Одна из нескольких формулировок поискового запроса — разные фразы находят
 * разные вакансии на одной и той же площадке (см. src/pipeline.ts). Опция
 * constraints добавлена 2026-08-30 по прямому разбору пользователем первой
 * живой очереди: запрос "системный аналитик" должен искать только
 * junior-уровень, остальные четыре формулировки — без ограничения.
 */
export interface SearchQueryConfig {
  query: string;
  constraints?: {
    /**
     * Реализовано через core/screening.ts#isJuniorExperience (переиспользует
     * существующий примитив опыта, а не отдельную заголовочную эвристику
     * "junior/middle/senior") — см. wiring в src/pipeline.ts.
     */
    juniorOnly?: boolean;
  };
}

export interface Config {
  minScore: number;
  letterFullThreshold: number;
  /**
   * Модели OpenRouter для генерации писем, в порядке попытки. Первая,
   * которая вернула успешный ответ, используется; остальные — фолбэк.
   * Непустой список обязателен: без него generateLetter не с чем пробовать.
   */
  letterModels: string[];
  /**
   * Список запросов для `npm run search` без явного аргумента (см.
   * src/cli.ts#resolveSearchQueries). Непустой список обязателен по тем же
   * причинам, что и letterModels — без него дефолтный прогон search не с
   * чем запускать.
   */
  searchQueries: SearchQueryConfig[];
  throttle: Record<string, ThrottleRule | undefined>;
  /**
   * Сколько отказов подряд по одной площадке считать поломкой и останавливать
   * отправку. По умолчанию 3. Это предохранитель на случай, когда адаптер не
   * распознал капчу или сменившуюся вёрстку: без него такая ситуация выглядит
   * как череда обычных failed, и очередь продолжает долбить площадку.
   */
  maxConsecutiveFailures?: number;
}

export function loadConfig(path = 'config.json'): Config {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Config;

  if (typeof parsed.minScore !== 'number' || typeof parsed.letterFullThreshold !== 'number') {
    throw new Error('loadConfig: minScore и letterFullThreshold обязательны и должны быть числами');
  }
  if (parsed.letterFullThreshold < parsed.minScore) {
    throw new Error(
      `loadConfig: letterFullThreshold (${parsed.letterFullThreshold}) ниже minScore (${parsed.minScore}) — режим full недостижим`,
    );
  }
  if (
    !Array.isArray(parsed.letterModels)
    || parsed.letterModels.length === 0
    || !parsed.letterModels.every((m) => typeof m === 'string' && m.trim() !== '')
  ) {
    throw new Error('loadConfig: letterModels обязателен и должен быть непустым списком строк');
  }
  if (!Array.isArray(parsed.searchQueries) || parsed.searchQueries.length === 0) {
    throw new Error('loadConfig: searchQueries обязателен и должен быть непустым списком');
  }
  for (const [i, qc] of parsed.searchQueries.entries()) {
    if (qc === null || typeof qc !== 'object' || typeof qc.query !== 'string' || qc.query.trim() === '') {
      throw new Error(`loadConfig: searchQueries[${i}].query обязателен и должен быть непустой строкой`);
    }
    if (qc.constraints !== undefined) {
      if (typeof qc.constraints !== 'object' || qc.constraints === null) {
        throw new Error(`loadConfig: searchQueries[${i}].constraints должен быть объектом`);
      }
      if (
        qc.constraints.juniorOnly !== undefined
        && typeof qc.constraints.juniorOnly !== 'boolean'
      ) {
        throw new Error(`loadConfig: searchQueries[${i}].constraints.juniorOnly должен быть boolean`);
      }
    }
  }
  for (const [site, rule] of Object.entries(parsed.throttle ?? {})) {
    if (!rule) continue;
    if (rule.minDelayMs > rule.maxDelayMs) {
      throw new Error(`loadConfig: ${site}: minDelayMs больше maxDelayMs`);
    }
  }
  return parsed;
}
