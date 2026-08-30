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
  panel = await startPanel(q, 0, { adapters: [adapter], config: CONFIG });
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
