/**
 * Разметка страницы вакансии, на которую УЖЕ откликнулись, против обычной.
 * ТОЛЬКО ЧТЕНИЕ: все не-GET запросы аборчены, ни одна кнопка не нажимается.
 *
 * Run: npx tsx --use-env-proxy scripts/capture-hh-applied.ts
 */
import { sharedProfile, closeSharedProfile, isLoggedIn } from '../src/browser.js';

// 136781841 — владелец откликнулся руками. Вторая для сравнения: на неё
// отклика нет, значит видно, чем отличается.
const APPLIED = '136781841';
const FRESH = '136227311';

const ctx = await sharedProfile();
const page = await ctx.newPage();
await page.route('**/*', (r) => (r.request().method() === 'GET' ? r.continue() : r.abort()));

async function look(id: string, label: string): Promise<void> {
  await page.goto(`https://hh.ru/vacancy/${id}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => {
    const body = document.body.innerText;
    return {
      title: (document.querySelector('h1')?.textContent ?? '').trim().slice(0, 50),
      archived: /вакансия в архиве|вакансия удалена/i.test(body),
      // Все data-qa, где встречается response/negotiation — среди них и маркер.
      qa: [...new Set([...document.querySelectorAll('[data-qa]')]
        .map((e) => e.getAttribute('data-qa') ?? '')
        .filter((q) => /response|negotiation|applied/i.test(q)))].slice(0, 14),
      // Текст рядом с кнопкой отклика.
      buttons: [...document.querySelectorAll('a,button,span')]
        .map((e) => (e.textContent ?? '').trim())
        .filter((t) => /откликнут|отклик|вы уже|перейти к отклику|сопроводительн/i.test(t) && t.length < 60)
        .slice(0, 6),
    };
  });
  console.log(`=== ${label} (${id}) — ${info.title}`);
  console.log('   залогинен:', await isLoggedIn(page), '| в архиве:', info.archived);
  console.log('   data-qa:', JSON.stringify(info.qa));
  console.log('   тексты:', JSON.stringify(info.buttons));
  console.log('');
}

try {
  await look(APPLIED, 'УЖЕ ОТКЛИКНУЛИСЬ');
  await look(FRESH, 'обычная');
} finally {
  await page.close();
  await closeSharedProfile();
}
