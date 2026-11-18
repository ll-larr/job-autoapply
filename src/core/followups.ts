import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureBotSchema, ensureDialogSchema } from './schema.js';
import { complete, type CompletionOptions } from './openrouter.js';
import { withCandidate } from './profile.js';
import { findForbiddenClaim } from './letter.js';
import { findMixedScript } from './dm.js';
import { findLeak } from '../bot/reply.js';
import { classifyTgError, describeTgFailure, type TgFailure } from '../telegram/errors.js';
import type { TgHistory, TgSender } from '../telegram/types.js';
import type { FollowupsSettings, Settings } from './settings.js';
import type { Queue } from './queue.js';
import type { DialogsPort } from '../bot/secretary.js';

/**
 * Дожимы (спека 2026-10-09, 6.9): одно повторное сообщение рекрутёру, который
 * молчит после нашего первого. Уходит с аккаунта через GramJS — бот писать
 * первым не умеет. Необратимо, поэтому: выключено тумблером по умолчанию, один
 * дожим на контакт навсегда (UNIQUE), лимит общий с обычными сообщениями
 * Telegram, перед каждой отправкой — живая проверка истории чата.
 */

const DAY = 86_400_000;
export const FOLLOWUP_MIN = 40;
export const FOLLOWUP_MAX = 400;

export type FollowupStatus = 'draft' | 'sent' | 'cancelled' | 'failed';
export type FollowupTextMode = 'model' | 'template' | 'manual';

export interface FollowupRow {
  id: number;
  queueId: number;
  contact: string;
  status: FollowupStatus;
  text: string;
  textMode: FollowupTextMode;
  reason: string | null;
  createdAt: number;
  sentAt: number | null;
}

export interface FollowupCandidate {
  queueId: number;
  contact: string;
  title: string;
  sentAt: number;
}

export interface FollowupView extends FollowupRow {
  title: string;
  /** Когда мы писали первыми — для «писали N дн. назад». */
  firstSentAt: number | null;
}

interface RawRow {
  id: number; queue_id: number; contact: string; status: string; text: string; text_mode: string;
  reason: string | null; created_at: number; sent_at: number | null;
}

const toRow = (r: RawRow): FollowupRow => ({
  id: r.id, queueId: r.queue_id, contact: r.contact, status: r.status as FollowupStatus, text: r.text,
  textMode: r.text_mode as FollowupTextMode, reason: r.reason, createdAt: r.created_at, sentAt: r.sent_at,
});

export class FollowupStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    ensureBotSchema(this.db);
    ensureDialogSchema(this.db);
  }

  close(): void {
    this.db.close();
  }

  byId(id: number): FollowupRow | null {
    const r = this.db.prepare('SELECT * FROM followups WHERE id = ?').get(id) as unknown as RawRow | undefined;
    return r === undefined ? null : toRow(r);
  }

  list(): FollowupView[] {
    const rows = this.db.prepare('SELECT * FROM followups ORDER BY id DESC').all() as unknown as RawRow[];
    return rows.map((r) => {
      const app = this.db.prepare('SELECT vacancy_json, sent_at FROM applications WHERE id = ?')
        .get(r.queue_id) as unknown as { vacancy_json: string; sent_at: number | null } | undefined;
      const title = app === undefined ? '' : (JSON.parse(app.vacancy_json) as { title?: string }).title ?? '';
      return { ...toRow(r), title, firstSentAt: app?.sent_at ?? null };
    });
  }

  drafts(): FollowupRow[] {
    return (this.db.prepare("SELECT * FROM followups WHERE status = 'draft' ORDER BY id").all() as unknown as RawRow[]).map(toRow);
  }

  /** null — на этого контакта дожим уже есть (UNIQUE) в любом статусе. */
  insertDraft(queueId: number, contact: string, text: string, mode: FollowupTextMode, now: number): number | null {
    try {
      this.db.prepare(`
        INSERT INTO followups (queue_id, contact, status, text, text_mode, created_at) VALUES (?, ?, 'draft', ?, ?, ?)
      `).run(queueId, contact.toLowerCase(), text, mode, now);
    } catch {
      return null;
    }
    return (this.db.prepare('SELECT last_insert_rowid() AS id').get() as unknown as { id: number }).id;
  }

  /** Правка текста — только у черновика; текст становится «ручным». */
  setText(id: number, text: string): boolean {
    const r = this.db.prepare("UPDATE followups SET text = ?, text_mode = 'manual' WHERE id = ? AND status = 'draft'").run(text, id);
    return Number(r.changes) === 1;
  }

  cancel(id: number, reason: string): boolean {
    const r = this.db.prepare("UPDATE followups SET status = 'cancelled', reason = ? WHERE id = ? AND status = 'draft'").run(reason, id);
    return Number(r.changes) === 1;
  }

  markSent(id: number, at: number): void {
    this.db.prepare("UPDATE followups SET status = 'sent', sent_at = ?, reason = NULL WHERE id = ?").run(at, id);
  }

  markFailed(id: number, reason: string): void {
    this.db.prepare("UPDATE followups SET status = 'failed', reason = ? WHERE id = ?").run(reason, id);
  }

  /** Сколько дожимов ушло с момента — для общего дневного лимита Telegram. */
  sentSince(sinceMs: number): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM followups WHERE status = 'sent' AND sent_at >= ?")
      .get(sinceMs) as unknown as { n: number };
    return r.n;
  }

  /**
   * Кому пора дожимать (6.9): последняя наша отправка контакту в Telegram старше
   * afterDays и не старше maxAgeDays; дожима на него ещё не было; ответа и
   * встречи после отправки нет; нового сообщения ему мы сейчас не готовим.
   * `forContact` + `ignoreFollowup` — повторная проверка перед отправкой черновика.
   */
  candidates(now: number, s: FollowupsSettings, opts: { forContact?: string; ignoreFollowup?: boolean } = {}): FollowupCandidate[] {
    const rows = this.db.prepare(`
      SELECT a.id, a.contact, a.sent_at, a.vacancy_json FROM applications a
      WHERE a.source = 'tg' AND a.status = 'sent' AND a.contact IS NOT NULL
        AND (? IS NULL OR a.contact = ?)
        AND a.sent_at = (SELECT MAX(b.sent_at) FROM applications b WHERE b.source = 'tg' AND b.status = 'sent' AND b.contact = a.contact)
        AND a.sent_at <= ? AND a.sent_at >= ?
        AND (? = 1 OR NOT EXISTS (SELECT 1 FROM followups f WHERE f.contact = a.contact))
        AND NOT EXISTS (
          SELECT 1 FROM dialogs d JOIN dialog_events e ON e.dialog_id = d.id
          WHERE d.channel = 'business' AND d.username = a.contact AND e.kind = 'in' AND e.at > a.sent_at)
        AND NOT EXISTS (SELECT 1 FROM bot_meetings m WHERE m.username = a.contact AND m.created_at > a.sent_at)
        AND NOT EXISTS (SELECT 1 FROM applications c WHERE c.contact = a.contact AND c.status IN ('pending', 'approved'))
      ORDER BY a.sent_at ASC
    `).all(
      opts.forContact ?? null, opts.forContact ?? null,
      now - s.afterDays * DAY, now - s.maxAgeDays * DAY, opts.ignoreFollowup === true ? 1 : 0,
    ) as unknown as Array<{ id: number; contact: string; sent_at: number; vacancy_json: string }>;
    return rows.map((r) => ({
      queueId: r.id, contact: r.contact, sentAt: r.sent_at,
      title: (JSON.parse(r.vacancy_json) as { title?: string }).title ?? '',
    }));
  }
}

// --- текст дожима ---

export function followupTemplate(title: string): string {
  return `Привет! Это снова Хаер, ИИ ассистент кандидата. Недавно писал тебе по вакансии «${title}». `
    + 'Если опыт кандидата интересен, напиши мне: пришлю резюме или запишу на собеседование.';
}

export function buildFollowupMessages(title: string, daysAgo: number) {
  return [
    {
      role: 'system' as const,
      content: `${withCandidate(`Ты — «HIRE! Agent», тебя зовут Хаер: ИИ ассистент кандидата. ${daysAgo} дн. назад ты написал рекрутёру первым по вакансии из данных ниже, ответа не было.`)}
Напиши одно короткое повторное сообщение: одно-два предложения, не длиннее 300 символов, на «ты». Напомни про вакансию по названию, без ссылки. Предложи прислать резюме или записать на собеседование. Не повторяй первое сообщение, не добавляй фактов о кандидате, не называй чисел, не дави, не извиняйся, без эмодзи. Верни только текст.`,
    },
    { role: 'user' as const, content: `=== НАЗВАНИЕ ВАКАНСИИ (ДАННЫЕ) ===\n${title.replace(/={3,}/g, '= = =').slice(0, 200)}\n=== КОНЕЦ ДАННЫХ ===` },
  ];
}

/** null — текст годен. Цифры допустимы только те, что стоят в названии вакансии. */
export function followupTextProblem(text: string, title: string): string | null {
  const t = text.trim();
  if (t.length < FOLLOWUP_MIN) return `короче ${FOLLOWUP_MIN} символов`;
  if (t.length > FOLLOWUP_MAX) return `длиннее ${FOLLOWUP_MAX} символов`;
  if (/https?:\/\/|www\.|t\.me\/|\{\{/i.test(t)) return 'ссылка или плейсхолдер';
  const allowedDigits = new Set(title.match(/\d+/g) ?? []);
  for (const n of t.match(/\d+/g) ?? []) if (!allowedDigits.has(n)) return `число, которого нет в названии: ${n}`;
  const claim = findForbiddenClaim(t);
  if (claim !== null) return `выдуман навык: ${claim}`;
  const mixed = findMixedScript(t);
  if (mixed !== null) return `смесь латиницы и кириллицы в слове «${mixed}»`;
  const leak = findLeak(t);
  if (leak !== null) return `в ответе ${leak}`;
  return null;
}

/** Модель пишет текст; не вышло или не прошёл проверку — шаблон. Дожим без текста не бывает. */
export async function generateFollowupText(
  title: string, daysAgo: number, options: CompletionOptions,
): Promise<{ text: string; mode: 'model' | 'template' }> {
  const r = await complete(buildFollowupMessages(title, daysAgo), options, (t) => followupTextProblem(t, title));
  return r.ok ? { text: r.text.trim(), mode: 'model' } : { text: followupTemplate(title), mode: 'template' };
}

export interface PrepareDeps {
  store: FollowupStore;
  settings: () => Settings;
  now: () => number;
  generate: (title: string, daysAgo: number) => Promise<{ text: string; mode: 'model' | 'template' }>;
}

/** Черновики для всех, кому пора дожимать и у кого их ещё нет. Отправка — отдельным шагом. */
export async function prepareFollowups(deps: PrepareDeps): Promise<{ created: number; fromModel: number; fromTemplate: number }> {
  const now = deps.now();
  const out = { created: 0, fromModel: 0, fromTemplate: 0 };
  for (const c of deps.store.candidates(now, deps.settings().followups)) {
    const daysAgo = Math.max(1, Math.floor((now - c.sentAt) / DAY));
    const { text, mode } = await deps.generate(c.title, daysAgo);
    if (deps.store.insertDraft(c.queueId, c.contact, text, mode, now) === null) continue;
    out.created += 1;
    if (mode === 'model') out.fromModel += 1;
    else out.fromTemplate += 1;
  }
  return out;
}

// --- отправка ---

export interface RunFollowupsDeps {
  store: FollowupStore;
  queue: Pick<Queue, 'countSentSince'>;
  settings: () => Settings;
  /** throttle.tg из config.json; нет записи — отказ (как у Sender: без лимита не отправляем). */
  throttle: { maxPerDay?: number; minDelayMs: number; maxDelayMs: number } | undefined;
  sender: () => Promise<TgSender | { error: string }>;
  history: () => Promise<TgHistory | { error: string }>;
  dialogs: DialogsPort | null;
  stopRequested: () => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  log: (line: string) => void;
}

export type FollowupHalt =
  | 'disabled' | 'no_throttle' | 'no_session' | 'daily_limit' | 'account_limited' | 'auth_required' | 'stopped';

export interface FollowupRunReport {
  sent: number;
  cancelled: number;
  failed: number;
  /** Оставлено на следующий раз: не удалось проверить историю. */
  skipped: number;
  halted: FollowupHalt | null;
  reason: string | null;
}

const FLOOD_MAX_WAIT_S = 60;

export async function runFollowups(ids: number[] | 'all', deps: RunFollowupsDeps): Promise<FollowupRunReport> {
  const report: FollowupRunReport = { sent: 0, cancelled: 0, failed: 0, skipped: 0, halted: null, reason: null };
  const halt = (h: FollowupHalt, reason: string): FollowupRunReport => ({ ...report, halted: h, reason });
  const settings = deps.settings();
  if (!settings.followups.enabled) {
    return halt('disabled', 'Дожимы выключены: включи их в настройках («Дожимы»), тогда отправка станет возможной.');
  }
  if (deps.throttle === undefined) {
    return halt('no_throttle', 'В config.json нет throttle.tg: без лимита дожимы не отправляются.');
  }
  const sender = await deps.sender();
  if ('error' in sender) return halt('no_session', sender.error);
  const history = await deps.history();
  if ('error' in history) return halt('no_session', history.error);

  const drafts = ids === 'all'
    ? deps.store.drafts()
    : ids.map((id) => deps.store.byId(id)).filter((r): r is FollowupRow => r !== null && r.status === 'draft');

  for (const [i, d] of drafts.entries()) {
    if (deps.stopRequested()) return halt('stopped', 'Остановлено кнопкой «Стоп»: оставшиеся дожимы не тронуты.');
    const now = deps.now();
    // Лимит общий с обычными сообщениями Telegram: аккаунт оценивается по всему исходящему.
    const sentToday = deps.queue.countSentSince('tg', now - DAY) + deps.store.sentSince(now - DAY);
    // maxPerDay нет в записи — лимит снят владельцем сознательно (см. ThrottleRule).
    if (deps.throttle.maxPerDay !== undefined && sentToday >= deps.throttle.maxPerDay) {
      return halt('daily_limit', `Дневной лимит Telegram (${deps.throttle.maxPerDay}) исчерпан: остальные дожимы останутся черновиками.`);
    }
    // Условия могли измениться со времени подготовки: ответ, новая отправка, встреча.
    const still = deps.store.candidates(now, settings.followups, { forContact: d.contact, ignoreFollowup: true });
    if (still.length === 0) {
      deps.store.cancel(d.id, 'условия изменились: рекрутёр ответил, записан или ему уже готовится новое сообщение');
      report.cancelled += 1;
      continue;
    }
    const sentAt = still[0]!.sentAt;
    let seen: Awaited<ReturnType<TgHistory['incomingSince']>>;
    try {
      seen = await history.incomingSince(d.contact, sentAt);
    } catch (e) {
      const f = classifyTgError(e);
      if (f.kind === 'auth') return halt('auth_required', describeTgFailure(f));
      // Не смогли проверить — не отправляем (fail closed), черновик остаётся на следующий раз.
      deps.log(`дожим #${d.id} @${d.contact}: история не прочиталась (${describeTgFailure(f)}) — пропускаю`);
      report.skipped += 1;
      continue;
    }
    if (seen.count > 0) {
      deps.store.cancel(d.id, 'рекрутёр уже ответил');
      if (seen.peerId !== null) {
        deps.dialogs?.incoming({ channel: 'business', peerKey: String(seen.peerId), username: d.contact }, seen.firstAt ?? now, d.queueId);
      }
      report.cancelled += 1;
      continue;
    }

    const outcome = await sendOne(sender, d.contact, d.text, deps);
    if (outcome.ok) {
      const at = deps.now();
      deps.store.markSent(d.id, at);
      // Без id собеседника событие не привязать к будущему диалогу (в личке он называется по id) — не пишем.
      if (seen.peerId !== null) deps.dialogs?.outgoing({ channel: 'business', peerKey: String(seen.peerId), username: d.contact }, at);
      report.sent += 1;
      deps.log(`дожим #${d.id} @${d.contact}: отправлен`);
      if (i < drafts.length - 1) {
        const { minDelayMs, maxDelayMs } = deps.throttle;
        await deps.sleep(minDelayMs + Math.floor(deps.random() * (maxDelayMs - minDelayMs + 1)));
      }
      continue;
    }
    const f = outcome.failure;
    if (f.kind === 'peer_flood' || f.kind === 'flood_wait') {
      return halt('account_limited', `${describeTgFailure(f)}. Прогон остановлен, черновик #${d.id} остался.`);
    }
    if (f.kind === 'auth') return halt('auth_required', describeTgFailure(f));
    deps.store.markFailed(d.id, outcome.reason ?? describeTgFailure(f));
    report.failed += 1;
    deps.log(`дожим #${d.id} @${d.contact}: не ушёл — ${outcome.reason ?? describeTgFailure(f)}`);
  }
  return report;
}

type SendOutcome = { ok: true } | { ok: false; failure: TgFailure; reason?: string };

/** Контакт должен быть человеком; один повтор после короткого FloodWait, как у TelegramAdapter. */
async function sendOne(sender: TgSender, contact: string, text: string, deps: RunFollowupsDeps): Promise<SendOutcome> {
  const attempt = async <T>(f: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; failure: TgFailure }> => {
    for (let i = 0; ; i += 1) {
      try {
        return { ok: true, value: await f() };
      } catch (e) {
        const failure = classifyTgError(e);
        if (failure.kind === 'flood_wait' && failure.seconds <= FLOOD_MAX_WAIT_S && i === 0) {
          await deps.sleep(failure.seconds * 1000);
          continue;
        }
        return { ok: false, failure };
      }
    }
  };
  const peer = await attempt(() => sender.resolvePeer(contact));
  if (!peer.ok) return peer;
  if (peer.value.kind !== 'user') {
    return { ok: false, failure: { kind: 'other', message: 'не человек' }, reason: `@${contact} — не человек, а ${peer.value.kind}` };
  }
  const sent = await attempt(() => sender.sendText(contact, text));
  return sent.ok ? { ok: true } : sent;
}
