/**
 * Что страница вакансии hh.ru говорит о типе отклика ДО клика.
 * ТОЛЬКО ЧТЕНИЕ: все не-GET запросы аборчены, ни одна кнопка не нажимается.
 * Run: npx tsx --use-env-proxy scripts/inspect-hh-apply-type.ts
 */
import { sharedProfile, closeSharedProfile, isLoggedIn } from '../src/browser.js';

const IDS = ['136110346', '134674453', '136299155'];

const ctx = await sharedProfile();
const page = await ctx.newPage();
await page.route('**/*', (r) => {
  if (r.request().method() !== 'GET') {
    console.log(`   [ЗАБЛОКИРОВАН ${r.request().method()}] ${r.request().url().slice(0, 90)}`);
    return r.abort();
  }
  return r.continue();
});

try {
  for (const id of IDS) {
    await page.goto(`https://hh.ru/vacancy/${id}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
    const info = await page.evaluate(() => {
      const body = document.body.innerText;
      const btn = document.querySelector('[data-qa="vacancy-response-link-top"], [data-qa*="vacancy-response"]');
      return {
        title: (document.querySelector('h1')?.textContent ?? '').trim().slice(0, 60),
        letterRequired: /сопроводительн\w* письм\w*\s*(обязательн|нужно|требуется)/i.test(body),
        mentionsLetter: /сопроводительн/i.test(body),
        mentionsQuestions: /вопрос\w* от работодателя|ответьте на вопрос/i.test(body),
        archived: /вакансия в архиве|вакансия удалена/i.test(body),
        alreadyApplied: /вы откликнулись|отклик отправлен/i.test(body),
        btn: btn ? { qa: btn.getAttribute('data-qa'), text: (btn.textContent ?? '').trim().slice(0, 30) } : null,
        // Маркеры, которые hh.ru вешает на кнопку, когда отклик особенный.
        dataQaAll: [...document.querySelectorAll('[data-qa*="response"]')]
          .map((e) => e.getAttribute('data-qa')).slice(0, 8),
      };
    });
    console.log(`=== ${id} — ${info.title}`);
    console.log('   залогинен:', await isLoggedIn(page));
    console.log('   в архиве:', info.archived, '| уже откликались:', info.alreadyApplied);
    console.log('   упоминает сопроводительное:', info.mentionsLetter,
      '| обязательно:', info.letterRequired);
    console.log('   упоминает вопросы:', info.mentionsQuestions);
    console.log('   кнопка:', JSON.stringify(info.btn));
    console.log('   data-qa с "response":', JSON.stringify(info.dataQaAll));
    console.log('');
  }
} finally {
  await page.close();
  await closeSharedProfile();
}
