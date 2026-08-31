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
 * Один общий контекст на весь процесс.
 *
 * `launchPersistentContext` держит каталог профиля ЭКСКЛЮЗИВНО, поэтому два
 * адаптера, каждый со своим вызовом openProfile, гарантированно подрались бы
 * за него: второй падает с «профиль занят». Пока браузерный адаптер был один
 * (hh.ru), это не проявлялось; careerist.ru, которому профиль нужен для
 * подачи, сделал столкновение неизбежным.
 *
 * Контекст открывается лениво — при первом обращении, а не при сборке
 * адаптеров: поиску браузер не нужен вовсе, и платить секундами за запуск
 * Chromium на каждом прогоне поиска не за что.
 *
 * Закрытый контекст открывается заново: адаптеры вызывают close()
 * независимо друг от друга, и переиспользовать мёртвый было бы хуже, чем
 * потратить секунду на новый. Как именно определяется «закрыт» — см.
 * makeContextCache: это событие, а не опрос.
 *
 * Окно ВИДИМОЕ, и параметра для этого нет намеренно. Общий контекст один на
 * всех, так что режим задал бы тот адаптер, который обратился первым, — и
 * headless/headed зависел бы от порядка вызовов. Выбран видимый: на hh.ru
 * может выскочить капча, а капчу в headless-окне человек не решит, и
 * автоматика её не обходит.
 */
/**
 * Кеш одного живого контекста поверх функции, умеющей его открыть.
 *
 * Живость определяется СОБЫТИЕМ `close`, а не опросом. Опрос тут не работает
 * в принципе, и это стоило падения «browserContext.newPage: Target page,
 * context or browser has been closed» на живой отправке: `context.pages()` у
 * закрытого контекста не бросает, а спокойно возвращает пустой массив, так
 * что проверка «дёрнем и поймаем исключение» всегда говорила «жив» и отдавала
 * наружу мёртвый контекст.
 *
 * Playwright эмитит `close` и когда контекст закрыли явно, и когда браузер
 * персистентного профиля закрыли извне — например, человек закрыл окно
 * Chromium руками. Оба случая обязаны приводить к переоткрытию на следующем
 * обращении.
 */
export function makeContextCache(
  open: () => Promise<BrowserContext>,
): { get: () => Promise<BrowserContext>; close: () => Promise<void> } {
  let ctx: BrowserContext | undefined;
  let closed = true;

  return {
    async get(): Promise<BrowserContext> {
      if (ctx === undefined || closed) {
        ctx = await open();
        closed = false;
        ctx.once('close', () => { closed = true; });
      }
      return ctx;
    },
    async close(): Promise<void> {
      const c = ctx;
      ctx = undefined;
      closed = true;
      if (c !== undefined) await c.close().catch(() => {});
    },
  };
}

const sharedCache = makeContextCache(() => openProfile(false));

export async function sharedProfile(): Promise<BrowserContext> {
  return sharedCache.get();
}

/** Отпускает общий контекст. Безопасно вызывать повторно и на неоткрытом. */
export async function closeSharedProfile(): Promise<void> {
  await sharedCache.close();
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
