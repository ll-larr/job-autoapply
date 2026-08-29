import { readFileSync } from 'node:fs';

export interface ThrottleRule {
  maxPerHour: number;
  maxPerDay: number;
  minDelayMs: number;
  maxDelayMs: number;
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
  throttle: Record<string, ThrottleRule | undefined>;
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
  for (const [site, rule] of Object.entries(parsed.throttle ?? {})) {
    if (!rule) continue;
    if (rule.minDelayMs > rule.maxDelayMs) {
      throw new Error(`loadConfig: ${site}: minDelayMs больше maxDelayMs`);
    }
  }
  return parsed;
}
