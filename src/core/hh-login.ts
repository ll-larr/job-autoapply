import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Вход на hh.ru из панели — кнопка «Войти в hh.ru» (то же, что `npm run login`).
 *
 * Открывается настоящее окно Chromium на общем профиле browser-profile/ —
 * том же, с которого потом идут отклики. Логин, пароль, СМС-код и капчу
 * человек вводит сам: код ни одного поля не заполняет. Код лишь раз в
 * несколько секунд смотрит, появилась ли кука вошедшего пользователя
 * (browser.ts#isLoggedIn), и, когда появилась, закрывает вкладку сам.
 *
 * Когда последний раз удалось войти, пишется в маленький файл в data/, чтобы
 * панель после перезапуска могла сказать «вход выполнен 18.11», не открывая
 * браузер ради проверки.
 */

export const HH_LOGIN_URL = 'https://hh.ru/account/login';
export const HH_LOGIN_MARKER = 'data/hh-login.json';

/** Сколько ждать, пока человек войдёт, прежде чем закрыть вкладку. */
export const HH_LOGIN_TIMEOUT_MS = 30 * 60 * 1000;
export const HH_LOGIN_POLL_MS = 3000;
/** Пауза между «вход выполнен» и закрытием вкладки: человек успевает увидеть, что вошёл. */
export const HH_LOGIN_CLOSE_DELAY_MS = 2500;

export type HhLoginState = 'idle' | 'opening' | 'waiting' | 'done' | 'closed' | 'timeout' | 'error';

export interface HhLoginStatus {
  state: HhLoginState;
  /** Когда последний раз удался вход (мс), по этому запуску или по файлу из data/. */
  lastLoginAt: number | null;
  error: string | null;
}

/** То, что нужно от вкладки браузера. Playwright Page подходит как есть. */
export interface LoginPage {
  goto(url: string): Promise<unknown>;
  close(): Promise<void>;
  isClosed(): boolean;
  bringToFront(): Promise<void>;
  once(event: 'close', fn: () => void): unknown;
}

export interface HhLoginDeps<P extends LoginPage> {
  /** Новая вкладка в общем профиле (видимое окно). */
  openPage(): Promise<P>;
  isLoggedIn(page: P): Promise<boolean>;
  markerPath?: string;
  now?: () => number;
  pollMs?: number;
  timeoutMs?: number;
  closeDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface HhLogin {
  start(): { ok: true } | { ok: false; error: string };
  status(): HhLoginStatus;
  /** Идёт ли вход прямо сейчас (окно открыто и ждёт человека). */
  running(): boolean;
}

function readMarker(path: string): number | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { at?: unknown };
    return typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : null;
  } catch {
    return null;
  }
}

export function createHhLogin<P extends LoginPage>(deps: HhLoginDeps<P>): HhLogin {
  const markerPath = deps.markerPath ?? HH_LOGIN_MARKER;
  const now = deps.now ?? (() => Date.now());
  const pollMs = deps.pollMs ?? HH_LOGIN_POLL_MS;
  const timeoutMs = deps.timeoutMs ?? HH_LOGIN_TIMEOUT_MS;
  const closeDelayMs = deps.closeDelayMs ?? HH_LOGIN_CLOSE_DELAY_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));

  let state: HhLoginState = 'idle';
  let error: string | null = null;
  let lastLoginAt: number | null = readMarker(markerPath);
  let page: P | null = null;

  const busy = (): boolean => state === 'opening' || state === 'waiting';

  const remember = (at: number): void => {
    lastLoginAt = at;
    try {
      mkdirSync(dirname(markerPath), { recursive: true });
      writeFileSync(markerPath, `${JSON.stringify({ at })}\n`, 'utf8');
    } catch {
      // Отметка — удобство для панели; не записалась — вход от этого не хуже.
    }
  };

  const run = async (): Promise<void> => {
    try {
      const p = await deps.openPage();
      page = p;
      let windowClosed = false;
      p.once('close', () => { windowClosed = true; });
      await p.goto(HH_LOGIN_URL);
      state = 'waiting';
      const deadline = now() + timeoutMs;
      for (;;) {
        if (windowClosed || p.isClosed()) {
          // Окно закрыли руками. Если к этому моменту вход уже случился —
          // это успех, а не отмена.
          state = 'closed';
          return;
        }
        let ok = false;
        try {
          ok = await deps.isLoggedIn(p);
        } catch {
          // Страница посреди перехода — пропускаем тик.
        }
        if (ok) {
          remember(now());
          state = 'done';
          await sleep(closeDelayMs);
          if (!p.isClosed()) await p.close().catch(() => {});
          return;
        }
        if (now() >= deadline) {
          state = 'timeout';
          if (!p.isClosed()) await p.close().catch(() => {});
          return;
        }
        await sleep(pollMs);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Профиль занят другим процессом (например, открыт `npm run login` или
      // `npm run send` в терминале) — частая и безобидная причина.
      error = /lock|SingletonLock|user data dir|already in use|ProcessSingleton/i.test(message)
        ? 'браузерный профиль занят другим окном программы — закрой его (или терминал с npm run login / send) и попробуй снова'
        : message.split('\n')[0]!.slice(0, 300);
      state = 'error';
    } finally {
      page = null;
    }
  };

  return {
    start() {
      if (busy()) {
        // Окно уже открыто — просто показываем его ещё раз.
        void page?.bringToFront().catch(() => {});
        return { ok: true };
      }
      state = 'opening';
      error = null;
      void run();
      return { ok: true };
    },
    status() {
      return { state, lastLoginAt, error };
    },
    running: busy,
  };
}
