import type { DatabaseSync } from 'node:sqlite';

/**
 * Схема таблиц бота-секретаря. Раньше DDL жил в конструкторе BotStore, но теперь
 * его вызывают и другие хранилища: панель считает воронку по `bot_meetings` и
 * `dialogs`, даже если бот ни разу не запускался. Бот и панель — два процесса на
 * одной queue.db, поэтому миграции только аддитивные (`CREATE … IF NOT EXISTS`,
 * `ADD COLUMN`) и безопасные, пока второй процесс работает.
 */

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

/**
 * `def` — «имя ТИП …». ALTER в try: второй процесс мог добавить колонку между
 * проверкой и запросом. Результат проверяем по `table_info`, а не по ошибке:
 * «database is locked» не должно проглатываться молча (колонки нет — запись
 * потом упала бы на каждом сообщении).
 */
export function addColumn(db: DatabaseSync, table: string, def: string): void {
  const column = def.trim().split(/\s+/)[0]!;
  if (hasColumn(db, table, column)) return;
  let cause = '';
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
  } catch (e) {
    cause = e instanceof Error ? e.message : String(e);
  }
  if (!hasColumn(db, table, column)) {
    throw new Error(`schema: колонка ${table}.${column} не создалась${cause === '' ? '' : ` (${cause})`}`);
  }
}

export function ensureBotSchema(db: DatabaseSync): void {
  // Бот и панель пишут одновременно: вместо мгновенного «database is locked»
  // ждём до 5 секунд.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
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
    CREATE TABLE IF NOT EXISTS bot_connections (
      id           TEXT PRIMARY KEY,
      user_id      INTEGER NOT NULL,
      username     TEXT,
      user_chat_id INTEGER NOT NULL,
      can_reply    INTEGER NOT NULL,
      is_enabled   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bot_seen (
      chat_key   INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      outcome    TEXT NOT NULL,
      meeting_id INTEGER,
      at         INTEGER NOT NULL,
      PRIMARY KEY (chat_key, message_id)
    );
  `);
  addColumn(db, 'bot_chats', 'pending_meet_at INTEGER');
  addColumn(db, 'bot_chats', 'offered_slots TEXT');
  addColumn(db, 'bot_meetings', 'channel TEXT');
  addColumn(db, 'bot_meetings', 'peer_chat_id INTEGER');
  addColumn(db, 'bot_meetings', 'source_msg_id INTEGER');
  addColumn(db, 'bot_meetings', 'replaces_id INTEGER');
  addColumn(db, 'bot_meetings', 'superseded_at INTEGER');
  addColumn(db, 'bot_meetings', 'reminded_at INTEGER');
}

/**
 * Диалоги, события и чаты hh.ru, дожимы. Только метаданные: ни одного поля с
 * текстом рекрутёра (единственный текст — наш собственный, у дожима).
 */
export function ensureDialogSchema(db: DatabaseSync): void {
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS dialogs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      channel    TEXT NOT NULL,
      peer_key   TEXT NOT NULL,
      username   TEXT,
      queue_id   INTEGER,
      in_count   INTEGER NOT NULL DEFAULT 0,
      out_count  INTEGER NOT NULL DEFAULT 0,
      bot_count  INTEGER NOT NULL DEFAULT 0,
      meeting_id INTEGER,
      silenced   TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (channel, peer_key)
    );
    CREATE INDEX IF NOT EXISTS idx_dialogs_username ON dialogs(username);
    CREATE INDEX IF NOT EXISTS idx_dialogs_queue ON dialogs(queue_id);
    CREATE TABLE IF NOT EXISTS dialog_events (
      dialog_id INTEGER NOT NULL,
      kind      TEXT NOT NULL,
      at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dialog_events ON dialog_events(dialog_id, at);
    CREATE TABLE IF NOT EXISTS hh_topics (
      topic_id       INTEGER PRIMARY KEY,
      chat_id        INTEGER,
      vacancy_id     TEXT NOT NULL,
      queue_id       INTEGER,
      last_state     TEXT NOT NULL,
      inbox_state    TEXT,
      messages_count INTEGER NOT NULL,
      has_new        INTEGER NOT NULL,
      last_modified  INTEGER,
      baseline_at    INTEGER,
      first_seen_at  INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hh_seen (
      topic_id INTEGER NOT NULL,
      msg_key  TEXT NOT NULL,
      at       INTEGER NOT NULL,
      PRIMARY KEY (topic_id, msg_key)
    );
    CREATE TABLE IF NOT EXISTS followups (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_id   INTEGER NOT NULL,
      contact    TEXT NOT NULL UNIQUE,
      status     TEXT NOT NULL,
      text       TEXT NOT NULL,
      text_mode  TEXT NOT NULL,
      reason     TEXT,
      created_at INTEGER NOT NULL,
      sent_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_followups_sent ON followups(sent_at);
  `);
}
