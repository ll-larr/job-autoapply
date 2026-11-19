import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Route } from 'playwright';
import { HhAdapter, waitCaptchaSolved } from '../src/adapters/hh.js';
import {
  DEFAULT_SEARCH_PACING, NO_PACING, pickDelay, resolveSearchPacing, sleepUnlessAborted,
} from '../src/core/pacing.js';

const searchHtml = readFileSync('tests/fixtures/hh-search.html', 'utf8');
const vacancyHtml = readFileSync('tests/fixtures/hh-vacancy.html', 'utf8');

const CAPTCHA_PAGE = '<html><body><div role="dialog" id="cap"><h2>Complete the CAPTCHA</h2>'
  + '<img src="/account/captcha/image?x=1"><input placeholder="Text from the picture"></div></body></html>';
/** Капча, которую «человек решает» через 200 мс: окно само пропадает. */
const CAPTCHA_SELF_SOLVING = CAPTCHA_PAGE.replace(
  '</body>',
  '<script>setTimeout(() => document.getElementById("cap").remove(), 200)</script></body>',
);

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

const isDocument = (route: Route): boolean => route.request().resourceType() === 'document';
const html = (route: Route, body: string): Promise<void> =>
  route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });

/** Выдача — фикстура; страница вакансии — что вернёт vacancyBody(номер запроса). */
async function hhContext(vacancyBody: (n: number) => string): Promise<{ context: BrowserContext; detail: string[] }> {
  const context = await browser.newContext();
  const detail: string[] = [];
  await context.route('**/*', (route) => {
    if (!isDocument(route)) return route.abort();
    const url = route.request().url();
    if (url.includes('/search/vacancy')) return html(route, searchHtml);
    if (url.includes('/vacancy/')) {
      detail.push(url);
      return html(route, vacancyBody(detail.length));
    }
    return route.abort();
  });
  return { context, detail };
}

describe('core/pacing', () => {
  it('pickDelay берёт значение из диапазона включительно', () => {
    expect(pickDelay([100, 200], () => 0)).toBe(100);
    expect(pickDelay([100, 200], () => 0.9999999)).toBe(200);
    expect(pickDelay([0, 0], Math.random)).toBe(0);
  });

  it('resolveSearchPacing: умолчания, частичная замена, ошибки', () => {
    expect(resolveSearchPacing(undefined)).toEqual(DEFAULT_SEARCH_PACING);
    const p = resolveSearchPacing({ vacancyDelayMs: [1, 2], breakEvery: 0 });
    expect(p.vacancyDelayMs).toEqual([1, 2]);
    expect(p.breakEvery).toBe(0);
    expect(p.pageDelayMs).toEqual(DEFAULT_SEARCH_PACING.pageDelayMs);
    expect(() => resolveSearchPacing({ vacancyDelayMs: [5, 1] })).toThrow(/vacancyDelayMs/);
    expect(() => resolveSearchPacing({ captchaWaitMs: -1 })).toThrow(/captchaWaitMs/);
    expect(() => resolveSearchPacing([1, 2])).toThrow(/объектом/);
  });

  it('sleepUnlessAborted просыпается по сигналу остановки', async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 50);
    await sleepUnlessAborted(10_000, ac.signal);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('waitCaptchaSolved', () => {
  it('true, когда окно капчи пропало', async () => {
    const context = await browser.newContext();
    await context.route('**/*', (r) => r.abort());
    const page = await context.newPage();
    await page.setContent(CAPTCHA_SELF_SOLVING);
    expect(await waitCaptchaSolved(page, 5_000, () => false, 50)).toBe(true);
    await context.close();
  });

  it('false по таймауту и по стопу', async () => {
    const context = await browser.newContext();
    await context.route('**/*', (r) => r.abort());
    const page = await context.newPage();
    await page.setContent(CAPTCHA_PAGE);
    expect(await waitCaptchaSolved(page, 300, () => false, 50)).toBe(false);
    expect(await waitCaptchaSolved(page, 5_000, () => true, 50)).toBe(false);
    await context.close();
  });
});

describe('HhAdapter.search — капча и пустые описания', () => {
  it('капча без ожидания: поиск останавливается, вкладка остаётся открытой', async () => {
    const { context, detail } = await hhContext(() => CAPTCHA_PAGE);
    const adapter = new HhAdapter({ context, pacing: NO_PACING });
    const out = await adapter.search({ query: 'бизнес-аналитик', maxResults: 10 });
    expect(out).toEqual([]);
    expect(detail.length).toBe(1);
    expect(adapter.lastSearchStats?.captchaStopped).toBe(true);
    expect(context.pages().length).toBe(1);
    await context.close();
  }, 30_000);

  it('капчу решили — страница открывается заново, и поиск идёт дальше', async () => {
    const { context, detail } = await hhContext((n) => (n === 1 ? CAPTCHA_SELF_SOLVING : vacancyHtml));
    const adapter = new HhAdapter({ context, pacing: { ...NO_PACING, captchaWaitMs: 20_000 } });
    const out = await adapter.search({ query: 'бизнес-аналитик', maxResults: 10 });
    expect(adapter.lastSearchStats?.captchaStopped).toBe(false);
    expect(out.length).toBeGreaterThan(0);
    // Первая вакансия открыта дважды: с капчей и после неё.
    expect(detail.length).toBe(out.length + 1);
    expect(detail[0]).toBe(detail[1]);
    for (const v of out) expect(v.description.length).toBeGreaterThan(50);
    await context.close();
  }, 30_000);

  it('заголовок без «Слов заголовка» отсеивается до открытия страницы вакансии', async () => {
    const { context, detail } = await hhContext(() => vacancyHtml);
    const adapter = new HhAdapter({ context, pacing: NO_PACING });
    const out = await adapter.search({ query: 'бизнес-аналитик', maxResults: 20, titleWords: ['водолаз-кессонщик'] });
    expect(out).toEqual([]);
    expect(detail.length).toBe(0);
    expect(adapter.lastSearchStats?.rejectedTitle).toBeGreaterThan(0);

    // С подходящим словом страницы открываются, как раньше.
    const ok = await adapter.search({ query: 'бизнес-аналитик', maxResults: 20, titleWords: ['аналитик'] });
    expect(ok.length).toBeGreaterThan(0);
    for (const v of ok) expect(v.title.toLowerCase()).toContain('аналитик');
    await context.close();
  }, 30_000);

  it('страница без описания не уходит дальше с пустым текстом, а считается отдельно', async () => {
    const { context } = await hhContext(() => '<html><body><h1>Вакансия</h1></body></html>');
    const adapter = new HhAdapter({ context, pacing: NO_PACING, timeouts: { descriptionMs: 200 } });
    const out = await adapter.search({ query: 'бизнес-аналитик', maxResults: 10 });
    expect(out).toEqual([]);
    expect(adapter.lastSearchStats?.noDescription).toBeGreaterThan(0);
    expect(adapter.lastSearchStats?.captchaStopped).toBe(false);
    await context.close();
  }, 30_000);
});
