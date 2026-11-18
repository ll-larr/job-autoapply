/**
 * Проверка, залогинен ли браузерный профиль на careerist.ru.
 *
 * ТОЛЬКО ЧТЕНИЕ. Ни одной кнопки не нажимается, ни одного отклика не
 * отправляется — открывается главная и страница вакансии, и смотрится, что
 * показывает шапка.
 *
 * Run: npx tsx --use-env-proxy scripts/check-careerist-login.ts
 */
import { openProfile } from '../src/browser.js';

const ctx = await openProfile(true);
const page = await ctx.newPage();

try {
  await page.goto('https://careerist.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  const cookies = await ctx.cookies('https://careerist.ru');
  console.log('куки careerist.ru:', cookies.length);
  for (const c of cookies) {
    const shown = c.value.length > 12 ? `${c.value.slice(0, 6)}…(${c.value.length})` : c.value;
    console.log(`   ${c.name} = ${shown}`);
  }

  const header = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a')];
    const text = (document.querySelector('header') ?? document.body).innerText.slice(0, 400);
    return {
      hasLogin: links.some((a) => /войти|вход/i.test(a.textContent ?? '')),
      hasLogout: links.some((a) => /выход|выйти/i.test(a.textContent ?? '')),
      cabinet: links
        .map((a) => a.getAttribute('href') ?? '')
        .filter((h) => /cabinet|profile|lk|account|resume/i.test(h))
        .slice(0, 6),
      headerText: text.replace(/\s+/g, ' ').slice(0, 260),
    };
  });

  console.log('');
  console.log('ссылка «Войти» в шапке:', header.hasLogin);
  console.log('ссылка «Выход»:        ', header.hasLogout);
  console.log('личный кабинет:        ', header.cabinet.join(', ') || '—');
  console.log('шапка:', header.headerText);

  // Что показывает кнопка отклика на конкретной вакансии: анонимному она
  // ведёт на register.html, залогиненному — должна вести куда-то ещё.
  await page.goto(
    'https://careerist.ru/vakansii/biznes-analitik-moskovskaya-obedinennaya-energeticheskaya-kompaniya-89110600.html',
    { waitUntil: 'domcontentloaded', timeout: 30000 },
  );
  const respond = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[onclick], a, button')]
      .filter((e) => /отправить резюме|откликнуться/i.test(e.textContent ?? ''));
    return els.slice(0, 4).map((e) => ({
      text: (e.textContent ?? '').trim().slice(0, 40),
      onclick: e.getAttribute('onclick') ?? '',
      href: e.getAttribute('href') ?? '',
    }));
  });
  console.log('');
  console.log('кнопки отклика на странице вакансии:');
  for (const r of respond) console.log('  ', JSON.stringify(r));
} finally {
  await ctx.close();
}
