import { mkdirSync, writeFileSync } from 'node:fs';
import { isLoggedIn, openProfile } from '../src/browser.js';

// Снятие фикстур hh.ru: страница поиска и страница вакансии, с живого,
// залогиненного профиля пользователя (см. scripts/login.ts). Перед записью
// любого файла скрипт проверяет isLoggedIn() из src/browser.ts и падает
// громко, ничего не сохраняя, если профиль не авторизован — разлогиненная
// фикстура молча испортила бы карту селекторов, которую Task 10 выводит
// из этих файлов, и это не было бы заметно сразу.
//
// НЕ запускать без предварительного: npx tsx scripts/login.ts
// Run: npx tsx scripts/capture-hh.ts

const OUT = 'tests/fixtures';
// "бизнес-аналитик", область 1 = Москва.
const SEARCH_URL =
  'https://hh.ru/search/vacancy?text=%D0%B1%D0%B8%D0%B7%D0%BD%D0%B5%D1%81-%D0%B0%D0%BD%D0%B0%D0%BB%D0%B8%D1%82%D0%B8%D0%BA&area=1';

function notLoggedInAndBail(context: string): never {
  console.error(`НЕ ЗАЛОГИНЕН (${context}): профиль browser-profile/ не авторизован на hh.ru.`);
  console.error('Съёмка на разлогиненном профиле молча испортила бы фикстуры и карту');
  console.error('селекторов для Task 10 — поэтому останавливаюсь, ничего не записав.');
  console.error('');
  console.error('Сначала залогинься: npx tsx scripts/login.ts');
  process.exit(1);
}

const ctx = await openProfile(false);
const page = await ctx.newPage();

await page.goto(SEARCH_URL);
await page.waitForLoadState('networkidle');

if (!(await isLoggedIn(page))) {
  await ctx.close();
  notLoggedInAndBail('страница поиска');
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/hh-search.html`, await page.content(), 'utf8');
console.log(`OK: записан ${OUT}/hh-search.html`);

const firstLink = await page.locator('a[data-qa="serp-item__title"]').first().getAttribute('href');

let vacancyWritten = false;
if (firstLink) {
  await page.goto(firstLink);
  await page.waitForLoadState('networkidle');

  if (!(await isLoggedIn(page))) {
    console.error(`(${OUT}/hh-search.html уже записан этим прогоном — сессия слетела уже`);
    console.error('после него; проверь тот файл вручную, прежде чем доверять ему.)');
    await ctx.close();
    notLoggedInAndBail('страница вакансии');
  }

  writeFileSync(`${OUT}/hh-vacancy.html`, await page.content(), 'utf8');
  console.log(`OK: записан ${OUT}/hh-vacancy.html`);
  vacancyWritten = true;
} else {
  console.error('ПРЕДУПРЕЖДЕНИЕ: не нашёл ссылку на вакансию (a[data-qa="serp-item__title"])');
  console.error('в результатах поиска — hh-vacancy.html не записан. Либо разметка hh.ru');
  console.error('изменилась, либо результатов поиска не оказалось.');
}

await ctx.close();
process.exit(vacancyWritten ? 0 : 1);
