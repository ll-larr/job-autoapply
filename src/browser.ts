import { chromium, type BrowserContext, type Page } from 'playwright';
import { resolve } from 'node:path';

/**
 * Каталог профиля Chromium. Общий для scripts/login.ts и
 * scripts/capture-hh.ts — сюда пользователь логинится руками, отсюда же
 * берутся куки на каждый следующий запуск. Оба скрипта импортируют этот
 * путь отсюда (а не хардкодят каждый свой), чтобы они гарантированно не
 * разъехались: если бы пути отличались, логин ушёл бы в один профиль, а
 * съёмка читала бы другой — и выглядело бы это как "логин не сработал".
 *
 * Обязательно в .gitignore (содержит живые сессионные куки пользователя).
 */
export const PROFILE_DIR = resolve('browser-profile');

/**
 * Persistent context на выделенном профиле. Пользователь логинится в него
 * руками один раз (см. scripts/login.ts); куки живут в каталоге профиля и
 * переживают перезапуски. Паролей в коде нет и не будет — это единственный
 * механизм аутентификации во всём проекте.
 */
export async function openProfile(headless = false): Promise<BrowserContext> {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1440, height: 900 },
    locale: 'ru-RU',
  });
}

/**
 * Best-effort проверка, залогинен ли текущий профиль на hh.ru.
 *
 * Используется в двух местах с разной строгостью:
 *  - scripts/login.ts — как необязательный информационный индикатор
 *    ("похоже, уже залогинен(-а)"), не как условие завершения. Завершает
 *    сессию только сам пользователь через Enter в терминале — автоматический
 *    гейт здесь опасен, потому что мог бы закрыть браузер посреди капчи или
 *    многошагового логина (SMS-код и т.п.), которые для этой функции
 *    неотличимы от "ещё логинится".
 *  - scripts/capture-hh.ts — как обязательный жёсткий гейт перед записью
 *    любого файла: съёмка на разлогиненном профиле молча испортила бы
 *    фикстуры и всю карту селекторов, которая из них выводится.
 *
 * Селекторы hh.ru здесь не проверены живьём — Task 9 их как раз ещё не
 * сняла (курица и яйцо: карта селекторов делается из фикстур, а фикстуры
 * снимаются с помощью этой функции). Поэтому проверка построена из
 * нескольких независимых сигналов, и при любой неопределённости считает
 * профиль разлогиненным: для capture-hh.ts ложное "не залогинен" стоит
 * лишний прогон, а ложное "залогинен" — испорченные фикстуры, которые
 * потом никто не заметит.
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  const url = new URL(page.url());
  const onHhRu = url.hostname === 'hh.ru' || url.hostname.endsWith('.hh.ru');

  // Сильный отрицательный сигнал: мы прямо сейчас на странице логина.
  if (onHhRu && url.pathname.startsWith('/account/login')) {
    return false;
  }

  // Основной сигнал: cookie hhrole, которую hh.ru использует для различения
  // анонимного посетителя и вошедшего пользователя. Если её нет вовсе
  // (страница ещё не подгрузилась, либо hh.ru её переименовал/убрал) —
  // падаем на DOM-эвристику ниже.
  const cookies = await page.context().cookies('https://hh.ru');
  const roleCookie = cookies.find((c) => c.name === 'hhrole');
  if (roleCookie) {
    return roleCookie.value !== '' && roleCookie.value !== 'anonymous';
  }

  if (!onHhRu) return false;

  // DOM-эвристика: hh.ru показывает разлогиненным ссылку "Войти" в шапке.
  // Ищем по тексту, а не по data-qa/классу — их мы ещё не подтвердили
  // живьём, а видимый текст меняется реже разметки.
  try {
    const loginLink = page.getByRole('link', { name: /войти/i }).first();
    const visible = await loginLink.isVisible();
    return !visible;
  } catch {
    return false;
  }
}
