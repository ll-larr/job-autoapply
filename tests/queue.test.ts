import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
beforeEach(() => {
  q = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-q-')), 'test.db'));
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

describe('Queue восстановление после обрыва', () => {
  it('approved без sent_at остаются в работе и считаются recoverStuck', () => {
    q.insertPending(mkVacancy('4'), 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    q.approve(row.id);
    expect(q.recoverStuck()).toBe(1);
    expect(q.listByStatus('approved')).toHaveLength(1);
  });

  it('отправленные recoverStuck не трогает', () => {
    q.insertPending(mkVacancy('5'), 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    q.approve(row.id);
    q.markSent(row.id);
    expect(q.recoverStuck()).toBe(0);
    expect(q.listByStatus('sent')).toHaveLength(1);
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
