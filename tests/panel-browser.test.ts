import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser, type Page } from 'playwright';
import { startPanel, type PanelDeps } from '../src/ui/server.js';
import { Queue } from '../src/core/queue.js';
import { normalizeVacancy } from '../src/core/vacancy.js';
import { seedSettings, validateSettings, type Settings } from '../src/core/settings.js';
import { clearStop } from '../src/core/sender.js';
import type { Adapter, ApplyResult } from '../src/adapters/types.js';
import type { Config } from '../src/core/config.js';

/**
 * Кнопки панели, нажатые по-настоящему.
 *
 * Остальные тесты интерфейса стучат в его http-ручки напрямую (ui-server) или
 * исполняют отдельные функции из <script> (panel-html). Ни то, ни другое не
 * ловит поломку в самой проводке страницы — а именно она и была замечена в
 * бою: «кнопка Отправить всё не отправляет». Здесь страница открывается в
 * настоящем Chromium, клик делается мышью, и проверяется то, что видит
 * пользователь: подача действительно случилась.
 *
 * Настоящих подач не происходит: адаптер подставной, в сеть не ходит.
 */

const CONFIG: Config = {
  minScore: 40,
  letterFullThreshold: 75,
  letterModels: ['m:free'],
  searchQueries: [{ query: 'аналитик' }],
  // Нулевые паузы: в бою между подачами стоит 3 секунды, но проверяется здесь
  // не троттлинг, а то, что клик доводит дело до adapter.apply().
  throttle: { hh: { minDelayMs: 0, maxDelayMs: 0 } },
};

function mkSpyAdapter(): Adapter & { applied: string[]; letters: string[]; hold: Promise<void> | null } {
  const applied: string[] = [];
  const letters: string[] = [];
  const spy = {
    name: 'hh',
    applied,
    letters,
    /** Если задан — первая подача ждёт его: так стоп нажимается посреди отправки. */
    hold: null as Promise<void> | null,
    async search() { return []; },
    async apply(vacancy: { sourceId: string }, letter: string): Promise<ApplyResult> {
      applied.push(vacancy.sourceId);
      letters.push(letter);
      if (applied.length === 1 && spy.hold !== null) await spy.hold;
      return { status: 'sent' };
    },
  };
  return spy;
}

let browser: Browser;
let page: Page;
let q: Queue;
let panel: { port: number; close(): Promise<void> };
let adapter: ReturnType<typeof mkSpyAdapter>;
let fillCalls: number;

beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

function seed(sourceId: string, score: number): number {
  q.insertPending(
    normalizeVacancy({
      source: 'hh', sourceId, title: 'Бизнес-аналитик', company: 'Сбер',
      url: `https://hh.ru/vacancy/${sourceId}`, description: 'описание', geo: 'Москва',
      postedAt: '2026-08-20T00:00:00Z',
    }),
    score, ['process-design'], 'письмо', 'full',
  );
  const rows = q.listByStatus('pending');
  return rows[rows.length - 1]!.id;
}

beforeEach(async () => {
  clearStop();
  q = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-pb-')), 'test.db'));
  adapter = mkSpyAdapter();
  fillCalls = 0;
  panel = await startPanel(q, 0, {
    adapters: [adapter],
    config: CONFIG,
    // Подставная генерация: настоящую модель дёргать незачем, проверяется
    // проводка кнопки, а не качество письма.
    fillLetters: async () => {
      fillCalls++;
      let filled = 0;
      for (const row of q.listByStatus('approved')) {
        if (row.letter.trim() === '') { q.setLetter(row.id, 'дописанное письмо', 'full'); filled++; }
      }
      return { found: filled, filled };
    },
  });
  page = await browser.newPage();
});
afterEach(async () => {
  await page.close();
  await panel.close();
  q.close();
});

async function open(hash: string): Promise<void> {
  await page.goto(`http://127.0.0.1:${panel.port}/#${hash}`, { waitUntil: 'domcontentloaded' });
  // Страница рисуется после первого load(); ждём, пока счётчики перестанут
  // быть нулями из разметки.
  await page.waitForFunction(() => document.querySelectorAll('.card').length > 0
    || document.querySelectorAll('.empty').length > 0);
}

describe('панель в браузере — «Отправить всё»', () => {
  it('один клик доводит дело до подачи: adapter.apply вызван, строка стала sent', async () => {
    const id = seed('1', 80);
    q.approve(id, 'письмо');

    await open('approved');
    await page.click('#sendAll');

    await page.waitForFunction(
      () => (document.getElementById('sendHint')?.textContent ?? '').includes('Отправлено'),
      undefined,
      { timeout: 15000 },
    );

    expect(adapter.applied).toEqual(['1']);
    expect(q.listByStatus('sent')).toHaveLength(1);
    expect(q.listByStatus('approved')).toHaveLength(0);
  }, 30000);

  it('второго подтверждения нет — после первого клика кнопка не ждёт ещё одного', async () => {
    // Здесь стояло подтверждение в два клика, и первый клик менял надпись на
    // «Точно отправить N? Нажми ещё раз». Владелец аккаунта его снял: решение
    // принимается на «Принять», и переспрашивать о том же на «Отправить всё»
    // означало выглядеть неработающей кнопкой.
    const id = seed('1', 80);
    q.approve(id, 'письмо');

    await open('approved');
    await page.click('#sendAll');
    await page.waitForFunction(
      () => (document.getElementById('sendHint')?.textContent ?? '').includes('Отправлено'),
      undefined,
      { timeout: 15000 },
    );

    // Ровно одна подача с одного клика.
    expect(adapter.applied).toHaveLength(1);
    const label = await page.textContent('#sendAll');
    expect(label).not.toMatch(/ещё раз/i);
  }, 30000);

  it('отправляет все одобренные строки, а не только первую', async () => {
    for (const sid of ['1', '2', '3']) q.approve(seed(sid, 80), 'письмо');

    await open('approved');
    await page.click('#sendAll');
    await page.waitForFunction(
      () => (document.getElementById('sendHint')?.textContent ?? '').includes('Отправлено'),
      undefined,
      { timeout: 15000 },
    );

    expect(adapter.applied.sort()).toEqual(['1', '2', '3']);
    expect(q.listByStatus('sent')).toHaveLength(3);
  }, 30000);
});

describe('панель в браузере — «Одобрить всё»', () => {
  it('одобряет ВСЁ, что лежит в ожидании, а не только со скором ≥ 75', async () => {
    // Порог был на кнопке, и вакансии со скором ниже он молча оставлял в
    // очереди — при том что очередь уже прошла minScore, core-гейт и три
    // жёстких фильтра на этапе поиска.
    seed('1', 90);
    seed('2', 50);
    seed('3', 41);

    await open('pending');
    await page.click('#approveAll');
    await page.waitForFunction(() => document.querySelectorAll('#list .card').length === 0,
      undefined, { timeout: 15000 });

    expect(q.listByStatus('approved')).toHaveLength(3);
    expect(q.listByStatus('pending')).toHaveLength(0);
  }, 30000);

  it('подхватывает правку письма из textarea, а не письмо из последней загрузки', async () => {
    seed('1', 50);

    await open('pending');
    await page.fill('#list .card textarea', 'правка руками');
    await page.click('#approveAll');
    await page.waitForFunction(() => document.querySelectorAll('#list .card').length === 0,
      undefined, { timeout: 15000 });

    expect(q.listByStatus('approved')[0]!.letter).toBe('правка руками');
  }, 30000);

  it('надпись на кнопке не обещает порога', async () => {
    await open('pending');
    const label = await page.textContent('#approveAll');
    expect(label?.trim()).toBe('Одобрить всё');
  }, 30000);
});


describe('панель в браузере — пустое письмо у одобренной заявки', () => {
  it('карточку видно как проблемную, и в неё МОЖНО вписать письмо руками', async () => {
    // Раньше здесь была только красная надпись, отсылавшая к кнопке, которой
    // не существовало, а вписать текст было некуда вообще.
    const id = seed('1', 80);
    q.approve(id, '');

    await open('approved');
    const warn = await page.textContent('#approvedList .letter-preview');
    expect(warn).toMatch(/ПИСЬМА НЕТ/);

    await page.fill('#approvedList .letter-edit', 'написал руками');
    await page.click('#approvedList [data-act="save"]');
    await page.waitForFunction(
      () => !/ПИСЬМА НЕТ/.test(document.querySelector('#approvedList .letter-preview')?.textContent ?? ''),
      undefined, { timeout: 15000 },
    );

    expect(q.listByStatus('approved')[0]!.letter).toBe('написал руками');
  }, 30000);

  it('вписанное руками письмо помечается режимом manual, а не выдаётся за сгенерированное', async () => {
    const id = seed('1', 80);
    q.approve(id, '');
    await open('approved');
    await page.fill('#approvedList .letter-edit', 'мой текст');
    await page.click('#approvedList [data-act="save"]');
    await page.waitForFunction(
      () => !/ПИСЬМА НЕТ/.test(document.querySelector('#approvedList .letter-preview')?.textContent ?? ''),
      undefined, { timeout: 15000 },
    );
    expect(q.listByStatus('approved')[0]!.letterMode).toBe('manual');
  }, 30000);

  it('у заявки С письмом поля для правки нет — одобренный текст не подменяют', async () => {
    const id = seed('1', 80);
    q.approve(id, 'письмо, которое человек утвердил');
    await open('approved');
    const visible = await page.isVisible('#approvedList .letter-edit');
    expect(visible).toBe(false);
  }, 30000);

  it('кнопка «Дописать письма» существует и действительно запускает генерацию', async () => {
    // Кнопка была обещана в тексте предупреждения и при этом отсутствовала.
    const id = seed('1', 80);
    q.approve(id, '');

    await open('approved');
    await page.click('#fillLetters');
    await page.waitForFunction(
      () => !/ПИСЬМА НЕТ/.test(document.querySelector('#approvedList .letter-preview')?.textContent ?? ''),
      undefined, { timeout: 20000 },
    );

    expect(fillCalls).toBe(1);
    expect(q.listByStatus('approved')[0]!.letter).toBe('дописанное письмо');
  }, 40000);

  it('кнопка есть и на вкладке «В ожидании»', async () => {
    seed('1', 80);
    await open('pending');
    expect(await page.isVisible('#fillLettersPending')).toBe(true);
  }, 30000);
});


describe('панель в браузере — уведомление про VPN', () => {
  /**
   * Панель поднимается своя, с подставленным ответом «где прокси»: настоящий
   * VPN трогать нельзя, а настоящий поиск лезет в netstat и реестр.
   */
  async function withPanel(proxyStatus: NonNullable<PanelDeps['proxyStatus']>, fn: (port: number) => Promise<void>) {
    const q2 = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-vpn-')), 'test.db'));
    const p2 = await startPanel(q2, 0, { proxyStatus });
    try {
      await fn(p2.port);
    } finally {
      await p2.close();
      q2.close();
    }
  }

  it('VPN выключен — на странице висит «требуется включить VPN»', async () => {
    await withPanel(async () => ({ found: null, checked: ['127.0.0.1:10809', '127.0.0.1:10801'] }), async (port) => {
      await page.goto(`http://127.0.0.1:${port}/#pending`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => {
          const w = document.getElementById('proxyWarn');
          return w !== null && w.style.display !== 'none' && /включить VPN/.test(w.textContent ?? '');
        },
        undefined, { timeout: 20000 },
      );
      const txt = await page.textContent('#proxyWarn');
      // Обязана сказать и то, что НЕ ломается: паника на ровном месте хуже
      // молчания, а поиск и отправка без прокси работают.
      expect(txt).toMatch(/письма/i);
      expect(txt).toMatch(/поиск/i);
      // Прокси ищется на каждое письмо, перезапуск не нужен. Раньше полоса
      // гнала перезапускать панель — теперь это был бы лишний шаг.
      expect(txt).not.toMatch(/Ctrl\+C|Панель\.cmd/);
    });
  }, 40000);

  it('прокси на месте — полосы нет', async () => {
    await withPanel(async () => ({
      found: { host: '127.0.0.1', port: 10809, source: 'windows' }, checked: ['127.0.0.1:10809'],
    }), async (port) => {
      await page.goto(`http://127.0.0.1:${port}/#pending`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      expect(await page.isVisible('#proxyWarn')).toBe(false);
    });
  }, 40000);
});

describe('вкладка «Настройки» в настоящем браузере', () => {
  let stored: Settings;
  let sp: { port: number; close(): Promise<void> };

  beforeEach(async () => {
    stored = seedSettings(undefined, null);
    sp = await startPanel(q, 0, {
      settings: {
        get: () => stored,
        save: async (raw) => { const r = validateSettings(raw); if (r.ok) stored = r.settings; return r; },
        suggest: async () => ({
          ok: true,
          suggestion: { titleWords: ['менеджер продукта'], skills: [{ name: 'Роадмап', synonyms: ['роадмап'], weight: 25, core: true }] },
        }),
      },
    });
  });
  afterEach(async () => { await sp.close(); });

  it('правка веса навыка сохраняется', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    const weight = page.locator('.spec').first().locator('.skill').first().locator('[data-k="weight"]');
    await weight.fill('30');
    await page.click('#settingsSave');
    await expect.poll(() => stored.specialties[0]!.skills[0]!.weight).toBe(30);
    await expect.poll(() => page.textContent('#settingsNote')).toMatch(/Сохранено/);
  });

  it('стоп-слово добавляется через поле списка', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await page.fill('#stopWords', '1С\nБитрикс\nBitrix\nвахта');
    await page.click('#settingsSave');
    await expect.poll(() => stored.stopWords).toEqual(['1С', 'Битрикс', 'Bitrix', 'вахта']);
  });

  it('новая специальность: «Предложить» заполняет, сохранение с названием', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await page.click('#addSpec');
    const card = page.locator('.spec').last();
    await card.locator('[data-f="name"]').fill('Менеджер продукта');
    await card.locator('.suggest').click();
    await expect.poll(() => card.locator('.skill [data-k="name"]').first().inputValue()).toBe('Роадмап');
    await page.click('#settingsSave');
    await expect.poll(() => stored.specialties.map((s) => s.name)).toContain('Менеджер продукта');
    expect(stored.specialties.at(-1)!.legacyLetters).toBe(false);
  });

  it('ошибка проверки показывается человеку, а не глотается', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await page.locator('.spec').first().locator('[data-f="name"]').fill('');
    await page.click('#settingsSave');
    await expect.poll(() => page.textContent('#settingsNote')).toMatch(/название/);
  });
});

describe('Telegram во вкладке «Настройки»', () => {
  const CHATS = [
    { id: '-1001', title: 'Работа в ИТ', username: 'workayte', kind: 'channel' as const },
    { id: '-1002', title: 'Закрытый чат аналитиков', username: null, kind: 'group' as const },
  ];
  let stored: Settings;
  let tp: { port: number; close(): Promise<void> };

  beforeEach(async () => {
    stored = seedSettings(undefined, null);
    stored.autoApply = { enabled: true, minScore: 60 };
    tp = await startPanel(q, 0, {
      settings: {
        get: () => stored,
        save: async (raw) => { const r = validateSettings(raw); if (r.ok) stored = r.settings; return r; },
        suggest: async () => ({ ok: false, error: 'не нужен' }),
      },
      telegram: {
        dialogs: async () => ({ ok: true, chats: CHATS }),
        resolve: async (ref) => (ref === '@нет' ? { ok: false, error: 'канал не найден' } : { ok: true, chat: CHATS[0]! }),
      },
    });
  });
  afterEach(async () => { await tp.close(); });

  it('«Выбрать из моих чатов» добавляет отмеченное, сохранение кладёт чаты в настройки', async () => {
    await page.goto(`http://127.0.0.1:${tp.port}/#settings`);
    await page.click('#tgPick');
    await page.locator('#tgPicker input[data-i="1"]').check();
    await page.click('#tgPickAdd');
    await page.fill('#tgDays', '7');
    await page.click('#settingsSave');
    await expect.poll(() => stored.telegram.chats.map((c) => c.id)).toEqual(['-1002']);
    expect(stored.telegram.firstReadDays).toBe(7);
  });

  it('ошибка «Добавить» показывается человеку', async () => {
    await page.goto(`http://127.0.0.1:${tp.port}/#settings`);
    await page.fill('#tgRef', '@нет');
    await page.click('#tgAdd');
    await expect.poll(() => page.textContent('#tgNote')).toMatch(/канал не найден/);
  });

  it('включение автоотклика — только через подтверждение; отказ оставляет выключенным', async () => {
    stored.autoApply = { enabled: false, minScore: null };
    await page.goto(`http://127.0.0.1:${tp.port}/#settings`);
    expect(await page.locator('#autoBanner').isHidden()).toBe(true);

    page.once('dialog', (d) => { void d.dismiss(); });
    await page.locator('#autoApply').click();
    await expect.poll(() => page.locator('#autoApply').isChecked()).toBe(false);

    page.once('dialog', (d) => {
      expect(d.message()).toMatch(/без твоего просмотра/);
      void d.accept();
    });
    await page.locator('#autoApply').click();
    await page.fill('#autoMinScore', '55');
    await page.click('#settingsSave');
    await expect.poll(() => stored.autoApply).toEqual({ enabled: true, minScore: 55 });
    await expect.poll(() => page.locator('#autoBanner').isVisible()).toBe(true);
  });

  it('вкладка «Отправлено» помечает отправленное автооткликом', async () => {
    q.insertPending(normalizeVacancy({
      source: 'tg', sourceId: '-1001:9', title: 'Системный аналитик', company: '', url: 'https://t.me/x/9',
      description: 'd', geo: '', postedAt: '2026-09-19T00:00:00Z', contact: 'hr_a',
    }), 70, [], 'Здравствуйте!', 'dm');
    const row = q.listByStatus('pending').find((r) => r.sourceId === '-1001:9')!;
    q.approve(row.id, undefined, 'auto');
    q.markSent(row.id);

    await page.goto(`http://127.0.0.1:${tp.port}/#sent`);
    await expect.poll(() => page.locator('#sentList .card').count()).toBe(1);
    expect(await page.locator('#sentList .card .meta').innerText()).toMatch(/АВТО.*@hr_a/);
  });

  it('сохранение специальностей не трогает автоотклик', async () => {
    await page.goto(`http://127.0.0.1:${tp.port}/#settings`);
    await page.locator('.spec').first().locator('.skill').first().locator('[data-k="weight"]').fill('29');
    await page.click('#settingsSave');
    await expect.poll(() => stored.specialties[0]!.skills[0]!.weight).toBe(29);
    expect(stored.autoApply).toEqual({ enabled: true, minScore: 60 });
  });
});


describe('панель в браузере — отправка без письма', () => {
  const sendDone = (): Promise<unknown> => page.waitForFunction(
    () => (document.getElementById('sendHint')?.textContent ?? '').includes('Отправлено'),
    undefined, { timeout: 15000 },
  );

  /** Подтверждение ловится слушателем: без него Playwright молча отвечает «Отмена». */
  function onDialog(answer: 'accept' | 'dismiss'): { messages: string[] } {
    const seen = { messages: [] as string[] };
    page.once('dialog', (d) => {
      seen.messages.push(d.message());
      void (answer === 'accept' ? d.accept() : d.dismiss());
    });
    return seen;
  }

  it('есть заявка без письма — перед отправкой предупреждение, и «Отмена» не отправляет ничего', async () => {
    q.approve(seed('1', 80), '');

    await open('approved');
    const dlg = onDialog('dismiss');
    await page.click('#sendAll');
    await expect.poll(() => dlg.messages.length).toBe(1);

    expect(dlg.messages[0]).toMatch(/БЕЗ сопроводительного письма/);
    expect(dlg.messages[0]).toMatch(/У 1 из 1/);
    // Ждём, чтобы убедиться: после отмены отправка не стартует задним числом.
    await page.waitForTimeout(800);
    expect(adapter.applied).toEqual([]);
    expect(q.listByStatus('approved')).toHaveLength(1);
    expect(await page.isDisabled('#sendAll')).toBe(false);
    expect(await page.isVisible('#sendStop')).toBe(false);
  }, 30000);

  it('«ОК» отправляет без письма: apply получил пустое письмо, в итоге названо «БЕЗ ПИСЬМА»', async () => {
    q.approve(seed('1', 80), '');

    await open('approved');
    onDialog('accept');
    await page.click('#sendAll');
    await sendDone();

    expect(adapter.applied).toEqual(['1']);
    expect(adapter.letters).toEqual(['']);
    expect(q.listByStatus('sent')).toHaveLength(1);
    expect(await page.textContent('#sendHint')).toMatch(/Отправлено 1, из них БЕЗ ПИСЬМА 1/);
  }, 30000);

  it('часть заявок с письмом, часть без: в предупреждении считаются только пустые, уходят все', async () => {
    q.approve(seed('1', 80), 'настоящее письмо');
    q.approve(seed('2', 70), '');
    q.approve(seed('3', 60), '   ');

    await open('approved');
    const dlg = onDialog('accept');
    await page.click('#sendAll');
    await sendDone();

    expect(dlg.messages[0]).toMatch(/У 2 из 3/);
    expect(adapter.applied.sort()).toEqual(['1', '2', '3']);
    expect([...adapter.letters].sort()).toEqual(['', '', 'настоящее письмо'].sort());
    expect(await page.textContent('#sendHint')).toMatch(/Отправлено 3, из них БЕЗ ПИСЬМА 2/);
  }, 30000);

  it('у всех заявок есть письма — никакого предупреждения, отправка как раньше', async () => {
    q.approve(seed('1', 80), 'письмо');

    await open('approved');
    let asked = 0;
    page.on('dialog', (d) => { asked++; void d.dismiss(); });
    await page.click('#sendAll');
    await sendDone();

    expect(asked).toBe(0);
    expect(adapter.letters).toEqual(['письмо']);
    expect(await page.textContent('#sendHint')).not.toMatch(/БЕЗ ПИСЬМА/);
  }, 30000);

  it('Telegram без текста: предупреждение говорит, что такие не уйдут вовсе', async () => {
    q.approve(seed('1', 80), '');
    q.insertPending(normalizeVacancy({
      source: 'tg', sourceId: '-1001:5', title: 'Аналитик', company: '', url: 'https://t.me/x/5',
      description: 'd', geo: '', postedAt: '2026-09-19T00:00:00Z', contact: 'hr_x',
    }), 70, [], '', 'none');
    const tgRow = q.listByStatus('pending').find((r) => r.sourceId === '-1001:5')!;
    q.approve(tgRow.id, '');

    await open('approved');
    const dlg = onDialog('dismiss');
    await page.click('#sendAll');
    await expect.poll(() => dlg.messages.length).toBe(1);

    expect(dlg.messages[0]).toMatch(/У 1 из 2/);
    expect(dlg.messages[0]).toMatch(/Telegram/);
    expect(adapter.applied).toEqual([]);
  }, 30000);

  it('карточка без письма больше не обещает «не отправится» — говорит, как оно уйдёт', async () => {
    q.approve(seed('1', 80), '');
    await open('approved');
    const txt = await page.textContent('#approvedList .letter-preview');
    expect(txt).toMatch(/ПИСЬМА НЕТ/);
    expect(txt).not.toMatch(/не отправится/);
    expect(txt).toMatch(/без письма/i);
    // Тот же обман жил в подсказке поля ввода.
    expect(await page.getAttribute('#approvedList .letter-edit', 'placeholder')).not.toMatch(/не отправится/);
  }, 30000);
});

describe('панель в браузере — кнопки «Остановить»', () => {
  const STOP_BUTTONS = ['#searchStop', '#sendStop', '#stopLetters', '#stopLettersPending'];

  async function withPanel(deps: PanelDeps, fn: (port: number, queue: Queue) => Promise<void>): Promise<void> {
    const q2 = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-stop-')), 'test.db'));
    const p2 = await startPanel(q2, 0, deps);
    try { await fn(p2.port, q2); } finally { await p2.close(); q2.close(); }
  }
  const waitAbort = (signal: AbortSignal): Promise<void> => new Promise((r) => {
    if (signal.aborted) r();
    else signal.addEventListener('abort', () => r());
  });

  it('пока ничего не идёт, ни одной кнопки «Остановить» не видно', async () => {
    await open('pending');
    for (const sel of STOP_BUTTONS) expect(await page.locator(sel).isVisible(), sel).toBe(false);
    await open('approved');
    for (const sel of STOP_BUTTONS) expect(await page.locator(sel).isVisible(), sel).toBe(false);
  }, 30000);

  it('поиск: «Остановить поиск» появляется, нажатие останавливает, итог называет остановку, поиск можно запустить снова', async () => {
    let seen: AbortSignal | undefined;
    await withPanel({
      startSearch: async (_limit, signal) => {
        seen = signal;
        await waitAbort(signal);
        return { report: { found: 12, queued: 3, stoppedBecause: 'stopped' }, emptyLetters: 0 };
      },
    }, async (port) => {
      await page.goto(`http://127.0.0.1:${port}/#pending`);
      await page.click('#searchStart');
      await page.locator('#searchStop').waitFor({ state: 'visible', timeout: 10000 });
      expect(await page.isDisabled('#searchStart')).toBe(true);

      await page.click('#searchStop');
      expect(await page.textContent('#searchStop')).toMatch(/Останавливаю/);
      expect(await page.isDisabled('#searchStop')).toBe(true);
      await expect.poll(() => seen?.aborted).toBe(true);

      await page.waitForFunction(
        () => (document.getElementById('searchNote')?.textContent ?? '').includes('ПОИСК ОСТАНОВЛЕН'),
        undefined, { timeout: 15000 },
      );
      const note = await page.textContent('#searchNote');
      expect(note).toMatch(/просмотрено 12/);
      expect(note).toMatch(/в очередь 3/);
      expect(await page.isVisible('#searchStop')).toBe(false);
      expect(await page.isDisabled('#searchStart')).toBe(false);
    });
  }, 40000);

  it('письма: стоп есть на обеих вкладках, нажатие останавливает, итог называет остановку', async () => {
    let seen: AbortSignal | undefined;
    await withPanel({
      fillLetters: async (signal) => {
        seen = signal;
        await waitAbort(signal);
        return { found: 4, filled: 1, stopped: true as const };
      },
    }, async (port, queue) => {
      // «Дописать письма» живая только когда есть что дописывать — кладём заявку без письма.
      queue.insertPending(normalizeVacancy({
        source: 'hh', sourceId: 'L1', title: 'Бизнес-аналитик', company: 'C', url: 'https://hh.ru/vacancy/L1',
        description: 'd', geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
      }), 70, [], '', 'none');
      queue.approve(queue.listByStatus('pending')[0]!.id, '');

      await page.goto(`http://127.0.0.1:${port}/#approved`);
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('#fillLetters')?.disabled === false);
      await page.click('#fillLetters');

      await page.locator('#stopLetters').waitFor({ state: 'visible', timeout: 10000 });
      // На соседней вкладке та же кнопка тоже появилась.
      await page.click('#tab-pending');
      expect(await page.locator('#stopLettersPending').isVisible()).toBe(true);

      await page.click('#stopLettersPending');
      await expect.poll(() => seen?.aborted).toBe(true);
      await page.waitForFunction(
        () => (document.getElementById('lettersHint')?.textContent ?? '').includes('Остановлено'),
        undefined, { timeout: 15000 },
      );
      expect(await page.textContent('#lettersHint')).toMatch(/заполнено 1 из 4/);
      expect(await page.isVisible('#stopLettersPending')).toBe(false);
      await page.click('#tab-approved');
      expect(await page.isVisible('#stopLetters')).toBe(false);
    });
  }, 40000);

  it('отправка: «Остановить отправку» появляется со стартом; стоп — текущая подача доезжает, остальные остаются одобренными', async () => {
    for (const [sid, score] of [['1', 90], ['2', 80], ['3', 70]] as const) q.approve(seed(sid, score), 'письмо');
    let release!: () => void;
    adapter.hold = new Promise<void>((r) => { release = r; });

    await open('approved');
    await page.click('#sendAll');
    await page.locator('#sendStop').waitFor({ state: 'visible', timeout: 10000 });
    await expect.poll(() => adapter.applied.length).toBe(1);

    await page.click('#sendStop');
    expect(await page.textContent('#sendStop')).toMatch(/Останавливаю/);
    expect(await page.isDisabled('#sendStop')).toBe(true);

    release();
    await page.waitForFunction(
      () => (document.getElementById('sendHint')?.textContent ?? '').includes('Отправлено'),
      undefined, { timeout: 15000 },
    );
    const hint = await page.textContent('#sendHint');
    expect(hint).toMatch(/Отправлено 1/);
    expect(hint).toMatch(/остановлено вручную/);

    expect(adapter.applied).toEqual(['1']);
    expect(q.listByStatus('sent')).toHaveLength(1);
    expect(q.listByStatus('approved')).toHaveLength(2);
    expect(await page.isVisible('#sendStop')).toBe(false);
    expect(await page.isDisabled('#sendAll')).toBe(false);
  }, 40000);

  it('страница, открытая посреди отправки, сразу показывает «Остановить отправку»', async () => {
    for (const sid of ['1', '2']) q.approve(seed(sid, 80), 'письмо');
    let release!: () => void;
    adapter.hold = new Promise<void>((r) => { release = r; });

    await open('approved');
    await page.click('#sendAll');
    await expect.poll(() => adapter.applied.length).toBe(1);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#sendStop').waitFor({ state: 'visible', timeout: 10000 });
    release();
    await page.waitForFunction(
      () => (document.getElementById('sendHint')?.textContent ?? '').includes('Отправлено'),
      undefined, { timeout: 15000 },
    );
  }, 40000);
});
