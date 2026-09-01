import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser, type Page } from 'playwright';
import { startPanel } from '../src/ui/server.js';
import { Queue } from '../src/core/queue.js';
import { normalizeVacancy } from '../src/core/vacancy.js';
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

function mkSpyAdapter(): Adapter & { applied: string[] } {
  const applied: string[] = [];
  return {
    name: 'hh',
    applied,
    async search() { return []; },
    async apply(vacancy): Promise<ApplyResult> {
      applied.push(vacancy.sourceId);
      return { status: 'sent' };
    },
  };
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
   * Панель поднимается своя, с подменённым окружением: настоящий VPN трогать
   * нельзя, а проверка ходит в TCP-порт по адресу из HTTP_PROXY.
   */
  async function withPanel(env: Record<string, string | undefined>, fn: (port: number) => Promise<void>) {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) { saved[k] = process.env[k]; }
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    const q2 = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-vpn-')), 'test.db'));
    const p2 = await startPanel(q2, 0);
    try {
      await fn(p2.port);
    } finally {
      await p2.close();
      q2.close();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }

  it('VPN выключен — на странице висит «требуется включить VPN»', async () => {
    // Адрес прокси задан, читать его разрешено, но на том конце никого:
    // ровно то, что видно, когда клиент выключили, не трогая настроек.
    await withPanel(
      { HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: undefined, NODE_USE_ENV_PROXY: '1' },
      async (port) => {
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
      },
    );
  }, 40000);

  it('прокси на месте — полосы нет', async () => {
    const net = await import('node:net');
    const srv = net.createServer();
    const port = await new Promise<number>((r) => srv.listen(0, '127.0.0.1',
      () => r((srv.address() as { port: number }).port)));
    try {
      await withPanel(
        { HTTPS_PROXY: `http://127.0.0.1:${port}`, HTTP_PROXY: undefined, NODE_USE_ENV_PROXY: '1' },
        async (panelPort) => {
          await page.goto(`http://127.0.0.1:${panelPort}/#pending`, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(2500);
          expect(await page.isVisible('#proxyWarn')).toBe(false);
        },
      );
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }, 40000);

  it('адрес прокси не задан — говорит про лаунчер, а не про VPN', async () => {
    await withPanel(
      { HTTPS_PROXY: undefined, HTTP_PROXY: undefined, https_proxy: undefined,
        http_proxy: undefined, NODE_USE_ENV_PROXY: '1' },
      async (port) => {
        await page.goto(`http://127.0.0.1:${port}/#pending`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
          () => {
            const w = document.getElementById('proxyWarn');
            return w !== null && w.style.display !== 'none' && (w.textContent ?? '') !== '';
          },
          undefined, { timeout: 20000 },
        );
        expect(await page.textContent('#proxyWarn')).toMatch(/Панель\.cmd/);
      },
    );
  }, 40000);
});
