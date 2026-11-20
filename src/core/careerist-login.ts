/**
 * Вход на careerist.ru из панели — кнопка «Войти в careerist» в «Аккаунтах и
 * ключах». Механизм тот же, что у hh.ru (core/hh-login.ts): окно Chromium на
 * общем профиле browser-profile/, логин и пароль человек вводит сам, код раз в
 * несколько секунд проверяет, появилась ли сессия, и закрывает вкладку.
 *
 * Отдельной страницы входа у careerist нет (login.html отдаёт 404, проверено
 * 2026-11-20): «Войти» в шапке главной открывает всплывающую форму через
 * vfShowInFrame('…', 'user/login/…'). Поэтому открываем главную и нажимаем эту
 * ссылку за человека — только открыть форму, поля он заполняет сам. Не
 * нажалось (вёрстка поменялась) — он нажмёт «Войти» сам, панель об этом пишет.
 *
 * Как понять, что вход случился. Устойчивой куки «вошёл» не найдено
 * (docs/careerist-selectors.md), зато есть личный кабинет: /responds/
 * вошедшему отдаёт список откликов, а гостя уводит на /no-access (проверено
 * 2026-11-20; раньше, по наблюдениям адаптера, — на login.html/register.html).
 */

export const CAREERIST_LOGIN_URL = 'https://careerist.ru/';
export const CAREERIST_LOGIN_MARKER = 'data/careerist-login.json';
export const CAREERIST_CABINET_URL = 'https://careerist.ru/responds/';

/** Куда careerist уводит гостя из личного кабинета. */
export const CAREERIST_GUEST_REDIRECT = /\/(no-access|login\.html|register\.html)/;

/** Ответ запроса к кабинету: Playwright APIResponse подходит как есть. */
export interface CabinetResponse {
  ok(): boolean;
  url(): string;
}

/** Вошёл ли профиль: кабинет открылся и не увёл на «нет доступа», вход или регистрацию. */
export function cabinetSaysLoggedIn(res: CabinetResponse): boolean {
  return res.ok() && !CAREERIST_GUEST_REDIRECT.test(res.url());
}

/** То, что нужно от контекста браузера: Playwright BrowserContext.request подходит. */
export interface CabinetRequester {
  get(url: string, options?: { timeout?: number }): Promise<CabinetResponse>;
}

export async function isCareeristLoggedIn(request: CabinetRequester): Promise<boolean> {
  return cabinetSaysLoggedIn(await request.get(CAREERIST_CABINET_URL, { timeout: 15000 }));
}

/** Ссылка «Войти» в шапке главной: её onclick открывает форму user/login. */
export const CAREERIST_LOGIN_LINK = 'a[onclick*="user/login"]';
