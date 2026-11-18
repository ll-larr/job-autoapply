import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureBotSchema, ensureDialogSchema } from './schema.js';
import { businessKey, hhKey } from '../bot/state.js';
import type { DialogRef, DialogsPort, SilenceReason } from '../bot/secretary.js';
import type { HhTopic } from '../hh/topics.js';

/**
 * Диалоги и воронка для вкладки «Диалоги» (спека 2026-10-09, 5.2 и 5.6).
 * Только метаданные: кто, когда, сколько сообщений, чем кончилось. Ни одного
 * текста рекрутёра или работодателя здесь нет и быть не должно — панель читает
 * эту базу, а бот ни одного текста не хранит.
 */

export type DialogEventKind = 'in' | 'out' | 'bot' | 'invite' | 'reject';

export type DialogStatus = 'meeting' | 'invite' | 'reject' | 'replied' | 'waiting';

export interface DialogView {
  id: number;
  channel: 'business' | 'hh';
  /** «@username» либо «чат отклика» — как показать человека. */
  who: string;
  username: string | null;
  queueId: number | null;
  vacancy: { title: string; url: string } | null;
  /** Когда мы написали первыми (строка очереди), мс; null — не знаем. */
  sentAt: number | null;
  /** Через сколько после нашего сообщения ответили, мс. */
  repliedAfterMs: number | null;
  inCount: number;
  outCount: number;
  botCount: number;
  status: DialogStatus;
  /** Причина последнего молчания бота или null. */
  silenced: string | null;
  meetingAt: number | null;
  updatedAt: number;
}

export interface FunnelRow {
  /** Понедельник недели «ГГГГ-ММ-ДД» или «total» — итог по площадке за период. */
  week: string;
  source: string;
  sent: number;
  /** null — площадка не даёт ответа боту (hr.ge, careerist). */
  replied: number | null;
  meetings: number | null;
  /** Медиана часов до первого ответа, один знак; null — ответов нет. */
  medianHours: number | null;
}

const DAY = 86_400_000;
const FUNNEL_WEEKS = 8;
const SOURCE_ORDER = ['tg', 'hh', 'hrge', 'careerist'];

interface DialogRow {
  id: number; channel: string; peer_key: string; username: string | null; queue_id: number | null;
  in_count: number; out_count: number; bot_count: number; meeting_id: number | null;
  silenced: string | null; created_at: number; updated_at: number;
}

interface SentRow { id: number; source: string; contact: string | null; sent_at: number; vacancy_json: string }

/** Понедельник 00:00 по местному времени машины — начало недели, на которую пришлось время. */
function weekOf(ms: number): string {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return Math.round(m * 10) / 10;
}

export class Dialogs implements DialogsPort {
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

  // --- запись событий (бот, ящик hh) ---

  /** Строка диалога; создаётся при первом событии. */
  private upsert(ref: DialogRef, at: number): number {
    this.db.prepare(`
      INSERT INTO dialogs (channel, peer_key, username, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel, peer_key) DO UPDATE SET
        username = COALESCE(excluded.username, dialogs.username),
        updated_at = MAX(dialogs.updated_at, excluded.updated_at)
    `).run(ref.channel, ref.peerKey, ref.username, at, at);
    const row = this.db.prepare('SELECT id FROM dialogs WHERE channel = ? AND peer_key = ?')
      .get(ref.channel, ref.peerKey) as unknown as { id: number };
    return row.id;
  }

  private event(dialogId: number, kind: DialogEventKind, at: number): void {
    this.db.prepare('INSERT INTO dialog_events (dialog_id, kind, at) VALUES (?, ?, ?)').run(dialogId, kind, at);
  }

  incoming(ref: DialogRef, at: number, queueId: number | null): void {
    const id = this.upsert(ref, at);
    this.db.prepare(`
      UPDATE dialogs SET in_count = in_count + 1, silenced = NULL, queue_id = COALESCE(?, queue_id) WHERE id = ?
    `).run(queueId, id);
    this.event(id, 'in', at);
  }

  outgoing(ref: DialogRef, at: number): void {
    const id = this.upsert(ref, at);
    this.db.prepare('UPDATE dialogs SET out_count = out_count + 1 WHERE id = ?').run(id);
    this.event(id, 'out', at);
  }

  botReply(ref: DialogRef, at: number): void {
    const id = this.upsert(ref, at);
    this.db.prepare('UPDATE dialogs SET bot_count = bot_count + 1 WHERE id = ?').run(id);
    this.event(id, 'bot', at);
  }

  meeting(ref: DialogRef, meetingId: number, at: number): void {
    const id = this.upsert(ref, at);
    this.db.prepare('UPDATE dialogs SET meeting_id = ? WHERE id = ?').run(meetingId, id);
  }

  silenced(ref: DialogRef, reason: SilenceReason | null, at: number): void {
    const id = this.upsert(ref, at);
    this.db.prepare('UPDATE dialogs SET silenced = ? WHERE id = ?').run(reason, id);
  }

  /**
   * Событие чата отклика hh.ru: новое сообщение работодателя, приглашение или
   * отказ. Тексты ящик в режиме чтения не получает вовсе — только факт и время.
   */
  hhEvent(topicId: number, kind: 'in' | 'invite' | 'reject', at: number, queueId: number | null): void {
    const id = this.upsert({ channel: 'hh', peerKey: String(topicId), username: null }, at);
    this.db.prepare(
      kind === 'in'
        ? 'UPDATE dialogs SET in_count = in_count + 1, queue_id = COALESCE(?, queue_id) WHERE id = ?'
        : 'UPDATE dialogs SET queue_id = COALESCE(?, queue_id) WHERE id = ?',
    ).run(queueId, id);
    this.event(id, kind, at);
  }

  // --- чаты откликов hh.ru (ящик, спека 6.10) ---

  hhTopic(topicId: number): { baselineAt: number | null; lastState: string; messagesCount: number; updatedAt: number } | null {
    const r = this.db.prepare('SELECT baseline_at, last_state, messages_count, updated_at FROM hh_topics WHERE topic_id = ?')
      .get(topicId) as unknown as
      { baseline_at: number | null; last_state: string; messages_count: number; updated_at: number } | undefined;
    return r === undefined
      ? null
      : { baselineAt: r.baseline_at, lastState: r.last_state, messagesCount: r.messages_count, updatedAt: r.updated_at };
  }

  /**
   * Наблюдение за откликом при проходе чтения. Что считается событием:
   *  - «работодатель написал» — новые сообщения появились (флаг или рост счётчика),
   *    причём рост, который объясняется нашими же ответами между наблюдениями,
   *    в расчёт не идёт;
   *  - «приглашение» и «отказ» — первое появление состояния INTERVIEW / DISCARD.
   * При первом наблюдении событиями становятся уже имеющееся состояние и флаг
   * новых сообщений. Время события — lastModified, если оно новее прошлого
   * наблюдения, иначе «сейчас». Тексты сообщений сюда не попадают.
   */
  observeHhTopic(t: HhTopic, queueId: number | null, now: number): Array<'in' | 'invite' | 'reject'> {
    const prev = this.db.prepare('SELECT * FROM hh_topics WHERE topic_id = ?').get(t.topicId) as unknown as
      { last_state: string; messages_count: number; has_new: number; updated_at: number; queue_id: number | null } | undefined;
    const kinds: Array<'in' | 'invite' | 'reject'> = [];
    const at = t.lastModified !== null && (prev === undefined || t.lastModified > prev.updated_at) ? t.lastModified : now;
    if (prev === undefined) {
      this.db.prepare(`
        INSERT INTO hh_topics (topic_id, chat_id, vacancy_id, queue_id, last_state, inbox_state, messages_count, has_new,
                               last_modified, first_seen_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(t.topicId, t.chatId, t.vacancyId, queueId, t.lastState, t.inboxState, t.messagesCount, t.hasNew ? 1 : 0,
        t.lastModified, now, now);
      if (t.lastState === 'INTERVIEW') kinds.push('invite');
      else if (t.lastState === 'DISCARD') kinds.push('reject');
      if (t.hasNew) kinds.push('in');
    } else {
      const own = this.db.prepare(`
        SELECT COUNT(*) AS n FROM dialog_events e JOIN dialogs d ON d.id = e.dialog_id
        WHERE d.channel = 'hh' AND d.peer_key = ? AND e.kind = 'bot' AND e.at > ?
      `).get(String(t.topicId), prev.updated_at) as unknown as { n: number };
      const grew = t.messagesCount - prev.messages_count - own.n;
      if ((t.hasNew && prev.has_new === 0) || grew > 0) kinds.push('in');
      if (t.lastState === 'INTERVIEW' && prev.last_state !== 'INTERVIEW') kinds.push('invite');
      if (t.lastState === 'DISCARD' && prev.last_state !== 'DISCARD') kinds.push('reject');
      this.db.prepare(`
        UPDATE hh_topics SET chat_id = ?, vacancy_id = ?, queue_id = COALESCE(?, queue_id), last_state = ?, inbox_state = ?,
          messages_count = ?, has_new = ?, last_modified = ?, updated_at = ? WHERE topic_id = ?
      `).run(t.chatId, t.vacancyId, queueId, t.lastState, t.inboxState, t.messagesCount, t.hasNew ? 1 : 0,
        t.lastModified, now, t.topicId);
    }
    for (const k of kinds) this.hhEvent(t.topicId, k, at, queueId);
    return kinds;
  }

  /** Чат прочитан впервые: всё, что в нём уже есть, — прошлое, отвечать на него нельзя (R4). */
  setHhBaseline(topicId: number, at: number): void {
    this.db.prepare('UPDATE hh_topics SET baseline_at = ? WHERE topic_id = ?').run(at, topicId);
  }

  /** Сколько ответов бота ушло в чаты hh.ru с момента `since` (в один чат, если задан topicId). */
  hhBotReplies(since: number, topicId?: number): number {
    const r = (topicId === undefined
      ? this.db.prepare(`
          SELECT COUNT(*) AS n FROM dialog_events e JOIN dialogs d ON d.id = e.dialog_id
          WHERE d.channel = 'hh' AND e.kind = 'bot' AND e.at > ?
        `).get(since)
      : this.db.prepare(`
          SELECT COUNT(*) AS n FROM dialog_events e JOIN dialogs d ON d.id = e.dialog_id
          WHERE d.channel = 'hh' AND d.peer_key = ? AND e.kind = 'bot' AND e.at > ?
        `).get(String(topicId), since)) as unknown as { n: number };
    return r.n;
  }

  /** Ключи уже виденных сообщений чата: id из разметки или sha1 — хэш, не текст. */
  hhSeen(topicId: number): Set<string> {
    const rows = this.db.prepare('SELECT msg_key FROM hh_seen WHERE topic_id = ?')
      .all(topicId) as unknown as Array<{ msg_key: string }>;
    return new Set(rows.map((r) => r.msg_key));
  }

  markHhSeen(topicId: number, keys: string[], at: number): void {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO hh_seen (topic_id, msg_key, at) VALUES (?, ?, ?)');
    for (const k of keys) stmt.run(topicId, k, at);
  }

  /** Служебные значения ящика (отчёт последнего прохода, время пробы) — в той же bot_kv, что у бота. */
  kvGet(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM bot_kv WHERE key = ?').get(key) as unknown as { value: string } | undefined;
    return r?.value ?? null;
  }

  kvSet(key: string, value: string): void {
    this.db.prepare('INSERT INTO bot_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  // --- чтение для панели ---

  private events(dialogId: number): Array<{ kind: DialogEventKind; at: number }> {
    return this.db.prepare('SELECT kind, at FROM dialog_events WHERE dialog_id = ? ORDER BY at, rowid')
      .all(dialogId) as unknown as Array<{ kind: DialogEventKind; at: number }>;
  }

  private sentRow(queueId: number | null): { sentAt: number | null; vacancy: { title: string; url: string } | null } {
    if (queueId === null) return { sentAt: null, vacancy: null };
    const r = this.db.prepare('SELECT sent_at, vacancy_json FROM applications WHERE id = ?')
      .get(queueId) as unknown as { sent_at: number | null; vacancy_json: string } | undefined;
    if (r === undefined) return { sentAt: null, vacancy: null };
    const v = JSON.parse(r.vacancy_json) as { title?: string; url?: string };
    return { sentAt: r.sent_at, vacancy: { title: v.title ?? '', url: v.url ?? '' } };
  }

  /** Диалоги с активностью за последние `withinDays`, свежие сверху. */
  list(now: number, withinDays = 30, limit = 200): DialogView[] {
    const rows = this.db.prepare('SELECT * FROM dialogs WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?')
      .all(now - withinDays * DAY, limit) as unknown as DialogRow[];
    return rows.map((r) => {
      const events = this.events(r.id);
      const { sentAt, vacancy } = this.sentRow(r.queue_id);
      const replyKinds: DialogEventKind[] = r.channel === 'hh' ? ['in', 'invite', 'reject'] : ['in'];
      const first = events.find((e) => replyKinds.includes(e.kind) && (sentAt === null || e.at >= sentAt));
      const last = [...events].reverse().find((e) => e.kind === 'invite' || e.kind === 'reject');
      const meetingAt = r.meeting_id === null
        ? null
        : (this.db.prepare('SELECT meet_at FROM bot_meetings WHERE id = ? AND superseded_at IS NULL')
          .get(r.meeting_id) as unknown as { meet_at: number } | undefined)?.meet_at ?? null;
      let status: DialogStatus = 'waiting';
      if (meetingAt !== null) status = 'meeting';
      else if (last?.kind === 'reject') status = 'reject';
      else if (last?.kind === 'invite') status = 'invite';
      else if (r.in_count > 0) status = 'replied';
      return {
        id: r.id,
        channel: r.channel === 'hh' ? 'hh' : 'business',
        who: r.channel === 'hh' ? 'чат отклика' : r.username === null ? `id ${r.peer_key}` : `@${r.username}`,
        username: r.username,
        queueId: r.queue_id,
        vacancy,
        sentAt,
        repliedAfterMs: first === undefined || sentAt === null ? null : Math.max(0, first.at - sentAt),
        inCount: r.in_count,
        outCount: r.out_count,
        botCount: r.bot_count,
        status,
        silenced: r.silenced,
        meetingAt,
        updatedAt: r.updated_at,
      };
    });
  }

  /**
   * Воронка «отправлено → ответил → собеседование» за последние 8 недель
   * (спека 5.6). Считается на лету из очереди, диалогов и встреч: хранить тут
   * нечего, а определения можно менять без миграций.
   */
  funnel(now: number): FunnelRow[] {
    const since = now - FUNNEL_WEEKS * 7 * DAY;
    const sent = this.db.prepare(`
      SELECT id, source, contact, sent_at, vacancy_json FROM applications WHERE status = 'sent' AND sent_at >= ?
    `).all(since) as unknown as SentRow[];
    // «Следующая отправка тому же контакту» делит окна ответов: ответ на второе
    // письмо не засчитывается первому.
    const allSent = this.db.prepare(`
      SELECT contact, sent_at FROM applications WHERE status = 'sent' AND contact IS NOT NULL
    `).all() as unknown as Array<{ contact: string; sent_at: number }>;

    interface Acc { sent: number; replied: number; meetings: number; hours: number[]; tracked: boolean }
    const acc = new Map<string, Acc>();
    const slot = (week: string, source: string): Acc => {
      const k = `${week}|${source}`;
      let a = acc.get(k);
      if (a === undefined) { a = { sent: 0, replied: 0, meetings: 0, hours: [], tracked: source === 'tg' || source === 'hh' }; acc.set(k, a); }
      return a;
    };

    for (const r of sent) {
      const week = weekOf(r.sent_at);
      const cells = [slot(week, r.source), slot('total', r.source)];
      for (const c of cells) c.sent += 1;
      if (r.source !== 'tg' && r.source !== 'hh') continue;

      let firstReply: number | null = null;
      let hadMeeting = false;
      if (r.source === 'tg' && r.contact !== null) {
        const next = Math.min(Infinity, ...allSent.filter((s) => s.contact === r.contact && s.sent_at > r.sent_at).map((s) => s.sent_at));
        const d = this.db.prepare("SELECT id, peer_key FROM dialogs WHERE channel = 'business' AND username = ?")
          .get(r.contact) as unknown as { id: number; peer_key: string } | undefined;
        if (d !== undefined) {
          firstReply = this.events(d.id).find((e) => e.kind === 'in' && e.at >= r.sent_at && e.at < next)?.at ?? null;
          const m = this.db.prepare(`
            SELECT 1 AS x FROM bot_meetings
            WHERE superseded_at IS NULL AND (queue_id = ? OR (chat_id = ? AND created_at >= ? AND created_at < ?)) LIMIT 1
          `).get(r.id, businessKey(Number(d.peer_key)), r.sent_at, Number.isFinite(next) ? next : Number.MAX_SAFE_INTEGER);
          hadMeeting = m !== undefined;
        } else {
          const m = this.db.prepare('SELECT 1 AS x FROM bot_meetings WHERE superseded_at IS NULL AND queue_id = ? LIMIT 1').get(r.id);
          hadMeeting = m !== undefined;
        }
      } else if (r.source === 'hh') {
        const d = this.db.prepare("SELECT id, peer_key FROM dialogs WHERE channel = 'hh' AND queue_id = ?")
          .get(r.id) as unknown as { id: number; peer_key: string } | undefined;
        if (d !== undefined) {
          const ev = this.events(d.id);
          firstReply = ev.find((e) => (e.kind === 'in' || e.kind === 'invite' || e.kind === 'reject') && e.at >= r.sent_at)?.at ?? null;
          hadMeeting = ev.some((e) => e.kind === 'invite')
            || this.db.prepare('SELECT 1 AS x FROM bot_meetings WHERE superseded_at IS NULL AND chat_id = ? LIMIT 1')
              .get(hhKey(Number(d.peer_key))) !== undefined;
        }
      }
      for (const c of cells) {
        if (firstReply !== null) {
          c.replied += 1;
          c.hours.push((firstReply - r.sent_at) / 3_600_000);
        }
        if (hadMeeting) c.meetings += 1;
      }
    }

    const rank = (source: string): number => {
      const i = SOURCE_ORDER.indexOf(source);
      return i === -1 ? SOURCE_ORDER.length : i;
    };
    return [...acc.entries()].map(([k, a]): FunnelRow => {
      const [week, source] = k.split('|') as [string, string];
      return {
        week, source, sent: a.sent,
        replied: a.tracked ? a.replied : null,
        meetings: a.tracked ? a.meetings : null,
        medianHours: a.tracked ? median(a.hours) : null,
      };
    }).sort((x, y) => {
      if (x.week !== y.week) {
        if (x.week === 'total') return 1;
        if (y.week === 'total') return -1;
        return x.week < y.week ? 1 : -1;
      }
      return rank(x.source) - rank(y.source);
    });
  }

  /** Диалоги с активностью за 7 дней — число на вкладке. */
  activeCount(now: number): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM dialogs WHERE updated_at >= ?')
      .get(now - 7 * DAY) as unknown as { n: number };
    return r.n;
  }
}
