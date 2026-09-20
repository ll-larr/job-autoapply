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
     * С 2026-09-18 — только для засева: такая фраза становится специальностью
     * «Системный аналитик» с опытом 0 (core/settings.ts). Раньше реализовано через
     * core/screening.ts#isJuniorExperience (переиспользует
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
   * Фразы поиска до 2026-09-18. С тех пор фразы живут в специальностях
   * data/settings.json, а это поле читается один раз — при засеве настроек
   * (core/settings.ts#seedSettings): фразы с juniorOnly становятся
   * «Системным аналитиком», остальные — «Бизнес-аналитиком». Необязательно.
   */
  searchQueries?: SearchQueryConfig[];
  throttle: Record<string, ThrottleRule | undefined>;
  /**
   * Сколько отказов подряд по одной площадке считать поломкой и останавливать
   * отправку. По умолчанию 3. Это предохранитель на случай, когда адаптер не
   * распознал капчу или сменившуюся вёрстку: без него такая ситуация выглядит
   * как череда обычных failed, и очередь продолжает долбить площадку.
   */
  maxConsecutiveFailures?: number;
  /**
   * Ответ на вопрос анкеты hh.ru о зарплатных ожиданиях (см. core/questions.ts).
   * В резюме этого нет, а придумывать число модели нельзя. Не задано —
   * «Готов обсудить на собеседовании».
   */
  salaryExpectation?: string;
  /** Настройки бота-приёмника (спека 2026-09-20). Нет блока — команда `bot` не запускается. */
  bot?: BotConfig;
}

/** Лимиты бота (спека 2026-09-20, раздел 6). Значения — стартовые, правятся в config.json. */
export interface BotLimits {
  perChatPerDay: number;
  perBotPerDay: number;
  minIntervalMs: number;
  strikesBeforeMute: number;
  muteHours: number;
  meetingsPerChatPerDay: number;
}

export const DEFAULT_BOT_LIMITS: BotLimits = {
  perChatPerDay: 20,
  perBotPerDay: 200,
  minIntervalMs: 3000,
  strikesBeforeMute: 5,
  muteHours: 24,
  meetingsPerChatPerDay: 3,
};

export interface BotConfig {
  profile: { github: string; telegram: string };
  /** Модели для ответов рекрутёру. Не задано — те же, что у писем. */
  models?: string[];
  limits?: Partial<BotLimits>;
}

export interface ResolvedBotConfig {
  profile: { github: string; telegram: string };
  models: string[];
  limits: BotLimits;
}

/**
 * Блока `bot` нет — бот не запускается и говорит, чего не хватает. Молчаливые
 * умолчания тут опасны: без github и telegram рекрутёр получил бы ответ с
 * пустыми ссылками и ушёл ни с чем.
 */
export function resolveBotConfig(config: Config): ResolvedBotConfig {
  const bot = config.bot;
  if (bot === undefined) {
    throw new Error('config.json: нет блока "bot" — добавь profile.github, profile.telegram');
  }
  const { github, telegram } = bot.profile ?? { github: '', telegram: '' };
  if (typeof github !== 'string' || github === '' || typeof telegram !== 'string' || telegram === '') {
    throw new Error('config.json: bot.profile.github и bot.profile.telegram обязательны');
  }
  const models = bot.models !== undefined && bot.models.length > 0 ? bot.models : config.letterModels;
  return { profile: { github, telegram }, models, limits: { ...DEFAULT_BOT_LIMITS, ...bot.limits } };
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
  if (parsed.searchQueries !== undefined && !Array.isArray(parsed.searchQueries)) {
    throw new Error('loadConfig: searchQueries, если задан, должен быть списком');
  }
  for (const [i, qc] of (parsed.searchQueries ?? []).entries()) {
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
    // minDelayMs/maxDelayMs объявлены обязательными (не optional) в
    // ThrottleRule, но JSON.parse ничего не проверяет во время выполнения —
    // {"hh": {}} проходило бы мимо этого блока незамеченным. rule.minDelayMs
    // > rule.maxDelayMs при обоих undefined даёт `undefined > undefined`,
    // то есть false — запись с пустым объектом раньше молча считалась
    // валидной. В sender.ts это оборачивается NaN-задержкой: setTimeout(NaN)
    // срабатывает немедленно, и заявки на площадку уходят без пауз — ровно
    // то, что "Fail closed" в sender.ts существует, чтобы предотвратить.
    // Отсутствующая ЗАПИСЬ про площадку — это "не отправлять вовсе" (см.
    // sender.ts), а отсутствующее ПОЛЕ внутри существующей записи должно
    // быть настоящей ошибкой конфига, а не тихим "без паузы".
    if (
      typeof rule.minDelayMs !== 'number'
      || !Number.isFinite(rule.minDelayMs)
      || rule.minDelayMs < 0
    ) {
      throw new Error(`loadConfig: ${site}: minDelayMs обязателен и должен быть конечным числом >= 0`);
    }
    if (
      typeof rule.maxDelayMs !== 'number'
      || !Number.isFinite(rule.maxDelayMs)
      || rule.maxDelayMs < 0
    ) {
      throw new Error(`loadConfig: ${site}: maxDelayMs обязателен и должен быть конечным числом >= 0`);
    }
    if (rule.minDelayMs > rule.maxDelayMs) {
      throw new Error(`loadConfig: ${site}: minDelayMs больше maxDelayMs`);
    }
    // maxPerHour/maxPerDay остаются НЕобязательными — отсутствие поля
    // сознательно означает «без ограничения» (см. комментарий у ThrottleRule
    // в этом же файле) и должно остаться возможным. Но если поле задано, оно
    // обязано быть настоящим положительным пределом: 0 или отрицательное
    // число означало бы «никогда не отправлять» под видом лимита, а NaN/
    // Infinity — тихую поломку сравнения в sender.ts (countSentSince >= cap).
    if (
      rule.maxPerHour !== undefined
      && (typeof rule.maxPerHour !== 'number' || !Number.isFinite(rule.maxPerHour) || rule.maxPerHour <= 0)
    ) {
      throw new Error(`loadConfig: ${site}: maxPerHour должен быть конечным положительным числом`);
    }
    if (
      rule.maxPerDay !== undefined
      && (typeof rule.maxPerDay !== 'number' || !Number.isFinite(rule.maxPerDay) || rule.maxPerDay <= 0)
    ) {
      throw new Error(`loadConfig: ${site}: maxPerDay должен быть конечным положительным числом`);
    }
  }
  return parsed;
}
