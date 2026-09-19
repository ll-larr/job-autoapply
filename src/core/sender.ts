import { existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Queue } from './queue.js';
import type { Config } from './config.js';
import type { Adapter, ApplyResult } from '../adapters/types.js';

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
  /**
   * Первая остановка за прогон. Оставлено ради панели и прежних вызовов:
   * полный список — в haltedSources ниже.
   */
  halted: null | { source: string; reason: HaltReason };
  /**
   * Sources that had rows due to send but no `config.throttle` entry, so
   * their rows were skipped (left `approved`, never sent unthrottled).
   * Sorted, deduplicated. Empty when every source with pending rows was
   * correctly configured. The caller is responsible for surfacing this —
   * a skip that nobody looks at is as bad as no protection at all.
   */
  unthrottledSources: string[];
  /**
   * Площадки, отвалившиеся по своей причине, и эта причина. Прогон по ним
   * прекращается, по остальным продолжается.
   *
   * Раньше первая же капча или требование логина обрывали ВЕСЬ прогон. Пока
   * площадка была одна, разницы не было. С появлением careerist.ru, где
   * отклик пока в принципе невозможен без аккаунта и apply() честно отвечает
   * `auth_required`, разница стала решающей: одна такая заявка в очереди
   * означала бы, что до заявок на hh.ru отправка не доходит вообще.
   *
   * Строки отвалившейся площадки остаются `approved` и уйдут в следующий
   * прогон — ровно как и раньше.
   */
  haltedSources: Array<{ source: string; reason: HaltReason }>;
  /**
   * Заголовки заявок, пропущенных из-за пустого письма. Они остались
   * `approved` и уйдут, как только письмо появится (`npm run letters`).
   *
   * Молчать об этом нельзя: «Отправлено 0» при шести одобренных заявках
   * неотличимо от поломки отправки.
   */
  skippedEmptyLetter: string[];
}

/**
 * Почему прогон по площадке (или весь прогон, в случае `killed`) прекращён.
 * `killed` — единственная причина, останавливающая всё сразу: это человек
 * нажал стоп, и продолжать «по другим площадкам» тут было бы прямым
 * неподчинением.
 */
export type HaltReason = 'captcha' | 'auth_required' | 'killed' | 'too_many_failures';

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
    const report: SendReport = {
      sent: 0, failed: 0, halted: null, unthrottledSources: [], haltedSources: [],
      skippedEmptyLetter: [],
    };
    const rows = this.queue.listByStatus('approved');
    const consecutiveFailures = new Map<string, number>();
    const maxConsecutiveFailures = this.config.maxConsecutiveFailures ?? 3;
    const unthrottledSources = new Set<string>();
    const emptyLetters: string[] = [];
    // Площадки, по которым прогон уже прекращён. Их строки пропускаются и
    // остаются approved; остальные площадки работают дальше.
    const halted = new Map<string, HaltReason>();

    const haltSource = (source: string, reason: HaltReason): void => {
      if (halted.has(source)) return;
      halted.set(source, reason);
      report.haltedSources.push({ source, reason });
      // Первая остановка попадает и в halted — прежний контракт отчёта.
      report.halted ??= { source, reason };
    };

    for (const row of rows) {
      // Проверка перед каждой подачей: незавершённое остаётся approved.
      if (this.stopRequested()) {
        // Единственная причина, обрывающая весь прогон, а не одну площадку:
        // это человек нажал стоп.
        haltSource('-', 'killed');
        report.unthrottledSources = [...unthrottledSources].sort();
        report.skippedEmptyLetter = emptyLetters;
        return report;
      }

      // Площадка уже отвалилась в этом прогоне — её строки не трогаем, они
      // остаются approved и дождутся следующего запуска.
      if (halted.has(row.source)) continue;

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

      // Считаем только те окна, для которых лимит вообще задан: незаданный
      // потолок означает «без ограничения», и лишний запрос к базе на каждой
      // заявке в этом случае не нужен.
      if (rule.maxPerHour !== undefined) {
        const inHour = this.queue.countSentSince(row.source, this.now() - HOUR);
        // Лимит достигнут — запись остаётся approved и уйдёт в следующий прогон.
        if (inHour >= rule.maxPerHour) continue;
      }
      if (rule.maxPerDay !== undefined) {
        const inDay = this.queue.countSentSince(row.source, this.now() - DAY);
        if (inDay >= rule.maxPerDay) continue;
      }

      // Пустое письмо не отправляется никогда.
      //
      // Вся очередь построена вокруг того, что человек письмо прочитал и
      // одобрил. Строка может дойти до approved и БЕЗ письма: генерация
      // падает от 429 бесплатной модели или пропавшего ключа, а человек
      // одобряет вакансию, а не текст. Отправить её значило бы подать голый
      // отклик от его имени — ровно то, что уже случилось однажды на hh.ru и
      // чего он не выбирал.
      //
      // Строка остаётся approved, а не уходит в failed: письмо дозаполняется
      // командой `npm run letters`, после чего заявка уйдёт следующим
      // прогоном сама.
      if (row.letter.trim() === '') {
        emptyLetters.push(row.vacancy.title);
        continue;
      }

      // Исключение из адаптера — отказ этой заявки, а не конец всей
      // отправки. 2026-09-19 клик по кнопке отклика архивной вакансии
      // выбросил таймаут, и остальные двадцать заявок так и не ушли. В
      // счётчик поломки такой отказ идёт как обычный: череда исключений —
      // ровно то, от чего он защищает.
      let result: ApplyResult;
      try {
        result = await adapter.apply(row.vacancy, row.letter);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = { status: 'failed', reason: `адаптер ${row.source} упал: ${message.split('\n')[0]!.slice(0, 200)}` };
      }

      if (result.status === 'closed') {
        this.queue.markFailed(row.id, 'вакансия закрыта или в архиве — откликаться некуда');
        report.failed++;
        continue;
      }

      if (result.status === 'captcha' || result.status === 'auth_required') {
        // Запись НЕ помечается failed — она остаётся approved и будет
        // обработана после того, как человек разберётся с капчей или логином.
        // Narrowed by an explicit tag comparison rather than
        // isHaltingResult(): that helper returns a plain boolean, not a
        // type predicate, so it wouldn't narrow `result` here and
        // `result.status` would need an unproven cast to fit the report's
        // narrower reason field.
        //
        // Останавливается ТОЛЬКО эта площадка. Капча на hh.ru ничего не
        // говорит о hr.ge, а careerist.ru, где отклик пока требует аккаунта,
        // иначе блокировал бы отправку на hh.ru целиком.
        haltSource(row.source, result.status);
        continue;
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
          // Тоже по площадке: череда отказов на одной ничего не доказывает
          // про другую.
          haltSource(row.source, 'too_many_failures');
          continue;
        }
      }

      const span = rule.maxDelayMs - rule.minDelayMs;
      await this.sleep(rule.minDelayMs + Math.floor(this.random() * (span + 1)));
    }

    report.unthrottledSources = [...unthrottledSources].sort();
    report.skippedEmptyLetter = emptyLetters;
    return report;
  }
}
