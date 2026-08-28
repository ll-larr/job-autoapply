import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Sender } from '../src/core/sender.js';
import { Queue } from '../src/core/queue.js';
import { normalizeVacancy } from '../src/core/vacancy.js';
import type { Adapter, ApplyResult } from '../src/adapters/types.js';

const CONFIG = {
  minScore: 40,
  letterFullThreshold: 75,
  throttle: { hh: { maxPerHour: 2, maxPerDay: 10, minDelayMs: 0, maxDelayMs: 0 } },
};

function mkAdapter(results: ApplyResult[]): Adapter {
  let i = 0;
  return {
    name: 'hh',
    async search() { return []; },
    async apply() { return results[Math.min(i++, results.length - 1)]!; },
  };
}

function seed(q: Queue, n: number) {
  for (let i = 0; i < n; i++) {
    const v = normalizeVacancy({
      source: 'hh', sourceId: String(i), title: 'БА', company: 'C',
      url: 'u', description: 'd', geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
    });
    q.insertPending(v, 50, [], 'письмо', 'hybrid');
  }
  for (const row of q.listByStatus('pending')) q.approve(row.id);
}

let q: Queue;
beforeEach(() => {
  q = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-s-')), 'test.db'));
});

describe('Sender троттлинг', () => {
  it('не превышает maxPerHour за один прогон', async () => {
    seed(q, 5);
    const s = new Sender(q, new Map([['hh', mkAdapter([{ status: 'sent' }])]]), CONFIG, {
      sleep: async () => {},
    });
    const rep = await s.run();
    expect(rep.sent).toBe(2);
    expect(q.listByStatus('approved')).toHaveLength(3);
  });

  // Лимит должен пережить перезапуск процесса: он читается из БД
  // (countSentSince), а не накапливается в памяти этого экземпляра Sender.
  // Второй, независимый экземпляр Sender над тем же файлом БД имитирует
  // "новый процесс, старая очередь" — если бы лимит жил только в памяти
  // первого Sender, этот второй прогон отправил бы ещё 2 письма.
  it('лимит переживает перезапуск процесса — счётчик читается из БД, а не из памяти', async () => {
    seed(q, 3);
    const s1 = new Sender(q, new Map([['hh', mkAdapter([{ status: 'sent' }])]]), CONFIG, {
      sleep: async () => {},
    });
    const rep1 = await s1.run();
    expect(rep1.sent).toBe(2);

    const s2 = new Sender(q, new Map([['hh', mkAdapter([{ status: 'sent' }])]]), CONFIG, {
      sleep: async () => {},
    });
    const rep2 = await s2.run();
    expect(rep2.sent).toBe(0);
    expect(q.listByStatus('approved')).toHaveLength(1);
  });

  // delays.length > 0 by itself would also pass if sleep fired only once,
  // anywhere, for any reason. Assert the actual sequence instead: apply,
  // then sleep, then the next apply — that's what "a pause between sends"
  // means operationally.
  it('вызывает sleep между отправками, а не просто хоть раз', async () => {
    seed(q, 2);
    const order: string[] = [];
    const adapter: Adapter = {
      name: 'hh',
      async search() { return []; },
      async apply() { order.push('apply'); return { status: 'sent' }; },
    };
    const s = new Sender(q, new Map([['hh', adapter]]), CONFIG, {
      sleep: async () => { order.push('sleep'); },
    });
    await s.run();
    expect(order.slice(0, 3)).toEqual(['apply', 'sleep', 'apply']);
  });
});

describe('Sender остановка', () => {
  it('капча останавливает очередь и возвращает запись в approved', async () => {
    seed(q, 3);
    const s = new Sender(q, new Map([['hh', mkAdapter([{ status: 'captcha' }])]]), CONFIG, {
      sleep: async () => {},
    });
    const rep = await s.run();
    expect(rep.halted).toEqual({ source: 'hh', reason: 'captcha' });
    expect(rep.sent).toBe(0);
    expect(q.listByStatus('approved')).toHaveLength(3);
    expect(q.listByStatus('failed')).toHaveLength(0);
  });

  it('auth_required тоже останавливает и тоже не трогает статус строки', async () => {
    seed(q, 2);
    const s = new Sender(q, new Map([['hh', mkAdapter([{ status: 'auth_required' }])]]), CONFIG, {
      sleep: async () => {},
    });
    const rep = await s.run();
    expect(rep.halted?.reason).toBe('auth_required');
    expect(q.listByStatus('approved')).toHaveLength(2);
    expect(q.listByStatus('failed')).toHaveLength(0);
  });

  it('обычный failed очередь не останавливает', async () => {
    seed(q, 2);
    const s = new Sender(q, new Map([['hh', mkAdapter([
      { status: 'failed', reason: 'кнопка не найдена' }, { status: 'sent' },
    ])]]), CONFIG, { sleep: async () => {} });
    const rep = await s.run();
    expect(rep.halted).toBeNull();
    expect(rep.failed).toBe(1);
    expect(rep.sent).toBe(1);
  });

  it('already_applied засчитывается как sent — дедуп догоняет', async () => {
    seed(q, 1);
    const s = new Sender(q, new Map([['hh', mkAdapter([{ status: 'already_applied' }])]]), CONFIG, {
      sleep: async () => {},
    });
    await s.run();
    expect(q.listByStatus('sent')).toHaveLength(1);
  });
});

describe('Sender kill switch', () => {
  it('поднятый флаг останавливает отправку до первой подачи', async () => {
    seed(q, 3);
    let applyCalls = 0;
    const counting: Adapter = {
      name: 'hh',
      async search() { return []; },
      async apply() { applyCalls++; return { status: 'sent' }; },
    };
    const s = new Sender(q, new Map([['hh', counting]]), CONFIG, {
      sleep: async () => {},
      stopRequested: () => true,
    });
    const rep = await s.run();
    expect(applyCalls).toBe(0);
    expect(rep.halted).toEqual({ source: '-', reason: 'killed' });
    expect(q.listByStatus('approved')).toHaveLength(3);
  });

  it('флаг, поднятый в середине, останавливает после текущей подачи', async () => {
    seed(q, 3);
    let calls = 0;
    const s = new Sender(q, new Map([['hh', mkAdapter([{ status: 'sent' }])]]), CONFIG, {
      sleep: async () => {},
      stopRequested: () => calls++ >= 1,
    });
    const rep = await s.run();
    expect(rep.sent).toBe(1);
    expect(rep.halted?.reason).toBe('killed');
    expect(q.listByStatus('approved')).toHaveLength(2);
  });
});
