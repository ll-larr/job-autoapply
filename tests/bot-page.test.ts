import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { readVacancyPage } from '../src/bot/page.js';

/**
 * Страница отдаётся локальным сервером, браузер настоящий: проверяется ровно
 * то, ради чего модуль появился — текст вакансии берётся из разметки, а шапка
 * сайта вакансией не считается.
 */

const DESCRIPTION = [
  'Обязанности: собирать требования, описывать процессы в BPMN, ставить задачи разработке',
  'и сопровождать интеграции между системами.',
  'Требования: опыт работы от двух лет, SQL, понимание REST и очередей.',
  'Условия: офис или удалённо, оформление по ТК, обсуждаемая зарплата.',
].join(' ');

function serve(html: string): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}/vacancy/1`,
        close: () => new Promise<void>((done) => { server.close(() => done()); }),
      });
    });
  });
}

let shared: Browser | null = null;
const launch = async (): Promise<Browser> => {
  // Тесты поднимают один браузер на файл: launch занимает секунды, а проверять
  // надо разбор разметки, не скорость старта Chromium.
  shared ??= await chromium.launch({ headless: true });
  // page.ts закрывает то, что ему дали, поэтому отдаём его же, но закрытие
  // перехватываем: браузер нужен следующему тесту.
  return { ...shared, close: async () => undefined, newPage: () => shared!.newPage() } as unknown as Browser;
};

describe('readVacancyPage', () => {
  it('берёт заголовок и описание вакансии из разметки hh', async () => {
    const page = await serve(`<!doctype html><html><body>
      <div data-qa="vacancy-title">Бизнес-аналитик</div>
      <div data-qa="vacancy-description">${DESCRIPTION}</div>
    </body></html>`);
    const text = await readVacancyPage(page.url, launch);
    await page.close();
    expect(text).toContain('Бизнес-аналитик');
    expect(text).toContain('BPMN');
    expect(text!.length).toBeGreaterThan(200);
  }, 60_000);

  it('шапка сайта без описания — null, а не мусор для модели', async () => {
    // Ровно то, что hh отдал голому fetch 2026-09-20.
    const page = await serve('<!doctype html><html><body>Сервисы Помощь Ещё Поиск Войти</body></html>');
    const text = await readVacancyPage(page.url, launch);
    await page.close();
    expect(text).toBeNull();
  }, 60_000);

  it('страница не открылась — null, без исключения наружу', async () => {
    const text = await readVacancyPage('http://127.0.0.1:1/нет-такой', launch);
    expect(text).toBeNull();
  }, 60_000);

  it('закрывает браузер, даже когда страница упала', async () => {
    let closed = 0;
    const counting = async (): Promise<Browser> => {
      const real = await launch();
      return { ...real, close: async () => { closed += 1; } } as unknown as Browser;
    };
    await readVacancyPage('http://127.0.0.1:1/нет-такой', counting);
    expect(closed).toBe(1);
  }, 60_000);
});
