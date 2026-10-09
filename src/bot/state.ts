import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureBotSchema, ensureDialogSchema } from '../core/schema.js';
import type { TgBotMessage } from './types.js';

/**
 * Состояние бота в той же queue.db, что и очередь: одна база, один бэкап.
 * Своё соединение, а не методы в Queue, — у бота свой жизненный цикл (процесс
 * висит сутками) и своя ответственность; мешать их с очередью значило бы
 * растить Queue до неподъёмного размера. WAL позволяет боту и панели писать
 * параллельно.
 */

/**
 * Ключи чатов (спека 2026-10-09, решение 1). Одни и те же таблицы обслуживают
 * чат с ботом (ключ = его chat_id > 0), личку секретаря (−id собеседника) и
 * чаты откликов hh.ru (−(2^52 + id топика)); 0 — общий счётчик бота. Диапазоны
 * не пересекаются по построению, поэтому методы и счётчики работают как были.
 */
export const HH_KEY_BASE = 2 ** 52;

export function businessKey(peer: number): number {
  if (!Number.isInteger(peer) || peer <= 0 || peer >= HH_KEY_BASE) {
    throw new Error(`businessKey: id собеседника вне диапазона: ${peer}`);
  }
  return -peer;
}

export function hhKey(topicId: number): number {
  if (!Number.isInteger(topicId) || topicId <= 0 || topicId >= HH_KEY_BASE - 1) {
    throw new Error(`hhKey: id топика вне диапазона: ${topicId}`);
  }
  return -(HH_KEY_BASE + topicId);
}

export function channelOfKey(key: number): 'total' | 'bot' | 'business' | 'hh' {
  if (key === 0) return 'total';
  if (key > 0) return 'bot';
  return key > -HH_KEY_BASE ? 'business' : 'hh';
}

/** id собеседника в личке секретаря по ключу чата. */
export function peerOfKey(key: number): number {
  if (channelOfKey(key) !== 'business') throw new Error(`peerOfKey: ${key} — не ключ лички`);
  return -key;
}

/** Ключ чата для сообщения: из лички секретаря (есть business_connection_id) — отрицательный. */
export function chatKeyOf(m: TgBotMessage): number {
  return m.business_connection_id !== undefined ? businessKey(m.chat.id) : m.chat.id;
}

export type ChatMode = 'idle' | 'await_vacancy' | 'await_meet' | 'await_meet_confirm' | 'await_time';

export interface ChatState {
  chatId: number;
  username: string | null;
  mode: ChatMode;
  modeUntil: number | null;
  lastMsgAt: number;
  strikes: number;
  mutedUntil: number | null;
  lastQueueId: number | null;
}

export interface Meeting {
  id: number;
  chatId: number;
  username: string | null;
  queueId: number | null;
  meetAt: number;
  raw: string;
  createdAt: number;
  /** Секретарь (спека 2026-10-09, 5.3). null/нет — чат с ботом, так записаны и старые строки. */
  channel?: 'business' | 'hh' | null;
  peerChatId?: number | null;
  sourceMsgId?: number | null;
  /** Перенос: какую запись заменяет эта. */
  replacesId?: number | null;
  /** Запись заменена переносом — владельцу о ней уже не пингуем. */
  supersededAt?: number | null;
  remindedAt?: number | null;
  notifiedAt?: number | null;
}

/** Подключение секретаря (business_connection), как его хранит бот. */
export interface StoredConnection {
  id: string;
  userId: number;
  username: string | null;
  userChatId: number;
  canReply: boolean;
  isEnabled: boolean;
  updatedAt: number;
}

export type SeenOutcome = 'answered' | 'silent' | 'meeting';

interface ChatRow {
  chat_id: number; username: string | null; mode: string; mode_until: number | null;
  last_msg_at: number; strikes: number; muted_until: number | null; last_queue_id: number | null;
}

interface MeetingRow {
  id: number; chat_id: number; username: string | null; queue_id: number | null;
  meet_at: number; raw: string; created_at: number;
  channel: string | null; peer_chat_id: number | null; source_msg_id: number | null;
  replaces_id: number | null; superseded_at: number | null; reminded_at: number | null;
  notified_at: number | null;
}

interface ConnectionRow {
  id: string; user_id: number; username: string | null; user_chat_id: number;
  can_reply: number; is_enabled: number; updated_at: number;
}

/** Сколько бот помнит id обработанных сообщений: дольше Telegram не держит очередь апдейтов. */
const SEEN_KEEP_MS = 14 * 86_400_000;

export class BotStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    ensureBotSchema(this.db);
    ensureDialogSchema(this.db);
    this.pruneSeen(Date.now() - SEEN_KEEP_MS);
  }

  private toChat(r: ChatRow): ChatState {
    return {
      chatId: r.chat_id, username: r.username, mode: r.mode as ChatMode, modeUntil: r.mode_until,
      lastMsgAt: r.last_msg_at, strikes: r.strikes, mutedUntil: r.muted_until, lastQueueId: r.last_queue_id,
    };
  }

  chat(chatId: number): ChatState | null {
    const row = this.db.prepare('SELECT * FROM bot_chats WHERE chat_id = ?')
      .get(chatId) as unknown as ChatRow | undefined;
    return row === undefined ? null : this.toChat(row);
  }

  /** Режим с учётом срока: протух — считаем idle, не переписывая строку лишний раз. */
  modeAt(chatId: number, now: number): ChatMode {
    const c = this.chat(chatId);
    if (c === null || c.mode === 'idle') return 'idle';
    if (c.modeUntil !== null && c.modeUntil <= now) return 'idle';
    return c.mode;
  }

  touch(chatId: number, username: string | null, now: number): ChatState {
    this.db.prepare(`
      INSERT INTO bot_chats (chat_id, username, mode, mode_until, last_msg_at)
      VALUES (?, ?, 'idle', NULL, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        username = COALESCE(excluded.username, bot_chats.username),
        last_msg_at = excluded.last_msg_at
    `).run(chatId, username, now);
    const c = this.chat(chatId);
    if (c === null) throw new Error('BotStore.touch: строка чата не создалась');
    return c;
  }

  setMode(chatId: number, mode: ChatMode, until: number | null): void {
    this.db.prepare('UPDATE bot_chats SET mode = ?, mode_until = ? WHERE chat_id = ?').run(mode, until, chatId);
  }

  setLastQueueId(chatId: number, queueId: number): void {
    this.db.prepare('UPDATE bot_chats SET last_queue_id = ? WHERE chat_id = ?').run(queueId, chatId);
  }

  addStrike(chatId: number): number {
    this.db.prepare('UPDATE bot_chats SET strikes = strikes + 1 WHERE chat_id = ?').run(chatId);
    return this.chat(chatId)?.strikes ?? 0;
  }

  resetStrikes(chatId: number): void {
    this.db.prepare('UPDATE bot_chats SET strikes = 0 WHERE chat_id = ?').run(chatId);
  }

  /** Молчание для чата. Страйки обнуляются: отсчёт начнётся заново после снятия. */
  mute(chatId: number, until: number): void {
    this.db.prepare('UPDATE bot_chats SET muted_until = ?, strikes = 0 WHERE chat_id = ?').run(until, chatId);
  }

  modelCalls(day: string, chatId: number): number {
    const row = this.db.prepare('SELECT calls FROM bot_usage WHERE day = ? AND chat_id = ?')
      .get(day, chatId) as unknown as { calls: number } | undefined;
    return row?.calls ?? 0;
  }

  countModelCall(day: string, chatId: number): void {
    this.db.prepare(`
      INSERT INTO bot_usage (day, chat_id, calls) VALUES (?, ?, 1)
      ON CONFLICT(day, chat_id) DO UPDATE SET calls = calls + 1
    `).run(day, chatId);
  }

  meetingsToday(chatId: number, day: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM bot_meetings
      WHERE chat_id = ? AND date(created_at / 1000, 'unixepoch', 'localtime') = ?
    `).get(chatId, day) as unknown as { n: number } | undefined;
    return row?.n ?? 0;
  }

  saveMeeting(m: Omit<Meeting, 'id'>): number {
    this.db.prepare(`
      INSERT INTO bot_meetings (chat_id, username, queue_id, meet_at, raw, created_at,
                                channel, peer_chat_id, source_msg_id, replaces_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      m.chatId, m.username, m.queueId, m.meetAt, m.raw, m.createdAt,
      m.channel ?? null, m.peerChatId ?? null, m.sourceMsgId ?? null, m.replacesId ?? null,
    );
    const row = this.db.prepare('SELECT last_insert_rowid() AS id').get() as unknown as { id: number };
    return row.id;
  }

  private toMeeting(r: MeetingRow): Meeting {
    return {
      id: r.id, chatId: r.chat_id, username: r.username, queueId: r.queue_id,
      meetAt: r.meet_at, raw: r.raw, createdAt: r.created_at,
      channel: r.channel === 'business' || r.channel === 'hh' ? r.channel : null,
      peerChatId: r.peer_chat_id, sourceMsgId: r.source_msg_id, replacesId: r.replaces_id,
      supersededAt: r.superseded_at, remindedAt: r.reminded_at, notifiedAt: r.notified_at,
    };
  }

  /**
   * Встречи, о которых владелец ещё не знает. Пинг повторяется на каждом круге
   * цикла, пока не пройдёт: договорённость о собеседовании — самое ценное, что
   * идёт через бота, терять её из-за упавшего VPN нельзя. Перенесённая запись
   * (superseded) уже не нужна: о новом времени скажет пинг заменившей её.
   */
  pendingMeetings(): Meeting[] {
    const rows = this.db.prepare(
      'SELECT * FROM bot_meetings WHERE notified_at IS NULL AND superseded_at IS NULL ORDER BY id',
    ).all() as unknown as MeetingRow[];
    return rows.map((r) => this.toMeeting(r));
  }

  markMeetingNotified(id: number, at: number): void {
    this.db.prepare('UPDATE bot_meetings SET notified_at = ? WHERE id = ?').run(at, id);
  }

  meetingById(id: number): Meeting | null {
    const row = this.db.prepare('SELECT * FROM bot_meetings WHERE id = ?')
      .get(id) as unknown as MeetingRow | undefined;
    return row === undefined ? null : this.toMeeting(row);
  }

  /** Самая свежая по записи, ещё не наступившая и не перенесённая встреча чата. */
  lastUpcomingMeeting(chatKey: number, now: number): Meeting | null {
    const row = this.db.prepare(`
      SELECT * FROM bot_meetings
      WHERE chat_id = ? AND superseded_at IS NULL AND meet_at > ?
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(chatKey, now) as unknown as MeetingRow | undefined;
    return row === undefined ? null : this.toMeeting(row);
  }

  /** Встречи в окне [from, to] без перенесённых — занятость для календаря. */
  upcomingMeetings(from: number, to: number): Meeting[] {
    const rows = this.db.prepare(`
      SELECT * FROM bot_meetings WHERE superseded_at IS NULL AND meet_at >= ? AND meet_at <= ? ORDER BY meet_at
    `).all(from, to) as unknown as MeetingRow[];
    return rows.map((r) => this.toMeeting(r));
  }

  supersedeMeeting(id: number, at: number): void {
    this.db.prepare('UPDATE bot_meetings SET superseded_at = ? WHERE id = ?').run(at, id);
  }

  /**
   * Пора напомнить: владелец о встрече уже знает, напоминания ещё не было,
   * встреча не перенесена и начнётся не позже чем через `beforeMin` минут.
   */
  dueReminders(now: number, beforeMin: number): Meeting[] {
    const rows = this.db.prepare(`
      SELECT * FROM bot_meetings
      WHERE notified_at IS NOT NULL AND reminded_at IS NULL AND superseded_at IS NULL
        AND meet_at > ? AND meet_at <= ?
      ORDER BY meet_at
    `).all(now, now + beforeMin * 60_000) as unknown as MeetingRow[];
    return rows.map((r) => this.toMeeting(r));
  }

  markReminded(id: number, at: number): void {
    this.db.prepare('UPDATE bot_meetings SET reminded_at = ? WHERE id = ?').run(at, id);
  }

  // --- секретарь: соединения, дедупликация, режимы ожидания ---

  upsertConnection(c: StoredConnection): void {
    this.db.prepare(`
      INSERT INTO bot_connections (id, user_id, username, user_chat_id, can_reply, is_enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id, username = excluded.username, user_chat_id = excluded.user_chat_id,
        can_reply = excluded.can_reply, is_enabled = excluded.is_enabled, updated_at = excluded.updated_at
    `).run(c.id, c.userId, c.username, c.userChatId, c.canReply ? 1 : 0, c.isEnabled ? 1 : 0, c.updatedAt);
  }

  connection(id: string): StoredConnection | null {
    const r = this.db.prepare('SELECT * FROM bot_connections WHERE id = ?')
      .get(id) as unknown as ConnectionRow | undefined;
    return r === undefined ? null : {
      id: r.id, userId: r.user_id, username: r.username, userChatId: r.user_chat_id,
      canReply: r.can_reply === 1, isEnabled: r.is_enabled === 1, updatedAt: r.updated_at,
    };
  }

  /** Есть ли соединение с таким username (без @, в любом регистре). */
  hasConnectionOf(username: string): boolean {
    return this.db.prepare('SELECT 1 AS x FROM bot_connections WHERE lower(username) = ? LIMIT 1')
      .get(username.toLowerCase().replace(/^@/, '')) !== undefined;
  }

  /** Сообщение уже обработано (повторная доставка апдейта) и чем кончилось. */
  seen(chatKey: number, messageId: number): { outcome: SeenOutcome; meetingId: number | null } | null {
    const r = this.db.prepare('SELECT outcome, meeting_id FROM bot_seen WHERE chat_key = ? AND message_id = ?')
      .get(chatKey, messageId) as unknown as { outcome: string; meeting_id: number | null } | undefined;
    return r === undefined ? null : { outcome: r.outcome as SeenOutcome, meetingId: r.meeting_id };
  }

  /**
   * Отметка ставится ДО отправки ответа (как lastMessageId у интервью): лучше не
   * ответить, чем ответить дважды.
   */
  markSeen(chatKey: number, ids: number[], outcome: SeenOutcome, meetingId: number | null, at: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO bot_seen (chat_key, message_id, outcome, meeting_id, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chat_key, message_id) DO UPDATE SET outcome = excluded.outcome,
        meeting_id = excluded.meeting_id, at = excluded.at
    `);
    for (const id of ids) stmt.run(chatKey, id, outcome, meetingId, at);
  }

  pruneSeen(beforeMs: number): number {
    const r = this.db.prepare('DELETE FROM bot_seen WHERE at < ?').run(beforeMs);
    return Number(r.changes);
  }

  /** Время, которое рекрутёр ещё должен подтвердить словом «да» (режим await_meet_confirm). */
  setPendingMeet(chatKey: number, at: number | null): void {
    this.db.prepare('UPDATE bot_chats SET pending_meet_at = ? WHERE chat_id = ?').run(at, chatKey);
  }

  /** Предложенные слоты (мс), из которых рекрутёр выбирает (режим await_time). Тексты не хранятся. */
  setOfferedSlots(chatKey: number, slots: number[] | null): void {
    this.db.prepare('UPDATE bot_chats SET offered_slots = ? WHERE chat_id = ?')
      .run(slots === null || slots.length === 0 ? null : JSON.stringify(slots), chatKey);
  }

  chatExtras(chatKey: number): { pendingMeetAt: number | null; offeredSlots: number[] } {
    const r = this.db.prepare('SELECT pending_meet_at, offered_slots FROM bot_chats WHERE chat_id = ?')
      .get(chatKey) as unknown as { pending_meet_at: number | null; offered_slots: string | null } | undefined;
    let offered: number[] = [];
    if (r?.offered_slots) {
      try {
        const parsed: unknown = JSON.parse(r.offered_slots);
        if (Array.isArray(parsed)) offered = parsed.filter((x): x is number => typeof x === 'number');
      } catch {
        // битый JSON — как «слотов нет»: выбрать из них рекрутёр не сможет
      }
    }
    return { pendingMeetAt: r?.pending_meet_at ?? null, offeredSlots: offered };
  }

  kvGet(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM bot_kv WHERE key = ?')
      .get(key) as unknown as { value: string } | undefined;
    return row?.value ?? null;
  }

  kvSet(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO bot_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
