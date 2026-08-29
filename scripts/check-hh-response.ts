import { openProfile } from '../src/browser.js';

/**
 * Read-only проверка: есть ли отклик на конкретную вакансию в списке откликов.
 * Только GET, ничего не отправляет и не отменяет.
 *
 * Run: npx tsx scripts/check-hh-response.ts <vacancyId>
 */

const vacancyId = process.argv[2];
if (vacancyId === undefined || !/^\d+$/.test(vacancyId)) {
  console.error('Нужен id вакансии. Пример: npx tsx scripts/check-hh-response.ts 136701903');
  process.exit(2);
}

const ctx = await openProfile(false);
const page = await ctx.newPage();

await page.goto('https://hh.ru/applicant/negotiations', {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});
await page.waitForTimeout(4000);

const html = await page.content();
const found = html.includes(`/vacancy/${vacancyId}`);

console.log(`URL: ${page.url()}`);
console.log(`Отклик на вакансию ${vacancyId} в списке: ${found ? 'ДА — отклик отправлен' : 'не найден'}`);

// Заголовки видимых откликов, чтобы можно было глазами сверить.
const titles = await page
  .locator('[data-qa="negotiations-item"], [data-qa*="topic"], a[href*="/vacancy/"]')
  .allInnerTexts()
  .catch(() => [] as string[]);
const cleaned = [...new Set(titles.map((t) => t.trim()).filter((t) => t !== ''))].slice(0, 15);
if (cleaned.length > 0) {
  console.log('');
  console.log('Видимые записи на странице откликов:');
  for (const t of cleaned) console.log(`  - ${t.replace(/\s+/g, ' ').slice(0, 110)}`);
}

await ctx.close();
