import { readFileSync } from 'node:fs';
import { openProfile } from '../src/browser.js';

/**
 * Дослать сопроводительное письмо в чат по уже поданному отклику.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ И ПОЧЕМУ ЗДЕСЬ НЕТ СЕТЕВОЙ БЛОКИРОВКИ. Всё остальное
 * в разведке hh.ru делается с заблокированными POST. Здесь блокировки нет
 * намеренно: отправка сообщения и есть то действие, которое пользователь
 * поручил выполнить, а чат без POST вообще не отрисовывается.
 *
 * Разница с инцидентом 2026-08-29 принципиальная. Тогда я разрешил запрос,
 * о назначении которого только догадывался по его имени, и он оказался
 * подачей отклика. Здесь я нажимаю кнопку «отправить» в переписке, чей эффект
 * однозначен и назван пользователем. Никаких других кнопок скрипт не трогает.
 *
 * По умолчанию — холостой прогон: текст печатается в поле, но не отправляется.
 * Отправка только с явным флагом --send.
 *
 * Run: npx tsx scripts/send-hh-letter.ts <vacancyId> <файл_с_письмом> [--send]
 */

const vacancyId = process.argv[2];
const letterPath = process.argv[3];
const doSend = process.argv.includes('--send');

if (vacancyId === undefined || !/^\d+$/.test(vacancyId) || letterPath === undefined) {
  console.error('Использование: npx tsx scripts/send-hh-letter.ts <vacancyId> <файл_с_письмом> [--send]');
  process.exit(2);
}

const letter = readFileSync(letterPath, 'utf8').trim();
if (letter === '') {
  console.error('Файл с письмом пуст. Отправлять нечего.');
  process.exit(2);
}

console.log(doSend ? 'РЕЖИМ: ОТПРАВКА' : 'РЕЖИМ: холостой прогон (текст напечатаю, отправлять не буду)');
console.log(`Вакансия: ${vacancyId}`);
console.log(`Письмо: ${letter.length} символов`);
console.log('');

const ctx = await openProfile(false);
const page = await ctx.newPage();

await page.goto('https://hh.ru/applicant/negotiations', {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});
await page.waitForTimeout(4000);

const item = page
  .locator('[data-qa="negotiations-item"]')
  .filter({ has: page.locator(`a[href*="/vacancy/${vacancyId}"]`) })
  .first();

if (!(await item.isVisible().catch(() => false))) {
  console.error(`Карточка отклика на вакансию ${vacancyId} не найдена.`);
  await ctx.close();
  process.exit(1);
}

await item.locator('[data-qa="open_chat"]').first().click();
await page.waitForTimeout(6000);

// Чат живёт в отдельном iframe на chatik.hh.ru, а не в основном документе.
// Поиск по странице его не видит — на этом первый прогон и споткнулся.
const chatFrame = page.frames().find((f) => f.url().includes('chatik.hh.ru/chat/'));
if (chatFrame === undefined) {
  console.error('Iframe чата (chatik.hh.ru/chat/) не найден. Ничего не напечатано и не отправлено.');
  console.error(`URL: ${page.url()}`);
  console.error('Фреймы на странице:');
  for (const f of page.frames()) console.error(`  ${f.url().slice(0, 100)}`);
  await ctx.close();
  process.exit(1);
}
console.log(`Чат найден: ${chatFrame.url().slice(0, 70)}`);

const field = chatFrame.locator('textarea, [contenteditable="true"]').first();
if (!(await field.isVisible().catch(() => false))) {
  console.error('Поле ввода внутри чата не найдено. Ничего не напечатано и не отправлено.');
  await ctx.close();
  process.exit(1);
}

await field.click();
await field.fill(letter).catch(async () => {
  // contenteditable не всегда принимает fill.
  await page.keyboard.insertText(letter);
});
await page.waitForTimeout(1500);

const typed = (await field.inputValue().catch(async () => await field.innerText().catch(() => ''))).trim();
console.log(`В поле оказалось символов: ${typed.length}`);
console.log(`Совпадает с письмом: ${typed === letter ? 'да' : 'НЕТ — проверь вручную'}`);

if (!doSend) {
  console.log('');
  console.log('Холостой прогон окончен. Ничего не отправлено. Браузер закрываю.');
  console.log('Для реальной отправки добавь --send');
  await ctx.close();
  process.exit(0);
}

// Единственное модифицирующее действие во всём скрипте.
const sendButton = chatFrame
  .locator('button[type="submit"], [data-qa*="send"], button:has-text("Отправить")')
  .first();

if (await sendButton.isVisible().catch(() => false)) {
  await sendButton.click();
} else {
  await field.press('Enter');
}
await page.waitForTimeout(5000);

const after = (await field.inputValue().catch(async () => await field.innerText().catch(() => ''))).trim();
console.log('');
console.log(`Поле после отправки: ${after.length} символов ${after === '' ? '(пусто — похоже, ушло)' : '(не опустело, проверь глазами)'}`);
// Проверять надо содержимое iframe: page.content() отдаёт только главный
// документ, в котором сообщения чата не лежат, и даёт ложное "не нашёл".
const thread = await chatFrame.locator('body').innerText().catch(() => '');
console.log(`Текст письма виден в переписке: ${thread.includes(letter.slice(0, 60)) ? 'да' : 'НЕ НАЙДЕН — проверь глазами'}`);

await ctx.close();
