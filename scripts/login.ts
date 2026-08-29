import { isLoggedIn, openProfile, PROFILE_DIR } from '../src/browser.js';

// Одноразовый (запускается пользователем вручную по мере надобности)
// скрипт логина. Открывает hh.ru/account/login в настоящем видимом окне
// Chromium на выделенном профиле и ждёт, пока пользователь сам введёт
// логин, пароль и, если появится, решит капчу. Скрипт паролей не касается
// и никакие поля не заполняет — руки на клавиатуре только у пользователя.
//
// Run: npx tsx scripts/login.ts

const LOGIN_URL = 'https://hh.ru/account/login';
const SAFETY_TIMEOUT_MS = 30 * 60 * 1000; // 30 минут — чтобы не висеть вечно, если забыли
const HEARTBEAT_MS = 5000;

console.log('Открываю hh.ru в браузере...');
const ctx = await openProfile(false);
const page = await ctx.newPage();
await page.goto(LOGIN_URL);

console.log('');
console.log('====================================================================');
console.log('Залогинься в открывшемся окне браузера вручную:');
console.log('  1. Введи логин/телефон и пароль сам — этот скрипт паролей не трогает');
console.log('     и никакие поля не заполняет.');
console.log('  2. Если появится капча — реши её сам, автоматика её не обходит.');
console.log('  3. Когда увидишь, что залогинен(-а) (открылась главная или личный');
console.log('     кабинет) — вернись в этот терминал и нажми Enter.');
console.log('====================================================================');
console.log('');
console.log(`Сессия сохранится в профиль: ${PROFILE_DIR}`);
console.log('Жду Enter в терминале (максимум 30 минут — после этого закроюсь сама,');
console.log('чтобы не висеть вечно; то, что успело залогиниться, останется в профиле).');
console.log('');

let closed = false;

async function finish(message: string, exitCode: number): Promise<void> {
  if (closed) return;
  closed = true;
  clearInterval(heartbeat);
  clearTimeout(safetyTimer);
  console.log(message);
  await ctx.close();
  process.exit(exitCode);
}

// Информационный heartbeat: подсказывает, похоже ли, что профиль уже
// залогинен. Сам НИЧЕГО не завершает — окончательное решение всегда за
// пользователем (Enter), потому что автоматический гейт по эвристике мог бы
// закрыть браузер посреди капчи или многошагового логина (например,
// SMS-кода), которые для этой эвристики неотличимы от "ещё логинится".
const heartbeat = setInterval(() => {
  if (closed) return;
  isLoggedIn(page)
    .then((ok) => {
      if (ok && !closed) {
        console.log('...похоже, уже залогинен(-а). Когда убедишься сам(а) — жми Enter.');
      }
    })
    .catch(() => {
      // Страница могла быть в процессе навигации — просто пропускаем тик.
    });
}, HEARTBEAT_MS);

const safetyTimer = setTimeout(() => {
  void finish(
    'Не дождался Enter за 30 минут — закрываюсь, чтобы не висеть вечно. ' +
      'Если ты успел(а) залогиниться, сессия уже в профиле — можно сразу ' +
      'запускать capture-hh.ts. Если нет — запусти login.ts заново.',
    1,
  );
}, SAFETY_TIMEOUT_MS);

process.stdin.once('data', () => {
  void finish('Ок, сохраняю сессию и закрываюсь.', 0);
});

process.once('SIGINT', () => {
  void finish('\nПрервано (Ctrl+C) — закрываю браузер аккуратно.', 130);
});
