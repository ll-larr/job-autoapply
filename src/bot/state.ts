import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Состояние бота в той же queue.db, что и очередь: одна база, один бэкап.
 * Своё соединение, а не методы в Queue, — у бота свой жизненный цикл (процесс
 * висит сутками) и своя ответственность; мешать их с очередью значило бы
 * растить Queue до неподъёмного размера. WAL позволяет боту и панели писать
 * параллельно.
 */

export type ChatMode = 'idle' | 'await_vacancy' | 'await_meet';

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
}

interface ChatRow {
  chat_id: number; username: string | null; mode: string; mode_until: number | null;
  last_msg_at: number; strikes: number; muted_until: number | null; last_queue_id: number | null;
}

interface MeetingRow {
  id: number; chat_id: number; username: string | null; queue_id: number | null;
  meet_at: number; raw: string; created_at: number;
}

export class BotStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_chats (
        chat_id       INTEGER PRIMARY KEY,
        username      TEXT,
        mode          TEXT NOT NULL,
        mode_until    INTEGER,
        last_msg_at   INTEGER NOT NULL,
        strikes       INTEGER NOT NULL DEFAULT 0,
        muted_until   INTEGER,
        last_queue_id INTEGER
      );
      CREATE TABLE IF NOT EXISTS bot_usage (
        day     TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        calls   INTEGER NOT NULL,
        PRIMARY KEY (day, chat_id)
      );
      CREATE TABLE IF NOT EXISTS bot_kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bot_meetings (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id     INTEGER NOT NULL,
        username    TEXT,
        queue_id    INTEGER,
        meet_at     INTEGER NOT NULL,
        raw         TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        notified_at INTEGER
      );
    `);
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
      INSERT INTO bot_meetings (chat_id, username, queue_id, meet_at, raw, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(m.chatId, m.username, m.queueId, m.meetAt, m.raw, m.createdAt);
    const row = this.db.prepare('SELECT last_insert_rowid() AS id').get() as unknown as { id: number };
    return row.id;
  }

  /**
   * Встречи, о которых владелец ещё не знает. Пинг повторяется на каждом круге
   * цикла, пока не пройдёт: договорённость о собеседовании — самое ценное, что
   * идёт через бота, терять её из-за упавшего VPN нельзя.
   */
  pendingMeetings(): Meeting[] {
    const rows = this.db.prepare('SELECT * FROM bot_meetings WHERE notified_at IS NULL ORDER BY id')
      .all() as unknown as MeetingRow[];
    return rows.map((r) => ({
      id: r.id, chatId: r.chat_id, username: r.username, queueId: r.queue_id,
      meetAt: r.meet_at, raw: r.raw, createdAt: r.created_at,
    }));
  }

  markMeetingNotified(id: number, at: number): void {
    this.db.prepare('UPDATE bot_meetings SET notified_at = ? WHERE id = ?').run(at, id);
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
