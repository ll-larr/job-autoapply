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
    const result = letter === undefined
      ? this.db.prepare(
          "UPDATE applications SET status='approved', decided_at=? WHERE id=? AND status='pending'",
        ).run(Date.now(), id)
      : this.db.prepare(
          "UPDATE applications SET status='approved', letter=?, decided_at=? WHERE id=? AND status='pending'",
        ).run(letter, Date.now(), id);
    this.requireTransitioned(id, 'pending', result.changes);
  }

  /**
   * Дописать письмо в строку, которая ещё ждёт решения человека.
   *
   * Нужно, потому что дедупликация по (source, source_id) не даст повторным
   * поиском перегенерировать письмо: вакансия уже в очереди, и следующий
   * прогон её просто пропустит. Если генерация в тот раз не удалась (не было
   * ключа, модель отдала 429), строка навсегда осталась бы с пустым письмом,
   * и единственным выходом было бы удалить базу и потерять уже принятые
   * решения. Отсюда отдельная операция дозаполнения.
   *
   * Только из `pending`: письмо в одобренной строке трогать нельзя — человек
   * одобрил конкретный текст, и подменять его под ним недопустимо.
   */
  setLetter(id: number, letter: string, letterMode: LetterMode): void {
    const result = this.db.prepare(
      "UPDATE applications SET letter=?, letter_mode=? WHERE id=? AND status='pending'",
    ).run(letter, letterMode, id);
    this.requireTransitioned(id, 'pending', result.changes);
  }

  skip(id: number): void {
    const result = this.db.prepare(
      "UPDATE applications SET status='skipped', decided_at=? WHERE id=? AND status IN ('pending','approved')",
    ).run(Date.now(), id);
    this.requireTransitioned(id, ['pending', 'approved'], result.changes);
  }

  /**
   * Вернуть отменённую строку обратно на рассмотрение.
   *
   * Нужно потому, что «Пропустить» в панели — один клик, а последствия у него
   * необратимые: строка уходит в `skipped`, панель её больше не показывает, а
   * повторный поиск не находит — дедуп по (source, source_id) считает вакансию
   * уже обработанной. Промах мышью стоил бы вакансии навсегда.
   *
   * Только из `skipped` и только в `pending`. Воскрешать `sent` по-прежнему
   * нельзя: отправленный отклик не отменить, и возврат такой строки в очередь
   * означал бы повторную подачу.
   */
  /**
   * Недавно отменённые — для вкладки «Отменённые» в панели.
   *
   * Вкладка существует ради одного: «Пропустить» — один клик, и без возврата
   * промах мышью стоил бы вакансии навсегда. Но держать там всё подряд
   * бессмысленно, поэтому показываем только свежие.
   *
   * Строка при этом НЕ удаляется. Удаление сломало бы дедупликацию: вакансия
   * снова стала бы «невиданной», и следующий поиск притащил бы её обратно —
   * то есть осознанный отказ пользователя отменился бы сам собой через сутки.
   * Поэтому запись живёт вечно, а из вкладки просто уходит.
   */
  listRecentSkipped(withinMs: number, now: number = Date.now()): QueueRow[] {
    const rows = this.db.prepare(
      "SELECT * FROM applications WHERE status='skipped' AND decided_at >= ? ORDER BY decided_at DESC",
    ).all(now - withinMs) as unknown as DbRow[];
    return rows.map(this.toQueueRow);
  }

  unskip(id: number): void {
    const result = this.db.prepare(
      "UPDATE applications SET status='pending', decided_at=NULL WHERE id=? AND status='skipped'",
    ).run(id);
    this.requireTransitioned(id, 'skipped', result.changes);
  }

  markSent(id: number): void {
    const result = this.db.prepare(
      "UPDATE applications SET status='sent', sent_at=? WHERE id=? AND status='approved'",
    ).run(Date.now(), id);
    this.requireTransitioned(id, 'approved', result.changes);
  }

  markFailed(id: number, reason: string): void {
    const result = this.db.prepare(
      "UPDATE applications SET status='failed', error=? WHERE id=? AND status='approved'",
    ).run(reason, id);
    this.requireTransitioned(id, 'approved', result.changes);
  }

  /**
   * Гвард на каждый переход статуса. Все четыре UPDATE выше несут
   * `AND status=<ожидаемый>` (или, для skip, `AND status IN (<ожидаемые>)`)
   * в WHERE, так что переход физически не может случиться из чужого
   * состояния — SQLite просто не находит строку для обновления и
   * .run().changes остаётся 0. Молчаливый no-op здесь недопустим: строка
   * sent, которую approve() тихо не тронул бы, выглядела бы для вызывающего
   * кода как успешно одобренная и снова попала бы в listByStatus('approved')
   * → повторная отправка отклика. Поэтому при changes=0 бросаем ошибку с id
   * и фактическим статусом строки — каждый нелегальный переход в этой
   * системе является багом вызывающего кода, а не штатной ситуацией,
   * которую стоит проглатывать.
   */
  private requireTransitioned(
    id: number,
    expectedFrom: Status | Status[],
    changes: number | bigint,
  ): void {
    if (Number(changes) > 0) return;
    const expectedLabel = Array.isArray(expectedFrom)
      ? expectedFrom.map((s) => `'${s}'`).join(' or ')
      : `'${expectedFrom}'`;
    const existing = this.db
      .prepare('SELECT status FROM applications WHERE id = ?')
      .get(id) as unknown as { status: string } | undefined;
    if (existing === undefined) {
      throw new Error(`Queue: no application with id=${id} (expected status ${expectedLabel})`);
    }
    throw new Error(
      `Queue: illegal transition for id=${id} — expected status ${expectedLabel}, found '${existing.status}'`,
    );
  }

  /**
   * Считает записи, "застрявшие" в approved без sent_at — процесс мог
   * умереть между approve() и markSent() для этой строки. Ремонт не нужен:
   * такая строка уже находится ровно в том состоянии, которого ждёт
   * следующий прогон — listByStatus('approved') подберёт её сам и повторно
   * попытается отправить. Дубль при этом невозможен: уникальный индекс не
   * даст вставить вакансию второй раз, а отправка идёт по конкретной строке,
   * а не по вакансии. Поэтому метод только считает и ничего не мутирует —
   * это диагностика для старта ("N записей ждут отправки с прошлого
   * прогона"), а не восстановительное действие.
   */
  countStuckApproved(): number {
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

  private toQueueRow = (r: DbRow): QueueRow => {
    // JSON.parse doesn't revive Date instances — Vacancy.postedAt is typed
    // Date, but straight off JSON.parse it's a string wearing that type via
    // a lying cast. Parse into the on-the-wire shape (postedAt as string),
    // then explicitly revive it, so the runtime value matches what
    // QueueRow's type promises the caller.
    const wireVacancy = JSON.parse(r.vacancy_json) as Omit<Vacancy, 'postedAt'> & {
      postedAt: string;
    };
    const vacancy: Vacancy = { ...wireVacancy, postedAt: new Date(wireVacancy.postedAt) };
    return {
      id: r.id,
      source: r.source,
      sourceId: r.source_id,
      vacancy,
      score: r.score,
      matched: JSON.parse(r.matched_json) as string[],
      letter: r.letter,
      letterMode: r.letter_mode as LetterMode,
      status: r.status as Status,
      error: r.error,
    };
  };
}
