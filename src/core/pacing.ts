/**
 * Темп обхода сайта при ПОИСКЕ (отправку держит config.throttle и Sender).
 *
 * До 2026-11-19 поиск на hh.ru открывал страницы выдачи и страницы вакансий
 * подряд без единой паузы — десятки навигаций в минуту. Именно это чаще всего
 * и вызывало капчу: человек так не листает. Паузы случайные (диапазон, а не
 * число), потому что ровный интервал — такой же признак робота, как и его
 * отсутствие. Раз в breakEvery вакансий — длинный «перекур».
 */

/** [минимум, максимум] в миллисекундах. */
export type MsRange = [number, number];

export interface SearchPacing {
  /** Пауза перед каждой следующей страницей выдачи. */
  pageDelayMs: MsRange;
  /** Пауза перед открытием каждой следующей страницы вакансии. */
  vacancyDelayMs: MsRange;
  /** Через сколько открытых вакансий делать длинную паузу. 0 — не делать. */
  breakEvery: number;
  /** Длина длинной паузы. */
  breakMs: MsRange;
  /**
   * Сколько ждать, пока человек решит капчу в открытом окне браузера, прежде
   * чем сдаться. 0 — не ждать вовсе (сразу остановиться, как раньше).
   */
  captchaWaitMs: number;
  /** Пауза после решённой капчи: сайт только что заподозрил робота. */
  afterCaptchaMs: MsRange;
}

export const DEFAULT_SEARCH_PACING: SearchPacing = {
  pageDelayMs: [4_000, 9_000],
  vacancyDelayMs: [5_000, 12_000],
  breakEvery: 20,
  breakMs: [60_000, 150_000],
  captchaWaitMs: 10 * 60_000,
  afterCaptchaMs: [60_000, 120_000],
};

/** Без пауз — для тестов и офлайн-фикстур. */
export const NO_PACING: SearchPacing = {
  pageDelayMs: [0, 0],
  vacancyDelayMs: [0, 0],
  breakEvery: 0,
  breakMs: [0, 0],
  captchaWaitMs: 0,
  afterCaptchaMs: [0, 0],
};

/** Случайное целое из [min, max] включительно. */
export function pickDelay([min, max]: MsRange, random: () => number = Math.random): number {
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * Спит ms миллисекунд, но просыпается сразу по сигналу остановки: кнопка
 * «Остановить поиск» посреди двухминутной паузы должна срабатывать сразу.
 */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function isRange(x: unknown): x is MsRange {
  return Array.isArray(x) && x.length === 2
    && x.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
    && (x[0] as number) <= (x[1] as number);
}

function isNonNegative(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0;
}

/**
 * Умолчания + то, что задано в config.json (`searchPacing.<площадка>`).
 * Кривое поле — ошибка конфига, а не тихий ноль: ноль здесь означал бы
 * возврат к обходу без пауз, то есть к той самой капче.
 */
export function resolveSearchPacing(raw: unknown, where = 'searchPacing'): SearchPacing {
  if (raw === undefined) return { ...DEFAULT_SEARCH_PACING };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`loadConfig: ${where} должен быть объектом`);
  }
  const r = raw as Record<string, unknown>;
  const out: SearchPacing = { ...DEFAULT_SEARCH_PACING };
  for (const key of ['pageDelayMs', 'vacancyDelayMs', 'breakMs', 'afterCaptchaMs'] as const) {
    if (r[key] === undefined) continue;
    if (!isRange(r[key])) {
      throw new Error(`loadConfig: ${where}.${key} должен быть [минимум, максимум] в мс, минимум не больше максимума`);
    }
    out[key] = [...(r[key] as MsRange)];
  }
  for (const key of ['breakEvery', 'captchaWaitMs'] as const) {
    if (r[key] === undefined) continue;
    if (!isNonNegative(r[key])) throw new Error(`loadConfig: ${where}.${key} должен быть числом >= 0`);
    out[key] = r[key] as number;
  }
  return out;
}
