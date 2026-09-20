import { chromium, type Browser } from 'playwright';

/**
 * Чтение страницы вакансии браузером.
 *
 * Живой прогон 2026-09-20: голый fetch на hh.ru отдаёт только шапку сайта
 * («Сервисы, Помощь, Войти…») — описание рисует JS. Модель получала этот мусор
 * и честно отвечала «не по теме». Публичное api.hh.ru отвечает 403 и с прокси,
 * и напрямую, так что остаётся браузер.
 *
 * Браузер поднимается СВОЙ, не персистентный: залогиненный профиль
 * browser-profile/ держит поиск и панель (src/browser.ts), и бот, висящий
 * сутками, не должен на нём стоять — иначе `npm run search` не откроется.
 * Читать публичную страницу вакансии логин и не требует.
 */

const NAV_TIMEOUT_MS = 25_000;
/** Меньше — значит прочитали шапку сайта, а не вакансию. */
const MIN_TEXT = 200;

/** Заголовок и тело: первый подошедший селектор выигрывает, дальше — запасные. */
const TITLE_SELECTORS = ['[data-qa="vacancy-title"]', 'h1'];
const BODY_SELECTORS = ['[data-qa="vacancy-description"]', 'article', 'main', 'body'];

interface PageLike {
  locator: (s: string) => {
    count: () => Promise<number>;
    first: () => { innerText: (o?: { timeout?: number }) => Promise<string> };
  };
}

/**
 * Наличие проверяется через count(), а не ожиданием innerText: у отсутствующего
 * селектора ожидание стоит полный таймаут, и страница без описания обходилась
 * в пятнадцать секунд на пустом месте.
 */
async function firstText(page: PageLike, selectors: readonly string[]): Promise<string> {
  for (const selector of selectors) {
    const found = await page.locator(selector).count().catch(() => 0);
    if (found === 0) continue;
    const text = await page.locator(selector).first().innerText({ timeout: 3000 }).catch(() => '');
    if (text.trim() !== '') return text.trim();
  }
  return '';
}

export async function readVacancyPage(
  url: string,
  launch: () => Promise<Browser> = () => chromium.launch({ headless: true }),
): Promise<string | null> {
  let browser: Browser | null = null;
  try {
    browser = await launch();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    const title = await firstText(page, TITLE_SELECTORS);
    const body = await firstText(page, BODY_SELECTORS);
    const text = `${title}\n\n${body}`.trim();
    return text.length < MIN_TEXT ? null : text;
  } catch {
    // Страница не открылась, упала по таймауту, площадка показала заглушку —
    // для вызывающего это одно и то же: текста нет, надо просить у человека.
    return null;
  } finally {
    // Закрывать обязательно: иначе каждая присланная ссылка оставляет
    // висящий Chromium на машине, где бот работает сутками.
    if (browser !== null) await browser.close().catch(() => undefined);
  }
}
