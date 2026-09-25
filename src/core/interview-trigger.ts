import { spawn as nodeSpawn } from 'node:child_process';
import type { Vacancy } from './vacancy.js';
import type { GigarecruiterConfig } from './config.js';

/**
 * Триггер автоответа ГигаРекрутёру (спека 2026-09-25, 3.1): отклик на
 * вакансию Сбера открывает окно и поднимает демон. Ни живым рекрутёрам, ни
 * другим скрининг-ботам эта машина не отвечает (спека, раздел 1) — вакансия
 * должна быть Сбера, и только она.
 */
const SBER_RE = /сбер|sber/i;

/** Компания или заголовок вакансии совпадает с /сбер|sber/i. */
export function isSberVacancy(v: Pick<Vacancy, 'company' | 'title'>): boolean {
  return SBER_RE.test(v.company) || SBER_RE.test(v.title);
}

export interface TriggerDeps {
  /** Нет блока — автоответ не настроен в config.json, триггер не срабатывает. */
  config: GigarecruiterConfig | undefined;
  now(): number;
  openWindow(now: number, minutes: number): void;
  spawnInterview(): void;
}

/**
 * Отклик отправлен успешно. Если это вакансия Сбера и `gigarecruiter`
 * настроен — открывает окно на `windowMinutes` и поднимает демон отдельным
 * процессом (спека 3.1). Возвращает true, если оба действия выполнены.
 */
export function triggerInterview(v: Pick<Vacancy, 'company' | 'title'>, deps: TriggerDeps): boolean {
  if (deps.config === undefined || !isSberVacancy(v)) return false;
  deps.openWindow(deps.now(), deps.config.windowMinutes);
  deps.spawnInterview();
  return true;
}

/** То, что реально нужно от child_process.spawn — узкая инъекция, как fetchImpl/DiscoveryDeps в proxy.ts. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; detached: boolean; stdio: 'ignore'; windowsHide: boolean },
) => { unref(): void };

export interface SpawnInterviewDeps {
  spawn?: SpawnFn;
}

/**
 * Боевой запуск `npm run interview` отдельным, отсоединённым процессом,
 * переживающим завершение `npm run send` (спека 3.1, 3.5). Второй экземпляр,
 * если он уже идёт, сам выйдет по блокировке (interview-runner.ts, задача 7)
 * — а продлённое окно он подхватит при следующем чтении состояния.
 */
export function spawnInterview(repoRoot: string, deps: SpawnInterviewDeps = {}): void {
  const spawnFn = deps.spawn ?? nodeSpawn;
  spawnFn('cmd.exe', ['/c', 'npm', 'run', 'interview'], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}
