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
  letterModels: ['model-a:free'],
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

function seed(q: Queue, n: number, source = 'hh') {
  for (let i = 0; i < n; i++) {
    const v = normalizeVacancy({
      source, sourceId: `${source}-${i}`, title: 'БА', company: 'C',
      url: 'u', description: 'd', geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
    });
    q.insertPending(v, 50, [], 'письмо', 'hybrid');
  }
  for (const row of q.listByStatus('pending')) q.approve(row.id);
}

let q: Queue;
let dbPath: string;
beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'jaa-s-')), 'test.db');
  q = new Queue(dbPath);
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
  // Настоящий перезапуск пересоздаёт и Queue, не только Sender — процесс
  // умер, все его объекты вместе с ним. Поэтому здесь закрывается первое
  // соединение и открывается новое поверх того же файла на диске: если бы
  // лимит был закэширован где-то в Queue (а не пересчитывался из
  // applications.sent_at при каждом countSentSince), второй прогон над
  // свежим Queue отправил бы ещё 2 письма.
  it('лимит переживает перезапуск процесса — счётчик читается из БД, а не из памяти', async () => {
    seed(q, 3);
    const s1 = new Sender(q, new Map([['hh', mkAdapter([{ status: 'sent' }])]]), CONFIG, {
      sleep: async () => {},
    });
    const rep1 = await s1.run();
    expect(rep1.sent).toBe(2);
    q.close();

    const q2 = new Queue(dbPath);
    const s2 = new Sender(q2, new Map([['hh', mkAdapter([{ status: 'sent' }])]]), CONFIG, {
      sleep: async () => {},
    });
    const rep2 = await s2.run();
    expect(rep2.sent).toBe(0);
    expect(q2.listByStatus('approved')).toHaveLength(1);
    q2.close();
  });

  // maxPerHour is loose everywhere else in this file (10, always looser than
  // the seeded volume), so the inDay >= rule.maxPerDay branch is never the
  // binding constraint anywhere but here: maxPerHour is set to 100 (would
  // never trip for 5 rows) while maxPerDay is set to 2, so only the daily
  // check can be what stops sending at 2.
  it('дневной лимит останавливает отправку раньше часового, когда именно он тесный', async () => {
    seed(q, 5);
    const config = {
      ...CONFIG,
      throttle: { hh: { maxPerHour: 100, maxPerDay: 2, minDelayMs: 0, maxDelayMs: 0 } },
    };
    const s = new Sender(q, new Map([['hh', mkAdapter([{ status: 'sent' }])]]), config, {
      sleep: async () => {},
    });
    const rep = await s.run();
    expect(rep.sent).toBe(2);
    expect(q.listByStatus('approved')).toHaveLength(3);
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

describe('Sender троттлинг: fail-closed без правила', () => {
  // Источник есть в adapters, но отсутствует в config.throttle (опечатка в
  // конфиге или забытая запись для нового адаптера). Раньше guard
  // `if (rule !== undefined)` в sender.ts делал троттлинг необязательным:
  // отсутствие правила означало "без лимита и без паузы", а не "не
  // отправлять". Это ровно противоположность назначению модуля — он
  // существует, чтобы аккаунт пользователя на hh.ru не забанили за
  // нечеловеческую скорость подачи заявок.
  //
  // Защита теперь скопирована на конкретный источник: заявки по hrge (без
  // правила) не должны уйти вообще — ни одного вызова apply, строки
  // остаются approved. Но это больше не должно останавливать hh (с
  // правилом) — один опечатавшийся конфиг для нового адаптера не должен
  // валить отправку для уже работающих источников. Пропуск обязан быть
  // громким: unthrottledSources называет источник, а не проглатывает
  // проблему молча.
  it('источник в adapters без правила в config.throttle — apply не вызывается только для него, остальные источники отправляют штатно', async () => {
    seed(q, 2, 'hh');
    seed(q, 2, 'hrge');

    let hhApplyCalls = 0;
    let hrgeApplyCalls = 0;
    const adapters = new Map<string, Adapter>([
      ['hh', {
        name: 'hh',
        async search() { return []; },
        async apply() { hhApplyCalls++; return { status: 'sent' }; },
      }],
      ['hrge', {
        name: 'hrge',
        async search() { return []; },
        async apply() { hrgeApplyCalls++; return { status: 'sent' }; },
      }],
    ]);
    // CONFIG.throttle only has an 'hh' entry — 'hrge' is the missing one.
    const s = new Sender(q, adapters, CONFIG, { sleep: async () => {} });

    const rep = await s.run();

    expect(rep.unthrottledSources).toEqual(['hrge']);
    expect(hhApplyCalls).toBe(2);
    expect(hrgeApplyCalls).toBe(0);
    expect(rep.sent).toBe(2);
    expect(q.listByStatus('sent')).toHaveLength(2);
    // The 2 hrge rows are the only ones still approved — hh's rows both sent.
    const stillApproved = q.listByStatus('approved');
    expect(stillApproved).toHaveLength(2);
    expect(stillApproved.every((r) => r.source === 'hrge')).toBe(true);
    expect(q.listByStatus('failed')).toHaveLength(0);
  });

  // Прогон #1 пропускает hrge из-за отсутствующего правила — строки должны
  // остаться отправляемыми, а не застрять. Как только конфиг чинят
  // (добавляют запись throttle.hrge), следующий run() обязан отправить их
  // без какого-либо ручного вмешательства в БД.
  it('пропущенные из-за отсутствия правила строки отправляются повторным прогоном после починки конфига', async () => {
    seed(q, 2, 'hrge');

    let hrgeApplyCalls = 0;
    const hrgeAdapter: Adapter = {
      name: 'hrge',
      async search() { return []; },
      async apply() { hrgeApplyCalls++; return { status: 'sent' }; },
    };
    const adapters = new Map<string, Adapter>([['hrge', hrgeAdapter]]);

    const s1 = new Sender(q, adapters, CONFIG, { sleep: async () => {} });
    const rep1 = await s1.run();
    expect(rep1.unthrottledSources).toEqual(['hrge']);
    expect(hrgeApplyCalls).toBe(0);
    expect(q.listByStatus('approved')).toHaveLength(2);

    const fixedConfig = {
      ...CONFIG,
      throttle: {
        ...CONFIG.throttle,
        hrge: { maxPerHour: 2, maxPerDay: 10, minDelayMs: 0, maxDelayMs: 0 },
      },
    };
    const s2 = new Sender(q, adapters, fixedConfig, { sleep: async () => {} });
    const rep2 = await s2.run();
    expect(rep2.unthrottledSources).toEqual([]);
    expect(hrgeApplyCalls).toBe(2);
    expect(rep2.sent).toBe(2);
    expect(q.listByStatus('sent')).toHaveLength(2);
    expect(q.listByStatus('approved')).toHaveLength(0);
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

describe('Sender предохранитель по череде отказов', () => {
  it('останавливается после N отказов подряд, не выгребая всю очередь', async () => {
    // Защита на случай, когда адаптер НЕ распознал капчу: тогда она выглядит
    // как обычные failed, и без предохранителя очередь продолжала бы долбить
    // площадку. У hh.ru детектор капчи пока заглушка, так что это не гипотеза.
    seed(q, 6);
    let applyCalls = 0;
    const alwaysFails: Adapter = {
      name: 'hh',
      async search() { return []; },
      async apply() { applyCalls++; return { status: 'failed', reason: 'что-то сломалось' }; },
    };
    const s = new Sender(
      q,
      new Map([['hh', alwaysFails]]),
      { ...CONFIG, maxConsecutiveFailures: 3 },
      { sleep: async () => {} },
    );
    const rep = await s.run();

    expect(applyCalls).toBe(3);
    expect(rep.halted).toEqual({ source: 'hh', reason: 'too_many_failures' });
    expect(rep.failed).toBe(3);
    // Остальные не тронуты и уйдут следующим прогоном, когда причину починят.
    expect(q.listByStatus('approved')).toHaveLength(3);
  });

  it('успех между отказами сбрасывает счётчик', async () => {
    seed(q, 5);
    let n = 0;
    const flaky: Adapter = {
      name: 'hh',
      async search() { return []; },
      async apply() {
        n++;
        // отказ, отказ, успех, отказ, отказ — подряд трёх не набирается
        if (n === 3) return { status: 'sent' };
        return { status: 'failed', reason: 'сбой' };
      },
    };
    const s = new Sender(
      q,
      new Map([['hh', flaky]]),
      { ...CONFIG, maxConsecutiveFailures: 3 },
      { sleep: async () => {} },
    );
    const rep = await s.run();

    expect(rep.halted).toBeNull();
    expect(n).toBe(5);
    expect(rep.sent).toBe(1);
    expect(rep.failed).toBe(4);
  });
});
