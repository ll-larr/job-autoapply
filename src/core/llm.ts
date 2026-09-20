import type { Config } from './config.js';
import type { Settings } from './settings.js';
import { setApiKey } from './openrouter.js';

/**
 * Проводка настроек модели (панель, вкладка «Настройки» → «Модель для писем»,
 * 2026-09-20) к тем двум местам, где они нужны: ключ — в openrouter.ts, выбор
 * модели — в `config.letterModels`, откуда его читают письма, личные
 * сообщения, анкета hh, «Предложить навыки» и бот.
 *
 * Почему config правится на месте, а не собирается новый. Объект конфига уже
 * захвачен замыканиями, собранными один раз на запуск панели (адаптеры,
 * startSearch, fillLetters — см. src/cli.ts), и все они читают
 * `config.letterModels` в момент вызова. Новый объект до них не дошёл бы, и
 * смена модели в панели начинала бы действовать только после перезапуска —
 * при том что рядом обещано «правка действует со следующего поиска».
 */

/**
 * Исходный letterModels конфига, по объекту конфига. Нужен, чтобы повторная
 * правка не накапливала список: выбрали sonnet, потом glm — должно выйти
 * [glm, ...исходные], а не [glm, sonnet, ...исходные].
 */
const baseModels = new WeakMap<Config, readonly string[]>();

/** Модели для писем при выбранной в панели модели. Выбранная — первая. */
export function orderModels(base: readonly string[], chosen: string | null): string[] {
  // Выбранная модель именно добавляется первой, а не заменяет список:
  // остальные остаются запасными. Модель отвечает 429 (общий лимит у
  // бесплатных) или 402 (кончились деньги), и без запасных письмо выходит
  // пустым — ровно та поломка, ради которой перебор в openrouter.ts и есть.
  if (chosen === null) return [...base];
  return [chosen, ...base.filter((m) => m !== chosen)];
}

/**
 * Применяет ключ и модель из настроек. Зовётся при старте каждой команды,
 * которой нужна модель, и после каждого сохранения настроек в панели.
 */
export function applyLlmSettings(config: Config, settings: Settings): void {
  const base = baseModels.get(config) ?? [...config.letterModels];
  baseModels.set(config, base);
  config.letterModels = orderModels(base, settings.llm.model);
  setApiKey(settings.llm.apiKey);
}
