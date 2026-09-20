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
  // Отправщик поисковыми запросами не пользуется, но Config требует их для
  // команды search, поэтому фикстура несёт пустой список.
  searchQueries: [],
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
      source, sourceId: `${source}-${i}`, title: 'Бизнес-аналитик', company: 'C',
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

describe('Sender — строка из бота (спека 2026-09-20, 5.7)', () => {
  it('не отправляется ничем, но пропуск виден в отчёте, а не молчит', async () => {
    seed(q, 1, 'tg-bot');
    seed(q, 1, 'hh');
    let hhCalls = 0;
    const adapters = new Map<string, Adapter>([
      ['hh', { name: 'hh', async search() { return []; }, async apply() { hhCalls++; return { status: 'sent' }; } }],
    ]);

    const rep = await new Sender(q, adapters, CONFIG, { sleep: async () => {} }).run();

    expect(hhCalls).toBe(1);
    expect(rep.warnings.some((w) => w.includes('ответ уже отправлен ботом'))).toBe(true);
    // Строка остаётся approved, а не падает в failed: это не поломка.
    expect(q.listByStatus('approved').map((r) => r.source)).toEqual(['tg-bot']);
    expect(q.listByStatus('failed')).toHaveLength(0);
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

  it('закрытая вакансия — отказ с причиной, но в счётчик поломки не идёт', async () => {
    // Живой случай 2026-09-19: вакансия 136227311 ушла в архив, пока ждала
    // отправки. Три архивных подряд — обычное дело для старых заявок, и
    // гасить из-за них площадку значит не отправить исправные.
    seed(q, 5);
    let applyCalls = 0;
    const allClosed: Adapter = {
      name: 'hh',
      async search() { return []; },
      async apply() { applyCalls++; return { status: 'closed' }; },
    };
    const s = new Sender(
      q,
      new Map([['hh', allClosed]]),
      { ...CONFIG, throttle: { hh: { minDelayMs: 0, maxDelayMs: 0 } }, maxConsecutiveFailures: 3 },
      { sleep: async () => {} },
    );
    const rep = await s.run();

    expect(applyCalls).toBe(5);
    expect(rep.halted).toBeNull();
    expect(rep.failed).toBe(5);
    const failed = q.listByStatus('failed');
    expect(failed).toHaveLength(5);
    expect(failed[0]!.error).toContain('архив');
  });

  it('исключение из адаптера — отказ этой заявки, отправка идёт дальше', async () => {
    seed(q, 3);
    let n = 0;
    const flaky: Adapter = {
      name: 'hh',
      async search() { return []; },
      async apply() {
        if (n++ === 0) throw new Error('locator.click: Timeout 30000ms exceeded.');
        return { status: 'sent' };
      },
    };
    const s = new Sender(
      q,
      new Map([['hh', flaky]]),
      { ...CONFIG, throttle: { hh: { minDelayMs: 0, maxDelayMs: 0 } } },
      { sleep: async () => {} },
    );
    const rep = await s.run();

    expect(rep.sent).toBe(2);
    expect(rep.failed).toBe(1);
    expect(q.listByStatus('failed')[0]!.error).toContain('Timeout 30000ms');
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

describe('Sender лимиты как «без ограничения»', () => {
  const NO_CAPS = {
    ...CONFIG,
    throttle: { hh: { minDelayMs: 0, maxDelayMs: 0 } },
  };

  it('без maxPerHour и maxPerDay отправляет всю очередь за один прогон', () => {
    // Владелец аккаунта снял потолки сознательно. Отсутствие ПОЛЯ означает
    // «без ограничения»; отсутствие всей записи про площадку по-прежнему
    // означает «не слать вовсе» — это разные вещи, проверяются отдельно.
    seed(q, 12);
    const s = new Sender(q, new Map([['hh', mkAdapter([{ status: 'sent' }])]]), NO_CAPS, {
      sleep: async () => {},
    });
    return s.run().then((rep) => {
      expect(rep.sent).toBe(12);
      expect(q.listByStatus('approved')).toHaveLength(0);
    });
  });

  it('заданный часовой лимит по-прежнему работает', async () => {
    seed(q, 5);
    const withHourCap = { ...CONFIG, throttle: { hh: { maxPerHour: 2, minDelayMs: 0, maxDelayMs: 0 } } };
    const s = new Sender(q, new Map([['hh', mkAdapter([{ status: 'sent' }])]]), withHourCap, {
      sleep: async () => {},
    });
    const rep = await s.run();
    expect(rep.sent).toBe(2);
  });

  it('площадка без записи в throttle всё равно не шлёт — это другая проверка', async () => {
    // Ключевое различие: снятый лимит это решение, а отсутствующая запись —
    // опечатка в конфиге, и она обязана оставаться fail-closed.
    seed(q, 3);
    let calls = 0;
    const counting: Adapter = {
      name: 'hh',
      async search() { return []; },
      async apply() { calls++; return { status: 'sent' }; },
    };
    const s = new Sender(q, new Map([['hh', counting]]), { ...CONFIG, throttle: {} }, {
      sleep: async () => {},
    });
    const rep = await s.run();
    expect(calls).toBe(0);
    expect(rep.unthrottledSources).toEqual(['hh']);
    expect(q.listByStatus('approved')).toHaveLength(3);
  });
});


/**
 * Остановка по площадке, а не по всему прогону.
 *
 * Пока площадка была одна, разницы не было. Появление careerist.ru её создало:
 * отклик там требует аккаунта, adapter.apply честно отвечает `auth_required`,
 * и при прежнем поведении одна такая заявка означала бы, что до заявок на
 * hh.ru отправка не доходит вообще.
 */
describe('Sender — остановка по площадкам', () => {
  const TWO_SOURCES = {
    ...CONFIG,
    throttle: {
      hh: { minDelayMs: 0, maxDelayMs: 0 },
      careerist: { minDelayMs: 0, maxDelayMs: 0 },
    },
  };

  function mkNamed(name: string, results: ApplyResult[]): Adapter & { calls: number } {
    let i = 0;
    return {
      name,
      calls: 0,
      async search() { return []; },
      async apply(this: { calls: number }) {
        this.calls++;
        return results[Math.min(i++, results.length - 1)]!;
      },
    } as Adapter & { calls: number };
  }

  it('auth_required на одной площадке не мешает отправке на другой', async () => {
    seed(q, 2, 'careerist');
    seed(q, 3, 'hh');

    const careerist = mkNamed('careerist', [{ status: 'auth_required' }]);
    const hh = mkNamed('hh', [{ status: 'sent' }]);
    const s = new Sender(q, new Map<string, Adapter>([['careerist', careerist], ['hh', hh]]),
      TWO_SOURCES, { sleep: async () => {} });

    const rep = await s.run();

    expect(rep.sent).toBe(3);
    expect(rep.haltedSources).toEqual([{ source: 'careerist', reason: 'auth_required' }]);
    // Заявки на площадку, требующую человека, остаются approved — письмо не
    // теряется и уйдёт, когда аккаунт появится.
    expect(q.listByStatus('approved')).toHaveLength(2);
    expect(q.listByStatus('sent')).toHaveLength(3);
    expect(q.listByStatus('failed')).toHaveLength(0);
  });

  it('после остановки площадки её оставшиеся заявки не трогаются повторно', async () => {
    seed(q, 4, 'careerist');
    const careerist = mkNamed('careerist', [{ status: 'auth_required' }]);
    const s = new Sender(q, new Map<string, Adapter>([['careerist', careerist]]),
      TWO_SOURCES, { sleep: async () => {} });

    await s.run();

    // Ровно одна попытка: дальше площадка помечена отвалившейся. Иначе прогон
    // четыре раза стучался бы в форму, которая заведомо требует логина.
    expect(careerist.calls).toBe(1);
    expect(q.listByStatus('approved')).toHaveLength(4);
  });

  it('капча на одной площадке не отменяет отправку на другой', async () => {
    seed(q, 1, 'careerist');
    seed(q, 2, 'hh');
    const careerist = mkNamed('careerist', [{ status: 'captcha' }]);
    const hh = mkNamed('hh', [{ status: 'sent' }]);
    const s = new Sender(q, new Map<string, Adapter>([['careerist', careerist], ['hh', hh]]),
      TWO_SOURCES, { sleep: async () => {} });

    const rep = await s.run();
    expect(rep.sent).toBe(2);
    expect(rep.haltedSources.map((h) => h.reason)).toEqual(['captcha']);
  });

  it('череда отказов гасит только свою площадку', async () => {
    seed(q, 5, 'careerist');
    seed(q, 2, 'hh');
    const careerist = mkNamed('careerist', [{ status: 'failed', reason: 'вёрстка' }]);
    const hh = mkNamed('hh', [{ status: 'sent' }]);
    const s = new Sender(q, new Map<string, Adapter>([['careerist', careerist], ['hh', hh]]),
      { ...TWO_SOURCES, maxConsecutiveFailures: 3 }, { sleep: async () => {} });

    const rep = await s.run();

    expect(rep.failed).toBe(3);
    expect(rep.sent).toBe(2);
    expect(rep.haltedSources).toEqual([{ source: 'careerist', reason: 'too_many_failures' }]);
  });

  it('halted по-прежнему называет ПЕРВУЮ остановку — прежний контракт отчёта', async () => {
    seed(q, 1, 'careerist');
    seed(q, 1, 'hh');
    const careerist = mkNamed('careerist', [{ status: 'auth_required' }]);
    const hh = mkNamed('hh', [{ status: 'captcha' }]);
    const s = new Sender(q, new Map<string, Adapter>([['careerist', careerist], ['hh', hh]]),
      TWO_SOURCES, { sleep: async () => {} });

    const rep = await s.run();
    expect(rep.halted).toEqual({ source: 'careerist', reason: 'auth_required' });
    expect(rep.haltedSources).toHaveLength(2);
  });

  it('стоп-флаг по-прежнему рвёт ВЕСЬ прогон, а не одну площадку', async () => {
    // Единственная причина, которая обязана останавливать всё: это человек
    // нажал стоп, и «продолжу по другим площадкам» здесь было бы прямым
    // неподчинением.
    seed(q, 2, 'careerist');
    seed(q, 2, 'hh');
    const careerist = mkNamed('careerist', [{ status: 'sent' }]);
    const hh = mkNamed('hh', [{ status: 'sent' }]);
    const s = new Sender(q, new Map<string, Adapter>([['careerist', careerist], ['hh', hh]]),
      TWO_SOURCES, { sleep: async () => {}, stopRequested: () => true });

    const rep = await s.run();
    expect(rep.sent).toBe(0);
    expect(rep.halted).toEqual({ source: '-', reason: 'killed' });
    expect(careerist.calls).toBe(0);
    expect(hh.calls).toBe(0);
  });
});


/**
 * Пустое письмо на одобренной заявке.
 *
 * Найдено на живой очереди 2026-08-31: шесть заявок стояли в approved с
 * письмом длиной ноль — они попали туда, когда генерация падала (пропавший
 * ключ, 429 бесплатной модели), а человек одобрял вакансию, а не текст. Один
 * клик по «Отправить всё» отправил бы шесть голых откликов от его имени.
 */
describe('Sender — пустое письмо не отправляется', () => {
  const CFG = { ...CONFIG, throttle: { hh: { minDelayMs: 0, maxDelayMs: 0 } } };

  function seedWithLetter(letter: string, sourceId: string): void {
    const v = normalizeVacancy({
      source: 'hh', sourceId, title: `вакансия ${sourceId}`, company: 'C',
      url: 'u', description: 'd', geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
    });
    q.insertPending(v, 50, [], letter, 'hybrid');
    const row = q.listByStatus('pending').find((r) => r.vacancy.sourceId === sourceId)!;
    q.approve(row.id, letter);
  }

  it('заявку с пустым письмом не подаёт и оставляет approved', async () => {
    seedWithLetter('', 'пусто-1');
    let applied = 0;
    const adapter: Adapter = {
      name: 'hh',
      async search() { return []; },
      async apply() { applied++; return { status: 'sent' }; },
    };
    const s = new Sender(q, new Map([['hh', adapter]]), CFG, { sleep: async () => {} });

    const rep = await s.run();

    expect(applied).toBe(0);
    expect(rep.sent).toBe(0);
    expect(rep.failed).toBe(0); // не failed: письмо дозаполнится и заявка уйдёт сама
    expect(q.listByStatus('approved')).toHaveLength(1);
    expect(rep.skippedEmptyLetter).toEqual(['вакансия пусто-1']);
  });

  it('письмо из одних пробелов считается пустым', async () => {
    seedWithLetter('   \n\t  ', 'пусто-2');
    let applied = 0;
    const adapter: Adapter = {
      name: 'hh',
      async search() { return []; },
      async apply() { applied++; return { status: 'sent' }; },
    };
    const s = new Sender(q, new Map([['hh', adapter]]), CFG, { sleep: async () => {} });
    await s.run();
    expect(applied).toBe(0);
  });

  it('соседние заявки с письмами уходят нормально', async () => {
    seedWithLetter('', 'пусто-3');
    seedWithLetter('настоящее письмо', 'есть-1');
    const sent: string[] = [];
    const adapter: Adapter = {
      name: 'hh',
      async search() { return []; },
      async apply(v) { sent.push(v.sourceId); return { status: 'sent' }; },
    };
    const s = new Sender(q, new Map([['hh', adapter]]), CFG, { sleep: async () => {} });

    const rep = await s.run();

    expect(sent).toEqual(['есть-1']);
    expect(rep.sent).toBe(1);
    expect(rep.skippedEmptyLetter).toHaveLength(1);
  });
});

describe('Sender — Telegram (спека 2026-09-18, 5.3–5.5)', () => {
  const TG_CONFIG = {
    ...CONFIG,
    throttle: {
      hh: { minDelayMs: 0, maxDelayMs: 0 },
      tg: { maxPerDay: 40, minDelayMs: 0, maxDelayMs: 0 },
    },
  };

  function tgRow(id: string, contact: string, title = `Аналитик ${id}`): number {
    q.insertPending(normalizeVacancy({
      source: 'tg', sourceId: `-1001:${id}`, title, company: '', url: `https://t.me/x/${id}`,
      description: 'd', geo: '', postedAt: '2026-09-19T00:00:00Z', contact, channel: 'Работа в ИТ',
    }), 60, [], 'Здравствуйте! …', 'dm', 'system-analyst');
    const row = q.listByStatus('pending').find((r) => r.sourceId === `-1001:${id}`)!;
    q.approve(row.id);
    return row.id;
  }

  function tgAdapter(result: ApplyResult, calls: Array<{ sourceId: string; ctx: unknown }> = []): Adapter {
    return {
      name: 'tg',
      async search() { return []; },
      async apply(v, _letter, ctx) { calls.push({ sourceId: v.sourceId, ctx }); return result; },
    };
  }

  it('контакту писали за 7 дней — строка остаётся approved, отчёт называет срок', async () => {
    const first = tgRow('1', 'hr_a', 'Первая');
    await new Sender(q, new Map([['tg', tgAdapter({ status: 'sent' })]]), TG_CONFIG, { sleep: async () => {} }).run();
    const sentAt = q.listByStatus('sent').find((r) => r.id === first)!.sentAt!;

    const second = tgRow('2', 'hr_a', 'Вторая');
    const calls: Array<{ sourceId: string; ctx: unknown }> = [];
    const rep = await new Sender(q, new Map([['tg', tgAdapter({ status: 'sent' }, calls)]]), TG_CONFIG, {
      sleep: async () => {}, now: () => sentAt + 60_000,
    }).run();

    expect(calls).toEqual([]);
    expect(q.listByStatus('approved').map((r) => r.id)).toEqual([second]);
    expect(rep.deferredContacts).toEqual([{ contact: 'hr_a', until: sentAt + 7 * 86_400_000, title: 'Вторая' }]);
  });

  it('через 7 дней тому же контакту уже можно', async () => {
    tgRow('1', 'hr_a');
    await new Sender(q, new Map([['tg', tgAdapter({ status: 'sent' })]]), TG_CONFIG, { sleep: async () => {} }).run();
    const sentAt = q.listByStatus('sent')[0]!.sentAt!;
    tgRow('2', 'hr_a');
    const rep = await new Sender(q, new Map([['tg', tgAdapter({ status: 'sent' })]]), TG_CONFIG, {
      sleep: async () => {}, now: () => sentAt + 7 * 86_400_000 + 1,
    }).run();
    expect(rep.sent).toBe(1);
    expect(rep.deferredContacts).toEqual([]);
  });

  it('account_limited останавливает только Telegram, hh продолжает', async () => {
    tgRow('1', 'hr_a');
    seed(q, 1, 'hh');
    const rep = await new Sender(q, new Map([
      ['tg', tgAdapter({ status: 'account_limited' })],
      ['hh', mkAdapter([{ status: 'sent' }])],
    ]), TG_CONFIG, { sleep: async () => {} }).run();
    expect(rep.haltedSources).toContainEqual({ source: 'tg', reason: 'account_limited' });
    expect(rep.sent).toBe(1);
    expect(q.listByStatus('approved').map((r) => r.source)).toEqual(['tg']);
  });

  it('sent с предупреждением — строка sent, предупреждение в отчёте', async () => {
    tgRow('1', 'hr_a', 'Системный аналитик');
    const rep = await new Sender(q, new Map([
      ['tg', tgAdapter({ status: 'sent', warning: 'резюме не приложилось: upload failed' })],
    ]), TG_CONFIG, { sleep: async () => {} }).run();
    expect(q.listByStatus('sent')).toHaveLength(1);
    expect(rep.warnings).toEqual(['Системный аналитик: резюме не приложилось: upload failed']);
  });

  it('apply получает специальность строки', async () => {
    tgRow('1', 'hr_a');
    const calls: Array<{ sourceId: string; ctx: unknown }> = [];
    await new Sender(q, new Map([['tg', tgAdapter({ status: 'sent' }, calls)]]), TG_CONFIG, { sleep: async () => {} }).run();
    expect(calls).toEqual([{ sourceId: '-1001:1', ctx: { specialty: 'system-analyst' } }]);
  });
});
