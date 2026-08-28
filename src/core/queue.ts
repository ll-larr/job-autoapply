import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Vacancy } from './vacancy.js';

export type Status = 'pending' | 'approved' | 'skipped' | 'sent' | 'failed';
export type LetterMode = 'hybrid' | 'full' | 'none';

export interface QueueRow {
  id: number;
  source: string;
  sourceId: string;
  vacancy: Vacancy;
  score: number;
  matched: string[];
  letter: string;
  letterMode: LetterMode;
  status: Status;
  error: string | null;
}

interface DbRow {
  id: number; source: string; source_id: string; vacancy_json: string;
  score: number; matched_json: string; letter: string; letter_mode: string;
  status: string; error: string | null;
}

export class Queue {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS applications (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        source       TEXT NOT NULL,
        source_id    TEXT NOT NULL,
        vacancy_json TEXT NOT NULL,
        score        INTEGER NOT NULL,
        matched_json TEXT NOT NULL,
        letter       TEXT NOT NULL,
        letter_mode  TEXT NOT NULL,
        status       TEXT NOT NULL,
        error        TEXT,
        created_at   INTEGER NOT NULL,
        decided_at   INTEGER,
        sent_at      INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dedupe
        ON applications(source, source_id);
      CREATE INDEX IF NOT EXISTS idx_status ON applications(status);
      CREATE INDEX IF NOT EXISTS idx_sent ON applications(source, sent_at);
    `);
  }

  insertPending(
    v: Vacancy, score: number, matched: string[], letter: string, letterMode: LetterMode,
  ): boolean {
    if (this.has(v)) return false;
    this.db.prepare(`
      INSERT INTO applications
        (source, source_id, vacancy_json, score, matched_json, letter, letter_mode, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      v.source, v.sourceId, JSON.stringify(v), score,
      JSON.stringify(matched), letter, letterMode, Date.now(),
    );
    return true;
  }

  has(v: Vacancy): boolean {
    const row = this.db
      .prepare('SELECT 1 AS found FROM applications WHERE source = ? AND source_id = ?')
      .get(v.source, v.sourceId);
    return row !== undefined;
  }

  listByStatus(status: Status): QueueRow[] {
    const rows = this.db
      .prepare('SELECT * FROM applications WHERE status = ? ORDER BY score DESC, id ASC')
      .all(status) as unknown as DbRow[];
    return rows.map(this.toQueueRow);
  }

  approve(id: number, letter?: string): void {
    if (letter === undefined) {
      this.db.prepare("UPDATE applications SET status='approved', decided_at=? WHERE id=?")
        .run(Date.now(), id);
    } else {
      this.db.prepare("UPDATE applications SET status='approved', letter=?, decided_at=? WHERE id=?")
        .run(letter, Date.now(), id);
    }
  }

  skip(id: number): void {
    this.db.prepare("UPDATE applications SET status='skipped', decided_at=? WHERE id=?")
      .run(Date.now(), id);
  }

  markSent(id: number): void {
    this.db.prepare("UPDATE applications SET status='sent', sent_at=? WHERE id=?")
      .run(Date.now(), id);
  }

  markFailed(id: number, reason: string): void {
    this.db.prepare("UPDATE applications SET status='failed', error=? WHERE id=?")
      .run(reason, id);
  }

  /**
   * Процесс мог умереть между approve и markSent. Такие записи остаются
   * approved без sent_at и должны быть обработаны заново. Дубль невозможен:
   * уникальный индекс не даст вставить вакансию второй раз, а сама отправка
   * идёт по конкретной строке.
   */
  recoverStuck(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM applications WHERE status='approved' AND sent_at IS NULL",
    ).get() as unknown as { n: number };
    return row.n;
  }

  countSentSince(source: string, sinceMs: number): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM applications WHERE source=? AND status='sent' AND sent_at >= ?",
    ).get(source, sinceMs) as unknown as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }

  private toQueueRow = (r: DbRow): QueueRow => ({
    id: r.id,
    source: r.source,
    sourceId: r.source_id,
    vacancy: JSON.parse(r.vacancy_json) as Vacancy,
    score: r.score,
    matched: JSON.parse(r.matched_json) as string[],
    letter: r.letter,
    letterMode: r.letter_mode as LetterMode,
    status: r.status as Status,
    error: r.error,
  });
}
