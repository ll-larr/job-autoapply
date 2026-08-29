import { mkdirSync, writeFileSync } from 'node:fs';
import { isLoggedIn, openProfile } from '../src/browser.js';

/**
 * Снятие разметки формы отклика hh.ru.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ. Всё остальное в фикстурах — чтение публичных
 * страниц. Здесь единственный клик по «Откликнуться» в живом аккаунте, а от
 * него до настоящего отклика живому работодателю — один шаг. Поэтому скрипт
 * построен вокруг одной гарантии, а не вокруг удобства.
 *
 * ГАРАНТИЯ. Перед первым кликом на страницу вешается перехват, который
 * обрывает КАЖДЫЙ POST/PUT/PATCH/DELETE на hh.ru. Не «эндпоинт отклика»,
 * который я мог бы угадать неверно, а любую модифицирующую операцию вообще.
 * GET проходят, поэтому форма грузится и её видно целиком. Даже если hh.ru
 * подаёт отклик сразу по клику, без промежуточной формы, запрос физически
 * не уйдёт с машины.
 *
 * Скрипт НИЧЕГО не заполняет и не нажимает, кроме «Откликнуться».
 *
 * Run: npx tsx scripts/capture-hh-response-form.ts <URL вакансии>
 */

const OUT = 'tests/fixtures';
const BLOCKED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * ВНИМАНИЕ — ЗДЕСЬ БЫЛА ДОРОГАЯ ОШИБКА, НЕ ПОВТОРЯТЬ.
 *
 * `POST /applicant/vacancy_response/popup` — это НЕ подгрузка формы. Это САМА
 * ПОДАЧА ОТКЛИКА. Имя пути обманывает: слово «popup» выглядит как «покажи
 * модалку», но когда у соискателя есть резюме и сопроводительное письмо не
 * обязательно, hh.ru откликается сразу по нажатию «Откликнуться», без
 * промежуточной формы.
 *
 * 2026-08-29 этот путь был внесён в whitelist по догадке из его имени — и в
 * результате с аккаунта пользователя ушёл настоящий отклик на вакансию
 * 136701903 (БАНК УРАЛСИБ), без сопроводительного письма. Работодатель его
 * открыл. Отменить отклик на hh.ru нельзя.
 *
 * Вывод, который стоит запомнить: имя эндпоинта — не доказательство того, что
 * он делает. Пока не доказано обратное, любой модифицирующий запрос считается
 * необратимым действием.
 *
 * Поэтому whitelist пуст и должен таким остаться. Клик по «Откликнуться» на
 * аккаунте с резюме подаёт отклик; снять разметку формы, не подав отклик,
 * этим путём нельзя в принципе.
 */
const ALLOWED_PATHS = new Set<string>();

const vacancyUrl = process.argv[2];
if (vacancyUrl === undefined || !/^https:\/\/(www\.)?hh\.ru\/vacancy\/\d+/.test(vacancyUrl)) {
  console.error('Нужен URL вакансии hh.ru.');
  console.error('Пример: npx tsx scripts/capture-hh-response-form.ts https://hh.ru/vacancy/123456789');
  process.exit(2);
}

const ctx = await openProfile(false);
const page = await ctx.newPage();

// Счётчик заблокированного — он же доказательство, что защита реально сработала,
// а не просто была объявлена.
const blocked: string[] = [];

const allowed: string[] = [];

await page.route('**/*', async (route) => {
  const req = route.request();
  const method = req.method();
  if (!BLOCKED_METHODS.has(method)) {
    await route.continue();
    return;
  }

  let path: string;
  try {
    path = new URL(req.url()).pathname;
  } catch {
    path = req.url();
  }

  if (ALLOWED_PATHS.has(path)) {
    allowed.push(`${method} ${path}`);
    await route.continue();
    return;
  }

  // Всё остальное модифицирующее — под нож, включая запросы к сторонним
  // доменам: аналитика тут не нужна, а лишний пропущенный запрос — риск.
  blocked.push(`${method} ${path}`);
  await route.abort('blockedbyclient');
});

await page.goto(vacancyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

if (!(await isLoggedIn(page))) {
  console.error('НЕ ЗАЛОГИНЕН: профиль browser-profile/ не авторизован на hh.ru.');
  console.error('Форма отклика разлогиненному не покажется. Сначала: npx tsx scripts/login.ts');
  await ctx.close();
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

const responseButton = page.locator('[data-qa="vacancy-response-link-top"]').first();
if (!(await responseButton.isVisible().catch(() => false))) {
  console.error('Кнопка [data-qa="vacancy-response-link-top"] не видна на этой странице.');
  console.error('Возможно, отклик уже подан, вакансия закрыта, или разметка изменилась.');
  console.error('Это тоже полезный случай — записываю страницу как есть.');
  writeFileSync(`${OUT}/hh-response-unavailable.html`, await page.content(), 'utf8');
  await ctx.close();
  process.exit(1);
}

await responseButton.click();

// Форма может открыться модалкой на той же странице либо переводом на
// отдельный маршрут. Ждём просто «что-то изменилось», без предположений
// о том, как именно, — предполагать тут нечего, разметка и снимается.
await page.waitForTimeout(4000);

writeFileSync(`${OUT}/hh-response-form.html`, await page.content(), 'utf8');
console.log(`OK: записан ${OUT}/hh-response-form.html`);
console.log(`URL после клика: ${page.url()}`);

console.log('');
console.log(`ПРОПУЩЕНО (whitelist, только подгрузка формы): ${allowed.length}`);
for (const a of allowed) console.log(`  ALLOWED ${a}`);
console.log('');
console.log(`ЗАБЛОКИРОВАНО модифицирующих запросов: ${blocked.length}`);
// Пути, а не полные URL: в полном виде это километры телеметрии, в которых
// тонет единственное, что тут важно, — не ушёл ли наружу сам отклик.
const uniq = [...new Set(blocked)].sort();
for (const b of uniq) console.log(`  ABORTED ${b}`);

await ctx.close();
