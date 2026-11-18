import { writeFileSync } from 'node:fs';
import { openProfile } from '../src/browser.js';

/**
 * Read-only разведка страницы отклика: что доступно сделать с уже поданным
 * откликом, в частности — можно ли приложить сопроводительное письмо.
 *
 * ВСЕ модифицирующие запросы заблокированы. Уроком стоимостью в один
 * реальный отклик установлено: имя эндпоинта не доказывает, что он делает,
 * поэтому здесь ничего не пропускается — ни по имени, ни по догадке.
 * Скрипт только смотрит и записывает разметку.
 *
 * Run: npx tsx scripts/inspect-hh-negotiation.ts <vacancyId>
 */

const BLOCKED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const vacancyId = process.argv[2];
if (vacancyId === undefined || !/^\d+$/.test(vacancyId)) {
  console.error('Нужен id вакансии. Пример: npx tsx scripts/inspect-hh-negotiation.ts 136701903');
  process.exit(2);
}

const ctx = await openProfile(false);
const page = await ctx.newPage();

const blocked = new Set<string>();
await page.route('**/*', async (route) => {
  const req = route.request();
  if (!BLOCKED_METHODS.has(req.method())) {
    await route.continue();
    return;
  }
  let path: string;
  try { path = new URL(req.url()).pathname; } catch { path = req.url(); }
  blocked.add(`${req.method()} ${path}`);
  await route.abort('blockedbyclient');
});

await page.goto('https://hh.ru/applicant/negotiations', {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});
await page.waitForTimeout(4000);

writeFileSync('tests/fixtures/hh-negotiations.html', await page.content(), 'utf8');
console.log('записан tests/fixtures/hh-negotiations.html');

// Ищем ссылку на переписку по нужной вакансии.
const link = page.locator(`a[href*="/vacancy/${vacancyId}"]`).first();
const href = await link.getAttribute('href').catch(() => null);
console.log(`ссылка на вакансию в списке: ${href ?? 'не найдена'}`);

// Кнопки/ссылки, в тексте которых есть намёк на сопроводительное письмо.
const letterish = await page
  .getByText(/сопроводительн|cover letter/i)
  .allInnerTexts()
  .catch(() => [] as string[]);
console.log(`упоминаний сопроводительного на странице списка: ${letterish.length}`);
for (const t of [...new Set(letterish)].slice(0, 10)) {
  console.log(`  - ${t.replace(/\s+/g, ' ').slice(0, 120)}`);
}

console.log('');
console.log(`заблокировано модифицирующих: ${blocked.size}`);
for (const b of [...blocked].sort()) console.log(`  ABORTED ${b}`);

await ctx.close();
