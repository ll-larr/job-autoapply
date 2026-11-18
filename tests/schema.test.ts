import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { addColumn, ensureBotSchema, ensureDialogSchema } from '../src/core/schema.js';
import { BotStore } from '../src/bot/state.js';

const columns = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map((r) => r.name);

describe('схема бота', () => {
  it('база, созданная до секретаря, получает новые колонки; данные целы', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'jaa-schema-')), 'queue.db');
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE bot_chats (chat_id INTEGER PRIMARY KEY, username TEXT, mode TEXT NOT NULL, mode_until INTEGER,
        last_msg_at INTEGER NOT NULL, strikes INTEGER NOT NULL DEFAULT 0, muted_until INTEGER, last_queue_id INTEGER);
      CREATE TABLE bot_meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, username TEXT,
        queue_id INTEGER, meet_at INTEGER NOT NULL, raw TEXT NOT NULL, created_at INTEGER NOT NULL, notified_at INTEGER);
      INSERT INTO bot_meetings (chat_id, username, queue_id, meet_at, raw, created_at) VALUES (5, 'old', NULL, 1000, 'x', 900);
    `);
    old.close();

    const store = new BotStore(path);
    store.close();
    const db = new DatabaseSync(path);
    expect(columns(db, 'bot_meetings')).toEqual(expect.arrayContaining([
      'channel', 'peer_chat_id', 'source_msg_id', 'replaces_id', 'superseded_at', 'reminded_at',
    ]));
    expect(columns(db, 'bot_chats')).toEqual(expect.arrayContaining(['pending_meet_at', 'offered_slots']));
    expect(db.prepare('SELECT username FROM bot_meetings').all()).toEqual([{ username: 'old' }]);
    for (const table of ['bot_connections', 'bot_seen', 'dialogs', 'dialog_events', 'hh_topics', 'hh_seen', 'followups']) {
      expect(columns(db, table).length).toBeGreaterThan(0);
    }
    db.close();
  });

  it('повторное открытие идемпотентно, старая строка встречи читается как «чат с ботом»', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'jaa-schema-')), 'queue.db');
    new BotStore(path).close();
    const again = new BotStore(path);
    const id = again.saveMeeting({ chatId: 5, username: 'u', queueId: null, meetAt: 5, raw: 'r', createdAt: 1 });
    expect(again.meetingById(id)).toMatchObject({ channel: null, peerChatId: null, supersededAt: null });
    again.close();
  });

  it('addColumn бросает, если колонки нет и после попытки (таблицы нет), и не трогает существующую', () => {
    const db = new DatabaseSync(':memory:');
    expect(() => addColumn(db, 'нет_такой', 'x INTEGER')).toThrow(/колонка нет_такой\.x не создалась/);
    db.exec('CREATE TABLE t (a INTEGER)');
    addColumn(db, 't', 'b TEXT');
    addColumn(db, 't', 'b TEXT');
    expect(columns(db, 't')).toEqual(['a', 'b']);
    ensureBotSchema(db);
    ensureDialogSchema(db);
    ensureBotSchema(db);
    db.close();
  });

  it('в новых таблицах нет ни одной колонки для текста рекрутёра, кроме нашего текста дожима', () => {
    const db = new DatabaseSync(':memory:');
    ensureBotSchema(db);
    ensureDialogSchema(db);
    const textual = ['bot_connections', 'bot_seen', 'dialogs', 'dialog_events', 'hh_topics', 'hh_seen']
      .flatMap((t) => columns(db, t).filter((c) => /text|raw|body|message$/.test(c)).map((c) => `${t}.${c}`));
    expect(textual).toEqual([]);
    expect(columns(db, 'followups')).toContain('text');
    db.close();
  });
});
