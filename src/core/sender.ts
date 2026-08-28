import { existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Queue } from './queue.js';
import type { Config } from './config.js';
import type { Adapter } from '../adapters/types.js';
import { isHaltingResult } from '../adapters/types.js';

const STOP_FLAG = 'data/STOP';

/** Kill switch. Флаг-файл, а не сигнал: остановить надо уметь из другого терминала. */
export function requestStop(): void {
  mkdirSync(dirname(STOP_FLAG), { recursive: true });
  writeFileSync(STOP_FLAG, new Date().toISOString(), 'utf8');
}

export function clearStop(): void {
  rmSync(STOP_FLAG, { force: true });
}

export function isStopRequested(): boolean {
  return existsSync(STOP_FLAG);
}

export interface SendReport {
  sent: number;
  failed: number;
  halted: null | { source: string; reason: 'captcha' | 'auth_required' | 'killed' };
}

interface Deps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  stopRequested?: () => boolean;
}

const HOUR = 3600_000;
const DAY = 86_400_000;

export class Sender {
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private random: () => number;
  private stopRequested: () => boolean;

  constructor(
    private queue: Queue,
    private adapters: Map<string, Adapter>,
    private config: Config,
    deps: Deps = {},
  ) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? Math.random;
    this.stopRequested = deps.stopRequested ?? isStopRequested;
  }

  async run(): Promise<SendReport> {
    const report: SendReport = { sent: 0, failed: 0, halted: null };

    for (const row of this.queue.listByStatus('approved')) {
      // Проверка перед каждой подачей: незавершённое остаётся approved.
      if (this.stopRequested()) {
        report.halted = { source: '-', reason: 'killed' };
        return report;
      }

      const adapter = this.adapters.get(row.source);
      if (adapter === undefined) {
        this.queue.markFailed(row.id, `нет адаптера для площадки ${row.source}`);
        report.failed++;
        continue;
      }

      const rule = this.config.throttle[row.source];
      if (rule !== undefined) {
        const inHour = this.queue.countSentSince(row.source, this.now() - HOUR);
        const inDay = this.queue.countSentSince(row.source, this.now() - DAY);
        // Лимит достигнут — запись остаётся approved и уйдёт в следующий прогон.
        if (inHour >= rule.maxPerHour || inDay >= rule.maxPerDay) continue;
      }

      const result = await adapter.apply(row.vacancy, row.letter);

      if (isHaltingResult(result)) {
        // Запись НЕ помечается failed — она остаётся approved и будет
        // обработана после того, как человек разберётся с капчей или логином.
        report.halted = {
          source: row.source,
          reason: result.status as 'captcha' | 'auth_required',
        };
        return report;
      }

      if (result.status === 'sent' || result.status === 'already_applied') {
        this.queue.markSent(row.id);
        report.sent++;
      } else if (result.status === 'failed') {
        // isHaltingResult() above already returned for captcha/auth_required,
        // so at runtime this is the only branch left. isHaltingResult()
        // returns a plain boolean rather than a type predicate, so the
        // compiler can't narrow that on its own — checking the tag
        // explicitly here (instead of a catch-all `else`) is what lets it
        // see `result.reason` as safe, and stays sound if ApplyResult ever
        // grows a new tag.
        this.queue.markFailed(row.id, result.reason);
        report.failed++;
      }

      if (rule !== undefined) {
        const span = rule.maxDelayMs - rule.minDelayMs;
        await this.sleep(rule.minDelayMs + Math.floor(this.random() * (span + 1)));
      }
    }

    return report;
  }
}
