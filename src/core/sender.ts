import { existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Queue } from './queue.js';
import type { Config } from './config.js';
import type { Adapter } from '../adapters/types.js';

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
  halted: null | { source: string; reason: 'captcha' | 'auth_required' | 'killed' | 'too_many_failures' };
  /**
   * Sources that had rows due to send but no `config.throttle` entry, so
   * their rows were skipped (left `approved`, never sent unthrottled).
   * Sorted, deduplicated. Empty when every source with pending rows was
   * correctly configured. The caller is responsible for surfacing this —
   * a skip that nobody looks at is as bad as no protection at all.
   */
  unthrottledSources: string[];
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
    const report: SendReport = { sent: 0, failed: 0, halted: null, unthrottledSources: [] };
    const rows = this.queue.listByStatus('approved');
    const consecutiveFailures = new Map<string, number>();
    const maxConsecutiveFailures = this.config.maxConsecutiveFailures ?? 3;
    const unthrottledSources = new Set<string>();

    for (const row of rows) {
      // Проверка перед каждой подачей: незавершённое остаётся approved.
      if (this.stopRequested()) {
        report.halted = { source: '-', reason: 'killed' };
        report.unthrottledSources = [...unthrottledSources].sort();
        return report;
      }

      const adapter = this.adapters.get(row.source);
      if (adapter === undefined) {
        this.queue.markFailed(row.id, `нет адаптера для площадки ${row.source}`);
        report.failed++;
        continue;
      }

      const rule = this.config.throttle[row.source];
      if (rule === undefined) {
        // Fail closed, scoped to this source only. A source with an
        // adapter but no config.throttle entry is a configuration bug
        // (typo, or a new adapter whose throttle entry was never added) —
        // not permission to send at unlimited speed. This module exists
        // solely to keep the user's hh.ru account from getting banned for
        // inhuman send rates, so treating "no rule" as "no limit" would be
        // the exact opposite of its purpose.
        //
        // Skip only this row — never call apply() for it, leave it
        // approved so it's retried automatically once config.json is
        // fixed — rather than aborting the whole run. Every other,
        // correctly-configured source keeps sending normally: one
        // misconfigured adapter must not take down a working one. The gap
        // still can't be silent, though, so it's recorded in the report
        // for the caller to surface (see `unthrottledSources` above).
        unthrottledSources.add(row.source);
        continue;
      }

      const inHour = this.queue.countSentSince(row.source, this.now() - HOUR);
      const inDay = this.queue.countSentSince(row.source, this.now() - DAY);
      // Лимит достигнут — запись остаётся approved и уйдёт в следующий прогон.
      if (inHour >= rule.maxPerHour || inDay >= rule.maxPerDay) continue;

      const result = await adapter.apply(row.vacancy, row.letter);

      if (result.status === 'captcha' || result.status === 'auth_required') {
        // Запись НЕ помечается failed — она остаётся approved и будет
        // обработана после того, как человек разберётся с капчей или логином.
        // Narrowed by an explicit tag comparison rather than
        // isHaltingResult(): that helper returns a plain boolean, not a
        // type predicate, so it wouldn't narrow `result` here and
        // `result.status` would need an unproven cast to fit SendReport's
        // narrower 'captcha' | 'auth_required' field.
        report.halted = { source: row.source, reason: result.status };
        report.unthrottledSources = [...unthrottledSources].sort();
        return report;
      }

      if (result.status === 'sent' || result.status === 'already_applied') {
        this.queue.markSent(row.id);
        report.sent++;
        // Успех сбрасывает счётчик: предохранитель ловит именно череду отказов
        // подряд, а не их общее число за прогон.
        consecutiveFailures.set(row.source, 0);
      } else if (result.status === 'failed') {
        // The two halting tags returned above; the only tag left in the
        // union at this point is 'failed', proven by exhaustive tag
        // comparison rather than assumed — so `result.reason` is safe
        // without a cast, and stays sound if ApplyResult ever grows a
        // new tag.
        this.queue.markFailed(row.id, result.reason);
        report.failed++;

        // Предохранитель. Подряд идущие отказы по одной площадке означают, что
        // сломалось что-то общее, а не конкретная вакансия: слетела вёрстка,
        // сайт начал показывать капчу, которую адаптер не умеет распознать,
        // или аккаунт ограничили. Продолжать в таком состоянии значит долбить
        // площадку впустую и рисковать аккаунтом ради заведомо пустых подач.
        //
        // Это защита именно на тот случай, когда распознавание капчи НЕ
        // сработало: у адаптера hh.ru её детектор пока заглушка, и без этого
        // предохранителя капча выглядела бы как череда обычных failed.
        consecutiveFailures.set(row.source, (consecutiveFailures.get(row.source) ?? 0) + 1);
        if ((consecutiveFailures.get(row.source) ?? 0) >= maxConsecutiveFailures) {
          report.halted = { source: row.source, reason: 'too_many_failures' };
          report.unthrottledSources = [...unthrottledSources].sort();
          return report;
        }
      }

      const span = rule.maxDelayMs - rule.minDelayMs;
      await this.sleep(rule.minDelayMs + Math.floor(this.random() * (span + 1)));
    }

    report.unthrottledSources = [...unthrottledSources].sort();
    return report;
  }
}
