import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Queue } from '../src/core/queue.js';
import { normalizeVacancy } from '../src/core/vacancy.js';

function mkVacancy(sourceId: string, source = 'hh') {
  return normalizeVacancy({
    source, sourceId, title: 'БА', company: 'C',
    url: `https://x/${sourceId}`, description: 'd', geo: 'Москва',
    postedAt: '2026-08-20T00:00:00Z',
  });
}

let q: Queue;
let dbPath: string;
beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'jaa-q-')), 'test.db');
  q = new Queue(dbPath);
});
afterEach(() => q.close());

describe('Queue дедупликация', () => {
  it('вторая вставка той же вакансии отклоняется', () => {
    const v = mkVacancy('1');
    expect(q.insertPending(v, 50, ['sql'], 'письмо', 'hybrid')).toBe(true);
    expect(q.insertPending(v, 50, ['sql'], 'другое письмо', 'full')).toBe(false);
    expect(q.listByStatus('pending')).toHaveLength(1);
  });

  it('одинаковый sourceId на разных площадках — разные записи', () => {
    expect(q.insertPending(mkVacancy('1', 'hh'), 50, [], 'l', 'hybrid')).toBe(true);
    expect(q.insertPending(mkVacancy('1', 'hrge'), 50, [], 'l', 'hybrid')).toBe(true);
    expect(q.listByStatus('pending')).toHaveLength(2);
  });

  it('has видит вакансию в любом статусе, включая skipped', () => {
    const v = mkVacancy('7');
    q.insertPending(v, 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    q.skip(row.id);
    expect(q.has(v)).toBe(true);
  });

  it('уникальный индекс (source, source_id) отклоняет дубликат сам по себе, в обход insertPending', () => {
    const v = mkVacancy('29');
    expect(q.insertPending(v, 50, [], 'l', 'hybrid')).toBe(true);

    // insertPending() никогда не дойдёт до второго INSERT для того же
    // (source, source_id) — has() отсекает его раньше. Чтобы доказать, что
    // гарантия живёт в схеме, а не только в этом ранн-ретёрне, открываем
    // второе сырое соединение с тем же файлом БД и вставляем дубликат
    // напрямую через SQL, полностью в обход insertPending и его guard'а.
    // Если убрать `CREATE UNIQUE INDEX idx_dedupe` из схемы, эта вставка
    // пройдёт молча и тест упадёт.
    const raw = new DatabaseSync(dbPath);
    try {
      expect(() => {
        raw.prepare(`
          INSERT INTO applications
            (source, source_id, vacancy_json, score, matched_json, letter, letter_mode, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(
          v.source, v.sourceId, JSON.stringify(v), 50,
          JSON.stringify([]), 'дубликат в обход guard-а', 'hybrid', Date.now(),
        );
      }).toThrow(/UNIQUE constraint failed/);
    } finally {
      raw.close();
    }
  });
});

describe('Queue переходы статусов', () => {
  it('approve сохраняет отредактированное письмо', () => {
    q.insertPending(mkVacancy('2'), 50, [], 'исходное', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    q.approve(row.id, 'отредактированное');
    const approved = q.listByStatus('approved')[0]!;
    expect(approved.letter).toBe('отредактированное');
  });

  it('markFailed пишет причину', () => {
    q.insertPending(mkVacancy('3'), 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    q.approve(row.id);
    q.markFailed(row.id, 'кнопка не найдена');
    expect(q.listByStatus('failed')[0]!.error).toBe('кнопка не найдена');
  });
});

describe('Queue защита переходов статусов', () => {
  it('approve на уже sent строке не возвращает её в approved (защита от двойной отправки)', () => {
    q.insertPending(mkVacancy('20'), 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    q.approve(row.id);
    q.markSent(row.id);
    expect(() => q.approve(row.id)).toThrow();
    expect(q.listByStatus('approved')).toHaveLength(0);
    expect(q.listByStatus('sent')).toHaveLength(1);
  });

  it('markSent на pending строке не пропускает согласование', () => {
    q.insertPending(mkVacancy('21'), 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    expect(() => q.markSent(row.id)).toThrow();
    expect(q.listByStatus('sent')).toHaveLength(0);
    expect(q.listByStatus('pending')).toHaveLength(1);
  });

  it('markFailed на pending строке отклоняется', () => {
    q.insertPending(mkVacancy('23'), 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    expect(() => q.markFailed(row.id, 'причина')).toThrow();
    expect(q.listByStatus('failed')).toHaveLength(0);
  });

  it('ошибка при нелегальном переходе называет id и текущий статус', () => {
    q.insertPending(mkVacancy('27'), 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    q.approve(row.id);
    q.markSent(row.id);
    expect(() => q.approve(row.id)).toThrow(new RegExp(`${row.id}`));
    expect(() => q.approve(row.id)).toThrow(/sent/);
  });

  it('переход над несуществующим id называет id и явно говорит, что строки нет', () => {
    expect(() => q.approve(999999)).toThrow(/no application with id=999999/);
    expect(() => q.markFailed(999999, 'причина')).toThrow(/no application with id=999999/);
  });

  it('легальные переходы pending→approved→sent по-прежнему работают', () => {
    q.insertPending(mkVacancy('24'), 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    expect(() => q.approve(row.id)).not.toThrow();
    expect(() => q.markSent(row.id)).not.toThrow();
    expect(q.listByStatus('sent')).toHaveLength(1);
  });

  it('легальный переход pending→skipped по-прежнему работает', () => {
    q.insertPending(mkVacancy('25'), 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    expect(() => q.skip(row.id)).not.toThrow();
    expect(q.listByStatus('skipped')).toHaveLength(1);
  });

  it('легальный переход approved→failed по-прежнему работает', () => {
    q.insertPending(mkVacancy('26'), 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    q.approve(row.id);
    expect(() => q.markFailed(row.id, 'причина')).not.toThrow();
    expect(q.listByStatus('failed')).toHaveLength(1);
  });
});

describe('Queue skip: отмена доступна и из pending, и из approved', () => {
  it('skip из pending работает', () => {
    q.insertPending(mkVacancy('30'), 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    expect(() => q.skip(row.id)).not.toThrow();
    expect(q.listByStatus('skipped')).toHaveLength(1);
  });

  it('skip из approved работает — человек может передумать до того, как отправитель заберёт строку', () => {
    q.insertPending(mkVacancy('31'), 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    q.approve(row.id);
    expect(() => q.skip(row.id)).not.toThrow();
    expect(q.listByStatus('skipped')).toHaveLength(1);
    expect(q.listByStatus('approved')).toHaveLength(0);
  });

  it('skip из sent отклоняется — отправленное нельзя отменить', () => {
    q.insertPending(mkVacancy('32'), 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    q.approve(row.id);
    q.markSent(row.id);
    expect(() => q.skip(row.id)).toThrow();
    expect(q.listByStatus('sent')).toHaveLength(1);
    expect(q.listByStatus('skipped')).toHaveLength(0);
  });

  it('skip из failed отклоняется — не должен прятать причину неудачи', () => {
    q.insertPending(mkVacancy('33'), 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    q.approve(row.id);
    q.markFailed(row.id, 'причина');
    expect(() => q.skip(row.id)).toThrow();
    expect(q.listByStatus('failed')).toHaveLength(1);
    expect(q.listByStatus('skipped')).toHaveLength(0);
  });
});

describe('Queue восстановление после обрыва', () => {
  it('approved без sent_at остаются в работе и считаются countStuckApproved', () => {
    q.insertPending(mkVacancy('4'), 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    q.approve(row.id);
    expect(q.countStuckApproved()).toBe(1);
    expect(q.listByStatus('approved')).toHaveLength(1);
  });

  it('отправленные countStuckApproved не трогает', () => {
    q.insertPending(mkVacancy('5'), 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    q.approve(row.id);
    q.markSent(row.id);
    expect(q.countStuckApproved()).toBe(0);
    expect(q.listByStatus('sent')).toHaveLength(1);
  });

  it('countStuckApproved считает ровно approved-без-sent_at, даже когда рядом одновременно есть pending и sent', () => {
    q.insertPending(mkVacancy('6'), 50, [], 'l', 'hybrid'); // останется pending
    q.insertPending(mkVacancy('7'), 50, [], 'l', 'hybrid'); // станет approved, sent_at IS NULL
    q.insertPending(mkVacancy('8'), 50, [], 'l', 'hybrid'); // станет sent

    const pending = q.listByStatus('pending');
    const toApprove = pending.find((r) => r.sourceId === '7')!;
    const toSend = pending.find((r) => r.sourceId === '8')!;

    q.approve(toApprove.id);
    q.approve(toSend.id);
    q.markSent(toSend.id);

    expect(q.countStuckApproved()).toBe(1);
    expect(q.listByStatus('pending')).toHaveLength(1);
    expect(q.listByStatus('approved')).toHaveLength(1);
    expect(q.listByStatus('sent')).toHaveLength(1);
  });
});

describe('Queue честность типов после JSON round-trip', () => {
  it('vacancy.postedAt в прочитанной строке — настоящий Date, а не строка, и указывает на тот же момент', () => {
    const postedAtIso = '2026-08-20T00:00:00.000Z';
    const v = mkVacancy('28');
    expect(v.postedAt.toISOString()).toBe(postedAtIso);
    q.insertPending(v, 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    expect(row.vacancy.postedAt).toBeInstanceOf(Date);
    expect(row.vacancy.postedAt.getTime()).toBe(new Date(postedAtIso).getTime());
  });
});

describe('Queue счётчики для троттлинга', () => {
  it('countSentSince считает только отправленные по этой площадке', () => {
    for (const id of ['10', '11']) {
      q.insertPending(mkVacancy(id, 'hh'), 50, [], 'l', 'hybrid');
    }
    q.insertPending(mkVacancy('12', 'hrge'), 50, [], 'l', 'hybrid');
    for (const row of q.listByStatus('pending')) {
      q.approve(row.id);
      q.markSent(row.id);
    }
    expect(q.countSentSince('hh', Date.now() - 3600_000)).toBe(2);
    expect(q.countSentSince('hrge', Date.now() - 3600_000)).toBe(1);
  });
});
