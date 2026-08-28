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
  for (const [site, rule] of Object.entries(parsed.throttle ?? {})) {
    if (!rule) continue;
    if (rule.minDelayMs > rule.maxDelayMs) {
      throw new Error(`loadConfig: ${site}: minDelayMs больше maxDelayMs`);
    }
  }
  return parsed;
}
