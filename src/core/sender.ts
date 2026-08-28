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
    const rows = this.queue.listByStatus('approved');

    // Fail closed. A source with an adapter but no config.throttle entry
    // is a configuration bug (typo, or a new adapter whose throttle entry
    // was never added) — not permission to send at unlimited speed. This
    // module exists solely to keep the user's hh.ru account from getting
    // banned for inhuman send rates, so treating "no rule" as "no limit"
    // would be the exact opposite of its purpose.
    //
    // Abort the whole run before anything is sent, rather than skipping
    // only the misconfigured source's rows: a run that quietly sends for
    // every *other* source while one is missing its rule is still a
    // silent hole in the protection, and the point of this check is that
    // a missing throttle entry must never be silent. Throwing before the
    // loop starts means nothing has been touched — every row for every
    // source is still exactly 'approved' and gets retried automatically
    // on the next run once the human fixes config.json.
    const missingRuleSources = new Set<string>();
    for (const row of rows) {
      if (this.adapters.has(row.source) && this.config.throttle[row.source] === undefined) {
        missingRuleSources.add(row.source);
      }
    }
    if (missingRuleSources.size > 0) {
      const sources = [...missingRuleSources].sort().join(', ');
      throw new Error(
        `Sender: в config.throttle отсутствуют правила для площадок: ${sources} — ` +
          'отправка остановлена до исправления конфигурации, ни одна заявка не отправлена',
      );
    }

    for (const row of rows) {
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
      if (rule === undefined) {
        // Unreachable: the preflight check above already aborted the run
        // if any adapter-backed source had no throttle rule. Thrown rather
        // than asserted away with `!`, so a future change that breaks that
        // guarantee fails loudly here instead of silently reintroducing
        // the fail-open bug this check exists to prevent.
        throw new Error(`Sender: internal invariant violated — no throttle rule for ${row.source}`);
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
        return report;
      }

      if (result.status === 'sent' || result.status === 'already_applied') {
        this.queue.markSent(row.id);
        report.sent++;
      } else if (result.status === 'failed') {
        // The two halting tags returned above; the only tag left in the
        // union at this point is 'failed', proven by exhaustive tag
        // comparison rather than assumed — so `result.reason` is safe
        // without a cast, and stays sound if ApplyResult ever grows a
        // new tag.
        this.queue.markFailed(row.id, result.reason);
        report.failed++;
      }

      const span = rule.maxDelayMs - rule.minDelayMs;
      await this.sleep(rule.minDelayMs + Math.floor(this.random() * (span + 1)));
    }

    return report;
  }
}
