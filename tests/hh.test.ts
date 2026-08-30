import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { normalizeVacancy } from '../src/core/vacancy.js';
import {
  parseSearchPage,
  classifyApplyOutcome,
  buildSearchUrl,
  extractVacancyId,
  canonicalVacancyUrl,
  parseSalaryText,
  detectSubmitSuccess,
  detectCaptcha,
  detectAlreadyApplied,
  findNegotiationsItem,
  typeIntoChatFrame,
  HhAdapter,
} from '../src/adapters/hh.js';

const searchHtml = readFileSync('tests/fixtures/hh-search.html', 'utf8');
const vacancyHtml = readFileSync('tests/fixtures/hh-vacancy.html', 'utf8');
const responseSentHtml = readFileSync('tests/fixtures/hh-response-sent.html', 'utf8');
const negotiationsHtml = readFileSync('tests/fixtures/hh-negotiations.html', 'utf8');

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

/**
 * Свежий контекст с полной блокировкой сети. Фикстуры — настоящие страницы
 * hh.ru весом 1.5-2.7 МБ со встроенной аналитикой; без блокировки браузер
 * попытался бы догрузить десятки внешних скриптов/картинок/маячков.
 * Тесты не должны трогать сеть — это гарантирует именно эта блокировка, а
 * не просто использование page.setContent (setContent не идёт по HTTP сама
 * по себе, но парсинг DOM всё равно триггерит запросы под-ресурсов).
 */
async function offlineContext(): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.route('**/*', (route) => route.abort());
  return context;
}

async function pageWithContent(html: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await offlineContext();
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  return { context, page };
}

/**
 * Настоящие фикстуры hh.ru несут вшитые трекинговые маячки
 * (counter.yadro.ru и т.п.), чьи query-строки сами по себе содержат текст
 * "/vacancy/<id>" — наивный `url.includes('/vacancy/')` для роутинга
 * перехватывает и их тоже, задваивая счётчик запросов к странице вакансии.
 * Отличаем настоящую навигацию по document на hh.ru от маячка-картинки.
 */
function isHhDocumentRequest(route: Route): boolean {
  const req = route.request();
  if (req.resourceType() !== 'document') return false;
  try {
    return new URL(req.url()).hostname === 'hh.ru';
  } catch {
    return false;
  }
}

describe('buildSearchUrl', () => {
  it('строит URL ровно по контракту text=<query>&area=1 — совпадает с scripts/capture-hh.ts', () => {
    const url = buildSearchUrl('бизнес-аналитик');
    expect(url).toBe(
      'https://hh.ru/search/vacancy?text=%D0%B1%D0%B8%D0%B7%D0%BD%D0%B5%D1%81-'
      + '%D0%B0%D0%BD%D0%B0%D0%BB%D0%B8%D1%82%D0%B8%D0%BA&area=1',
    );
  });
});

describe('extractVacancyId / canonicalVacancyUrl', () => {
  it('достаёт числовой id из ссылки с query-мусором', () => {
    expect(extractVacancyId('https://hh.ru/vacancy/136701903?query=x&hhtmFrom=y')).toBe('136701903');
  });

  it('null на ссылке без /vacancy/', () => {
    expect(extractVacancyId('https://hh.ru/employer/89')).toBeNull();
  });

  it('строит чистый канонический url без query-мусора', () => {
    expect(canonicalVacancyUrl('136701903')).toBe('https://hh.ru/vacancy/136701903');
  });
});

describe('parseSalaryText', () => {
  // Формат текста зарплаты на карточке НЕ был снят живьём: документированный
  // селектор в реальной фикстуре указывает на скрытое поле формы поиска, а
  // не на зарплату конкретной карточки (см. task-10-report.md). Эти проверки
  // покрывают сам парсер как чистую функцию на иллюстративных строках, а не
  // на подтверждённой разметке hh.ru.
  it('пустая строка — все поля null', () => {
    expect(parseSalaryText('')).toEqual({ from: null, to: null, currency: null });
  });

  it('диапазон с рублём', () => {
    expect(parseSalaryText('100 000 – 150 000 ₽')).toEqual({ from: 100000, to: 150000, currency: 'RUR' });
  });

  it('одно число', () => {
    expect(parseSalaryText('от 200 000 ₽')).toEqual({ from: 200000, to: 200000, currency: 'RUR' });
  });

  it('текст без цифр — числа null, валюта null без символа', () => {
    expect(parseSalaryText('по договорённости')).toEqual({ from: null, to: null, currency: null });
  });
});

describe('classifyApplyOutcome', () => {
  const NONE = { captcha: false, sessionLost: false, alreadyApplied: false, submitted: false };

  it('капча — наивысший приоритет, перекрывает все остальные сигналы', () => {
    expect(classifyApplyOutcome({ ...NONE, captcha: true, sessionLost: true, alreadyApplied: true, submitted: true }))
      .toEqual({ status: 'captcha' });
  });

  it('потеря сессии — приоритет выше already_applied и submitted', () => {
    expect(classifyApplyOutcome({ ...NONE, sessionLost: true, alreadyApplied: true, submitted: true }))
      .toEqual({ status: 'auth_required' });
  });

  it('уже откликались — приоритет выше submitted', () => {
    expect(classifyApplyOutcome({ ...NONE, alreadyApplied: true, submitted: true }))
      .toEqual({ status: 'already_applied' });
  });

  it('submitted без остальных сигналов — sent', () => {
    expect(classifyApplyOutcome({ ...NONE, submitted: true })).toEqual({ status: 'sent' });
  });

  it('ничего не сработало — failed с переданной причиной', () => {
    expect(classifyApplyOutcome({ ...NONE, reason: 'кнопка не найдена' }))
      .toEqual({ status: 'failed', reason: 'кнопка не найдена' });
  });

  it('failed без явной причины — непустое дефолтное сообщение, а не пустая строка', () => {
    const r = classifyApplyOutcome(NONE);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.reason.length).toBeGreaterThan(0);
  });
});

describe('detectCaptcha / detectAlreadyApplied — маркеры не сняты живьём', () => {
  it('detectCaptcha всегда false, пока не появится проверенный селектор (docs/hh-selectors.md)', async () => {
    const { context, page } = await pageWithContent(vacancyHtml);
    expect(await detectCaptcha(page)).toBe(false);
    await context.close();
  });

  it('detectAlreadyApplied всегда false, пока не появится проверенный селектор', async () => {
    const { context, page } = await pageWithContent(vacancyHtml);
    expect(await detectAlreadyApplied(page)).toBe(false);
    await context.close();
  });
});

describe('parseSearchPage — tests/fixtures/hh-search.html (50 настоящих вакансий)', () => {
  it('парсит все 50 карточек выдачи', async () => {
    const { context, page } = await pageWithContent(searchHtml);
    const items = await parseSearchPage(page);
    expect(items).toHaveLength(50);
    await context.close();
  }, 20000);

  it('у каждой карточки числовой sourceId, непустые title/company и канонический url', async () => {
    const { context, page } = await pageWithContent(searchHtml);
    const items = await parseSearchPage(page);
    for (const item of items) {
      expect(item.sourceId).toMatch(/^\d+$/);
      expect(item.title).not.toBe('');
      expect(item.company).not.toBe('');
      expect(item.url).toBe(`https://hh.ru/vacancy/${item.sourceId}`);
    }
    await context.close();
  }, 20000);

  it('первая карточка — известная вакансия 136701903 (БАНК УРАЛСИБ)', async () => {
    const { context, page } = await pageWithContent(searchHtml);
    const items = await parseSearchPage(page);
    expect(items[0]!.sourceId).toBe('136701903');
    expect(items[0]!.title).toContain('бизнес-аналитик');
    expect(items[0]!.company).toContain('УРАЛСИБ');
    await context.close();
  }, 20000);

  it('зарплата почти всегда отсутствует и парсинг на этом не падает', async () => {
    const { context, page } = await pageWithContent(searchHtml);
    const items = await parseSearchPage(page);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.salaryFrom === null || typeof item.salaryFrom === 'number').toBe(true);
    }
    await context.close();
  }, 20000);
});

describe('кнопка отклика на странице вакансии (tests/fixtures/hh-vacancy.html)', () => {
  it('data-qa="vacancy-response-link-top" встречается 3 раза, first() виден', async () => {
    const { context, page } = await pageWithContent(vacancyHtml);
    const buttons = page.locator('[data-qa="vacancy-response-link-top"]');
    expect(await buttons.count()).toBe(3);
    expect(await buttons.first().isVisible()).toBe(true);
    await context.close();
  });

  it('описание вакансии читается и оно достаточно длинное для скорера', async () => {
    const { context, page } = await pageWithContent(vacancyHtml);
    const text = await page.locator('[data-qa="vacancy-description"]').first().innerText();
    expect(text.length).toBeGreaterThan(50);
    await context.close();
  });
});

describe('detectSubmitSuccess', () => {
  it('видит маркер успеха на странице после успешной подачи (hh-response-sent.html)', async () => {
    const { context, page } = await pageWithContent(responseSentHtml);
    await expect(detectSubmitSuccess(page, 3000)).resolves.toBe(true);
    await context.close();
  });

  it('НЕ видит маркер на странице вакансии до подачи (регрессия на точное vs составное совпадение data-qa)', async () => {
    const { context, page } = await pageWithContent(vacancyHtml);
    await expect(detectSubmitSuccess(page, 500)).resolves.toBe(false);
    await context.close();
  });
});

describe('findNegotiationsItem (tests/fixtures/hh-negotiations.html)', () => {
  it('находит карточку отклика по vacancyId и в ней есть open_chat', async () => {
    const { context, page } = await pageWithContent(negotiationsHtml);
    const item = findNegotiationsItem(page, '136701903');
    expect(await item.count()).toBe(1);
    expect(await item.locator('[data-qa="open_chat"]').count()).toBeGreaterThan(0);
    await context.close();
  });

  it('на несуществующем vacancyId ничего не находит', async () => {
    const { context, page } = await pageWithContent(negotiationsHtml);
    const item = findNegotiationsItem(page, '999999999999');
    expect(await item.count()).toBe(0);
    await context.close();
  });
});

describe('typeIntoChatFrame', () => {
  it('печатает текст в textarea', async () => {
    const context = await offlineContext();
    const page = await context.newPage();
    await page.setContent('<textarea></textarea>');
    await typeIntoChatFrame(page.mainFrame(), 'привет, это письмо');
    expect(await page.locator('textarea').inputValue()).toBe('привет, это письмо');
    await context.close();
  });

  it('печатает текст в contenteditable, если textarea нет', async () => {
    const context = await offlineContext();
    const page = await context.newPage();
    await page.setContent('<div contenteditable="true"></div>');
    await typeIntoChatFrame(page.mainFrame(), 'привет');
    expect(await page.locator('[contenteditable="true"]').innerText()).toContain('привет');
    await context.close();
  });
});

describe('HhAdapter.search — интеграция через перехват запросов (без сети)', () => {
  it('дочитывает описание для каждой возвращённой вакансии и уважает maxResults', async () => {
    const context = await browser.newContext();
    const detailRequests: string[] = [];
    await context.route('**/*', (route) => {
      if (!isHhDocumentRequest(route)) return route.abort();
      const url = route.request().url();
      if (url.includes('/search/vacancy')) {
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: searchHtml });
      }
      if (url.includes('/vacancy/')) {
        detailRequests.push(url);
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: vacancyHtml });
      }
      return route.abort();
    });

    const adapter = new HhAdapter({ context });
    const vacancies = await adapter.search({ query: 'бизнес-аналитик', maxResults: 3 });

    expect(vacancies).toHaveLength(3);
    expect(detailRequests.length).toBe(3);
    for (const v of vacancies) {
      expect(v.source).toBe('hh');
      expect(v.description.length).toBeGreaterThan(50);
    }

    await context.close();
  }, 30000);

  it('без maxResults возвращает все 50 карточек с описаниями', async () => {
    const context = await browser.newContext();
    let detailCalls = 0;
    await context.route('**/*', (route) => {
      if (!isHhDocumentRequest(route)) return route.abort();
      const url = route.request().url();
      if (url.includes('/search/vacancy')) {
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: searchHtml });
      }
      if (url.includes('/vacancy/')) {
        detailCalls++;
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: vacancyHtml });
      }
      return route.abort();
    });

    const adapter = new HhAdapter({ context });
    const vacancies = await adapter.search({ query: 'бизнес-аналитик' });

    expect(vacancies).toHaveLength(50);
    expect(detailCalls).toBe(50);

    await context.close();
  }, 60000);
});

describe('HhAdapter.apply — сквозной сценарий (без сети, без реальной подачи)', () => {
  it('шаг 1 успешен → sent; шаг 2 (письмо) недостижим офлайн → ошибка видна, но статус остаётся sent', async () => {
    const context = await browser.newContext();
    const loggedErrors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args.map(String).join(' '));
    };

    try {
      await context.route('**/*', (route) => {
        if (!isHhDocumentRequest(route)) return route.abort();
        const url = route.request().url();
        if (url.includes('/applicant/vacancy_response')) {
          // Клик по кнопке отклика — реальная навигация по href (JS не
          // исполняется, скрипты заблокированы), результат — страница
          // "после успешной подачи".
          return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: responseSentHtml });
        }
        if (url.includes('/applicant/negotiations')) {
          return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: negotiationsHtml });
        }
        if (url.includes('/vacancy/136701903')) {
          return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: vacancyHtml });
        }
        return route.abort();
      });

      // Короткий таймаут ожидания фрейма чата: без JS iframe чата никогда
      // не появится (chatik.hh.ru монтируется клиентским кодом hh.ru), так
      // что шаг 2 гарантированно завершится ошибкой — это и проверяем.
      const adapter = new HhAdapter({ context, timeouts: { chatFrameMs: 500, submitMs: 5000 } });
      const vacancy = normalizeVacancy({
        source: 'hh',
        sourceId: '136701903',
        title: 'Стажер - бизнес-аналитик',
        company: 'БАНК УРАЛСИБ',
        url: 'https://hh.ru/vacancy/136701903',
        description: 'd',
        geo: 'Москва',
        postedAt: new Date().toISOString(),
      });

      const result = await adapter.apply(vacancy, 'моё сопроводительное письмо');

      expect(result).toEqual({ status: 'sent' });
      expect(loggedErrors.some((e) => e.includes('136701903') && e.includes('письмо'))).toBe(true);
    } finally {
      console.error = originalError;
      await context.close();
    }
  }, 30000);
});
