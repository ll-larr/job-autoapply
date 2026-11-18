/**
 * Часовые пояса без зависимостей — на Intl. Нужны секретарю: слоты и время для
 * рекрутёра считаются в поясе владельца из настроек календаря (по умолчанию
 * Europe/Moscow), а не в поясе машины, на которой крутится бот.
 */

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** ISO: понедельник — 1, воскресенье — 7. */
  weekday: number;
}

const WEEKDAY_ISO: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
/** Индекс — ISO-день недели − 1. */
const WEEKDAYS_RU = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = cache.get(tz);
  if (f === undefined) {
    // hourCycle h23: полночь — 0, а не 24 (так делает hour12:false в части движков).
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    cache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

function partsOf(ms: number, tz: string): WallClock & { second: number } {
  const p: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    year: Number(p['year']), month: Number(p['month']), day: Number(p['day']),
    hour: Number(p['hour']), minute: Number(p['minute']), second: Number(p['second']),
    weekday: WEEKDAY_ISO[p['weekday'] ?? ''] ?? 1,
  };
}

/** Что показывают стенные часы в поясе `tz` в момент `at`. */
export function wallClockOf(at: number | Date, tz: string): WallClock {
  const { second: _s, ...w } = partsOf(typeof at === 'number' ? at : at.getTime(), tz);
  void _s;
  return w;
}

/** Смещение пояса в момент t, мс: «стенное время как UTC» минус сам момент (до секунды). */
function offsetAt(t: number, tz: string): number {
  const w = partsOf(t, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(t / 1000) * 1000;
}

const sameWall = (a: WallClock, b: Pick<WallClock, 'year' | 'month' | 'day' | 'hour' | 'minute'>): boolean =>
  a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;

/**
 * Момент, в который стенные часы пояса `tz` показывают `w`. Два особых случая
 * переходов на летнее время: несуществующее время (02:30 при переводе вперёд)
 * даёт момент сразу за пропуском (03:30), повторяющееся (02:30 при переводе
 * назад) — первое из двух вхождений.
 */
export function instantOf(
  w: Pick<WallClock, 'year' | 'month' | 'day' | 'hour' | 'minute'>, tz: string,
): number {
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const before = offsetAt(naive - 86_400_000, tz);
  const after = offsetAt(naive + 86_400_000, tz);
  const candidates = [...new Set([naive - before, naive - after])].sort((a, b) => a - b);
  const fits = candidates.filter((t) => sameWall(wallClockOf(t, tz), w));
  return fits[0] ?? naive - before;
}

/** Date, чьи местные поля равны стенным часам `tz` в момент `at`: для parseMeetTime, считающего в поясе машины. */
export function asLocalDate(at: number | Date, tz: string): Date {
  const w = wallClockOf(at, tz);
  return new Date(w.year, w.month - 1, w.day, w.hour, w.minute, 0, 0);
}

/** Обратное: местные поля `d` читаются как стенные часы `tz`, результат — настоящий момент. */
export function instantOfLocalDate(d: Date, tz: string): number {
  return instantOf({
    year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(),
  }, tz);
}

const two = (n: number): string => String(n).padStart(2, '0');

/** «10 октября (суббота), 15:00» в поясе tz; чужой год называется явно. Тот же вид, что у formatMeetTime. */
export function formatInZone(at: number | Date, now: number | Date, tz: string): string {
  const w = wallClockOf(at, tz);
  const y = wallClockOf(now, tz).year;
  const year = w.year === y ? '' : ` ${w.year}`;
  return `${w.day} ${MONTHS_GEN[w.month - 1]}${year} (${WEEKDAYS_RU[w.weekday - 1]}), ${two(w.hour)}:${two(w.minute)}`;
}

/** Подпись пояса для рекрутёра: «по Москве», для остальных — имя пояса. */
export function tzLabel(tz: string): string {
  return tz === 'Europe/Moscow' ? 'по Москве' : `по ${tz}`;
}

export const MONTH_NAMES_GEN = MONTHS_GEN;
export const WEEKDAY_NAMES_RU = WEEKDAYS_RU;
