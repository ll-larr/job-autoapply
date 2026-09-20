import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { selectAutoApprovals, autoApproveAfterSearch } from '../src/core/autoapply.js';
import { Queue, type QueueRow } from '../src/core/queue.js';
import { normalizeVacancy } from '../src/core/vacancy.js';
import { seedSettings } from '../src/core/settings.js';

function row(over: Partial<QueueRow>): QueueRow {
  return {
    id: 1, source: 'hh', sourceId: '1', vacancy: {} as never, score: 60, matched: [], letter: 'письмо',
    letterMode: 'hybrid', status: 'pending', error: null, specialty: 'business-analyst', contact: null,
    approvedBy: null, createdAt: 0, sentAt: null, ...over,
  };
}
const NONE = { minScore: 40, recentContact: () => false };

describe('selectAutoApprovals (спека 7.2)', () => {
  it('годная строка одобряется', () => {
    expect(selectAutoApprovals([row({})], NONE)).toEqual({ approve: [1], skipped: [] });
  });
  it('пустое письмо и mode none — нет', () => {
    const r = selectAutoApprovals([row({ id: 1, letter: '  ' }), row({ id: 2, letterMode: 'none', letter: '' })], NONE);
    expect(r.approve).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual(['empty_letter', 'empty_letter']);
  });
  it('скор ниже порога автоотклика — нет', () => {
    expect(selectAutoApprovals([row({ score: 50 })], { ...NONE, minScore: 55 }).skipped[0]!.reason).toBe('below_threshold');
  });
  it('контакт за 7 дней — нет', () => {
    const r = selectAutoApprovals([row({ contact: 'hr' })], { ...NONE, recentContact: () => true });
    expect(r.skipped[0]!.reason).toBe('recent_contact');
  });
  it('два поста одного рекрутёра в одном прогоне — одобряется только первый по скору', () => {
    const r = selectAutoApprovals(
      [row({ id: 1, contact: 'hr', score: 50 }), row({ id: 2, contact: 'hr', score: 70 })],
      NONE,
    );
    expect(r.approve).toEqual([2]);
    expect(r.skipped).toEqual([{ id: 1, reason: 'recent_contact' }]);
  });
});

describe('autoApproveAfterSearch — на настоящей очереди', () => {
  const CONFIG = { minScore: 40, letterFullThreshold: 75, letterModels: ['m'], throttle: {} };

  function mk(): Queue {
    return new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-auto-')), 't.db'));
  }
  function add(q: Queue, id: string, over: { score?: number; letter?: string; contact?: string; source?: string } = {}) {
    q.insertPending(normalizeVacancy({
      source: over.source ?? 'tg', sourceId: id, title: `Вакансия ${id}`, company: '', url: `u${id}`,
      description: 'd', geo: '', postedAt: '2026-09-19T00:00:00Z', contact: over.contact ?? null,
    }), over.score ?? 60, [], over.letter ?? 'письмо', 'dm');
  }

  it('выключен — не трогает ничего', () => {
    const q = mk();
    add(q, '1');
    const r = autoApproveAfterSearch(q, 0, seedSettings(undefined, null), CONFIG);
    expect(r).toEqual({ approved: 0, skipped: [] });
    expect(q.listByStatus('pending')).toHaveLength(1);
    q.close();
  });

  it('включён — одобряет только строки этого прогона, с пометкой auto; порог по умолчанию — общий minScore', () => {
    const q = mk();
    add(q, 'old');
    const since = Date.now() + 1;
    while (Date.now() < since) { /* строки прогона — строго позже since */ }
    add(q, 'fresh', { score: 45 });
    add(q, 'low', { score: 39 });
    const settings = seedSettings(undefined, null);
    settings.autoApply = { enabled: true, minScore: null };
    const r = autoApproveAfterSearch(q, since, settings, CONFIG);
    expect(r.approved).toBe(1);
    expect(q.listByStatus('approved').map((x) => [x.sourceId, x.approvedBy])).toEqual([['fresh', 'auto']]);
    expect(q.listByStatus('pending').map((x) => x.sourceId).sort()).toEqual(['low', 'old']);
    q.close();
  });

  it('контакту писали 3 дня назад — строка остаётся на просмотр', () => {
    const q = mk();
    add(q, 'sent', { contact: 'hr_a' });
    const [sent] = q.listByStatus('pending');
    q.approve(sent!.id);
    q.markSent(sent!.id);
    add(q, 'again', { contact: 'hr_a' });
    const settings = seedSettings(undefined, null);
    settings.autoApply = { enabled: true, minScore: null };
    const r = autoApproveAfterSearch(q, 0, settings, CONFIG, () => Date.now() + 3 * 86_400_000);
    expect(r.approved).toBe(0);
    expect(r.skipped).toEqual([{ id: q.listByStatus('pending')[0]!.id, reason: 'recent_contact' }]);
    q.close();
  });
});
