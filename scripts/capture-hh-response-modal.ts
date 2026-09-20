import { mkdirSync, writeFileSync } from 'node:fs';
import { isLoggedIn, openProfile } from '../src/browser.js';

/**
 * Снятие состояний окна отклика hh.ru (появилось в сентябре 2026): список
 * резюме в выпадашке и поле сопроводительного письма.
 *
 * Та же гарантия, что в capture-hh-response-form.ts: КАЖДЫЙ
 * POST/PUT/PATCH/DELETE обрывается, whitelist пуст. Кнопку «Send application»
 * скрипт не нажимает вообще — только «Откликнуться», ячейку резюме и
 * «добавить письмо». Все три — клиентские раскрытия, но даже если какое-то
 * из них окажется запросом, он не уйдёт с машины.
 *
 * Run: npx tsx scripts/capture-hh-response-modal.ts <URL вакансии>
 */

const OUT = 'tests/fixtures';
const BLOCKED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const vacancyUrl = process.argv[2];
if (vacancyUrl === undefined || !/^https:\/\/(www\.)?hh\.ru\/vacancy\/\d+/.test(vacancyUrl)) {
  console.error('Нужен URL вакансии hh.ru.');
  process.exit(2);
}

const ctx = await openProfile(false);
const page = await ctx.newPage();
const blocked: string[] = [];
await page.route('**/*', async (route) => {
  const req = route.request();
  if (!BLOCKED_METHODS.has(req.method())) {
    await route.continue();
    return;
  }
  blocked.push(`${req.method()} ${new URL(req.url()).pathname}`);
  await route.abort('blockedbyclient');
});

try {
  await page.goto(vacancyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (!(await isLoggedIn(page))) {
    console.error('НЕ ЗАЛОГИНЕН. Сначала: npx tsx scripts/login.ts');
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });

  await page.locator('[data-qa="vacancy-response-link-top"]').first().click();
  const submit = page.locator('[data-qa="vacancy-response-submit-popup"]');
  await submit.first().waitFor({ state: 'visible', timeout: 15_000 });

  // Ячейка резюме — role=button, внутри неё resume-title.
  const resumeCell = page.locator('[role="button"]').filter({ has: page.locator('[data-qa="resume-title"]') }).first();
  await resumeCell.click();
  await page.waitForTimeout(2500);
  writeFileSync(`${OUT}/hh-response-resume-list.html`, await page.content(), 'utf8');
  console.log('OK: hh-response-resume-list.html');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);

  // Если Escape закрыл всё окно — открываем заново.
  if (!(await submit.first().isVisible().catch(() => false))) {
    await page.locator('[data-qa="vacancy-response-link-top"]').first().click();
    await submit.first().waitFor({ state: 'visible', timeout: 15_000 });
  }
  const addLetter = page.locator('[data-qa="add-cover-letter"], [data-qa="vacancy-response-letter-toggle"]').first();
  await addLetter.click();
  await page.waitForTimeout(2500);
  writeFileSync(`${OUT}/hh-response-letter-open.html`, await page.content(), 'utf8');
  console.log('OK: hh-response-letter-open.html');
} finally {
  const uniq = [...new Set(blocked)].sort();
  console.log(`ЗАБЛОКИРОВАНО модифицирующих запросов: ${blocked.length}`);
  for (const b of uniq) console.log(`  ABORTED ${b}`);
  await ctx.close();
}
