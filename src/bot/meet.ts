/**
 * Разбор ответа рекрутёра на «Назначить собеседование». Формата нет: пишут как
 * пишется — «10 октября в 15:00», «10.10 в час дня», «завтра в 3», «в пятницу в
 * 14:30», а прежний `дд.мм;чч:мм` остаётся одним из вариантов.
 *
 * Разбор — правила, без модели: так /set_meet работает при исчерпанных лимитах и
 * упавшем OpenRouter, а один и тот же текст всегда даёт одно и то же. Цена —
 * две догадки там, где человек недоговаривает:
 *  - «в 3» без «утра/дня/вечера» читается как 15:00: часы 1–7 — дневные, ведь
 *    собеседований в три часа ночи не бывает (ведущий ноль, «03:00», — сутки);
 *  - дата без года — ближайшая в будущем.
 * Обе видны рекрутёру в подтверждении («Записал: …»), а владельцу — в пинге рядом
 * с дословным текстом рекрутёра, поэтому ошибку поймают до встречи.
 */

export type MeetParse =
  | { ok: true; at: Date; pretty: string }
  /**
   * unclear — даты нет или она невозможна; no-time — дата есть, времени нет;
   * past — понятно, но это время уже прошло.
   */
  | { ok: false; reason: 'unclear' | 'no-time' | 'past' };

const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
/** Индекс — Date#getDay(): воскресенье первым. */
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

const MONTH_PREFIXES: [string, number][] = [
  ['янв', 1], ['фев', 2], ['мар', 3], ['апр', 4], ['мая', 5], ['май', 5], ['июн', 6],
  ['июл', 7], ['авг', 8], ['сен', 9], ['окт', 10], ['ноя', 11], ['дек', 12],
];
const WEEKDAY_PREFIXES: [string, number][] = [
  ['пон', 1], ['вто', 2], ['сре', 3], ['чет', 4], ['пят', 5], ['суб', 6], ['вос', 0],
  ['пн', 1], ['вт', 2], ['ср', 3], ['чт', 4], ['пт', 5], ['сб', 6], ['вс', 0],
];
const NUM_WORDS: Record<string, number> = {
  час: 1, один: 1, два: 2, двух: 2, три: 3, трех: 3, четыре: 4, четырех: 4, пять: 5, пяти: 5,
  шесть: 6, шести: 6, семь: 7, семи: 7, восемь: 8, восьми: 8, девять: 9, девяти: 9,
  десять: 10, десяти: 10, одиннадцать: 11, одиннадцати: 11, двенадцать: 12, двенадцати: 12,
  тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17,
  восемнадцать: 18, девятнадцать: 19, двадцать: 20,
};

const NUM_WORD = Object.keys(NUM_WORDS).sort((a, b) => b.length - a.length).join('|');
const PERIOD = 'утра|дня|вечера|ночи';
const MONTH_WORD = 'янв[а-я]*|фев[а-я]*|мар[а-я]*|апр[а-я]*|ма[яй]|июн[а-я]*|июл[а-я]*|авг[а-я]*|сен[а-я]*|окт[а-я]*|ноя[а-я]*|дек[а-я]*';
/** «10-го», «10е»: порядковый суффикс после числа. */
const ORD = '(?:-?(?:го|е|ое|ого))?';
/** \b в JS не знает кириллицу, поэтому границы слов — явными проверками. */
const NOT_LETTER_AFTER = '(?![а-я])';

const RE = {
  iso: /(?<![\d.\-])(20\d{2})-(\d{1,2})-(\d{1,2})(?!\d)/,
  named: new RegExp(
    `(?<![\\d.:/])(\\d{1,2})${ORD}\\s*(?:числа\\s+)?(${MONTH_WORD})${NOT_LETTER_AFTER}\\.?(?:\\s*(20\\d{2})(?!\\d))?`,
  ),
  numericYear: /(?<![\d.:/\-])(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)/,
  dayOnly: new RegExp(`(?<![\\d.:/])(\\d{1,2})${ORD}\\s*числа${NOT_LETTER_AFTER}`),
  afterTomorrow: new RegExp(`(?<![а-я])после\\s*завтра${NOT_LETTER_AFTER}`),
  tomorrow: new RegExp(`(?<![а-я])завтра${NOT_LETTER_AFTER}`),
  today: new RegExp(`(?<![а-я])сегодня${NOT_LETTER_AFTER}`),
  inDays: new RegExp(`(?<![а-я])через\\s+(\\d{1,2}|${NUM_WORD})\\s*(?:дн[а-я]*|день)${NOT_LETTER_AFTER}`),
  inWeek: new RegExp(`(?<![а-я])через\\s+недел[юи]${NOT_LETTER_AFTER}`),
  weekday: new RegExp(
    `(?<![а-я])(понедельник[а-я]*|вторник[а-я]*|сред[аыуе]|четверг[а-я]*|пятниц[аыуе]|суббот[аыуе]|воскресень[ея])${NOT_LETTER_AFTER}`,
  ),
  /** «пт», «в пт»: отдельным словом — в слове «всё» или «среда» это уже не сокращение. */
  weekdayShort: new RegExp(`(?<![а-я])(?:(?:в|во|на)\\s+)?(пн|вт|ср|чт|пт|сб|вс)${NOT_LETTER_AFTER}\\.?`),
  /** «на следующей неделе»: день недели ищется уже за ближайшим понедельником. */
  nextWeek: new RegExp(`(?<![а-я])след[а-я]*\\.?\\s+недел[а-я]*${NOT_LETTER_AFTER}`),
  /** «15:00», «3:30 дня»; секунды отбрасываются. */
  clock: new RegExp(`(?<![\\d.,:/-])(\\d{1,2})\\s*:\\s*(\\d{2})(?::\\d{2})?(?!\\d)(?:\\s*(${PERIOD})${NOT_LETTER_AFTER})?`),
  /** «15-30»: только круглые минуты, иначе «с 10-12» читалось бы как 10:12. */
  clockDash: new RegExp(`(?<![\\d.,:/-])(\\d{1,2})-(00|15|30|45)(?![\\d-])(?:\\s*(${PERIOD})${NOT_LETTER_AFTER})?`),
  /** Пара чисел через точку, запятую или слэш: дата «10.10» или время «15.30». */
  pair: /(?<![\d.,:/\-])(\d{1,2})([./,])(\d{1,2})(?!\d)(?![./,]\d)/g,
  noon: new RegExp(`(?<![а-я])(?:в\\s+)?полден[ья]${NOT_LETTER_AFTER}`),
  /**
   * Час без минут: «в 15», «в 3 часа дня», «в час дня», «в 8 вечера». Голое число
   * часом не считается — нужен предлог, «час» или «утра/дня/вечера/ночи»; это
   * проверяется после совпадения, потому что в тексте бывают и другие числа.
   */
  hour: new RegExp(
    `(?<![а-я\\d.,:/-])(?:(в|к|около|ровно)\\s+)?(\\d{1,2}|${NUM_WORD})(?![\\d:.,/-])`
    + `(?:\\s*(час[а-я]*|ч)${NOT_LETTER_AFTER}(?:\\s*(\\d{1,2})\\s*мин[а-я]*)?)?`
    + `(?:\\s*(${PERIOD})${NOT_LETTER_AFTER})?`
    + '(?!\\s*(?:раз|мин|дн|ден|недел|месяц|год|лет|человек|штук))',
    'g',
  ),
};

interface Clock { hour: number; minute: number; period: string | null; plain: boolean }

type DateSpec =
  | { kind: 'abs'; year: number | null; month: number; day: number }
  | { kind: 'dayOnly'; day: number }
  | { kind: 'offset'; days: number }
  | { kind: 'weekday'; dow: number };

const two = (n: number): string => String(n).padStart(2, '0');
const prefixValue = (table: [string, number][], word: string): number =>
  table.find(([p]) => word.startsWith(p))?.[1] ?? 0;
const numberOf = (word: string): number => NUM_WORDS[word] ?? Number(word);

/** Час в сутках: «3 часа дня» — 15, «12 ночи» — 0, а голое «3» — дневное 15. */
function to24(hour: number, period: string | null, plain: boolean): number | null {
  if (hour < 0 || hour > 23) return null;
  switch (period) {
    case 'утра': return hour <= 12 ? hour : null;
    case 'дня': return hour >= 1 && hour <= 7 ? hour + 12 : hour;
    case 'вечера': return hour >= 1 && hour <= 11 ? hour + 12 : hour === 12 ? null : hour;
    case 'ночи': return hour === 12 ? 0 : hour >= 6 && hour <= 11 ? hour + 12 : hour;
    default: return plain && hour >= 1 && hour <= 7 ? hour + 12 : hour;
  }
}

/** «10 октября (суббота), 15:00»; чужой год называется явно: «5 января 2027 (вторник), 10:00». */
export function formatMeetTime(at: Date, now: Date): string {
  const year = at.getFullYear() === now.getFullYear() ? '' : ` ${at.getFullYear()}`;
  return `${at.getDate()} ${MONTHS_GEN[at.getMonth()]}${year} (${WEEKDAYS[at.getDay()]}), ${two(at.getHours())}:${two(at.getMinutes())}`;
}

const unclear: MeetParse = { ok: false, reason: 'unclear' };

export function parseMeetTime(raw: string, now: Date): MeetParse {
  const norm = raw.toLowerCase().replace(/ё/g, 'е').replace(/[   ]/g, ' ');
  // Найденное закрашивается пробелами: одно и то же число не станет и датой, и часом.
  let rest = norm;
  const mask = (index: number, length: number): void => {
    rest = rest.slice(0, index) + ' '.repeat(length) + rest.slice(index + length);
  };
  const consume = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(rest);
    if (m !== null) mask(m.index, m[0].length);
    return m;
  };
  const periodAfter = (end: number): string | null =>
    new RegExp(`^\\s*(${PERIOD})${NOT_LETTER_AFTER}`).exec(norm.slice(end))?.[1] ?? null;

  // 1. Дата, названная целиком.
  let date: DateSpec | null = null;
  let m: RegExpExecArray | null;
  if ((m = consume(RE.iso)) !== null) {
    date = { kind: 'abs', year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  } else if ((m = consume(RE.named)) !== null) {
    date = {
      kind: 'abs', year: m[3] === undefined ? null : Number(m[3]),
      month: prefixValue(MONTH_PREFIXES, m[2]!), day: Number(m[1]),
    };
  } else if ((m = consume(RE.numericYear)) !== null) {
    const y = Number(m[3]);
    date = { kind: 'abs', year: m[3]!.length === 2 ? 2000 + y : y, month: Number(m[2]), day: Number(m[1]) };
  } else if ((m = consume(RE.dayOnly)) !== null) {
    date = { kind: 'dayOnly', day: Number(m[1]) };
  }

  // 2. «сегодня», «завтра», «послезавтра», «через 3 дня».
  if (date === null) {
    if (consume(RE.afterTomorrow) !== null) date = { kind: 'offset', days: 2 };
    else if (consume(RE.tomorrow) !== null) date = { kind: 'offset', days: 1 };
    else if (consume(RE.today) !== null) date = { kind: 'offset', days: 0 };
    else if ((m = consume(RE.inDays)) !== null) date = { kind: 'offset', days: numberOf(m[1]!) };
    else if (consume(RE.inWeek) !== null) date = { kind: 'offset', days: 7 };
  }

  // 3. Время с двоеточием — однозначно время, в отличие от «10.10».
  let clock: Clock | null = null;
  m = consume(RE.clock) ?? consume(RE.clockDash);
  if (m !== null) {
    clock = {
      hour: Number(m[1]), minute: Number(m[2]), period: m[3] ?? null, plain: !m[1]!.startsWith('0'),
    };
  }

  // 4. Пары через точку: первая годная под дату — дата, годная под время — время.
  const pairs = [...rest.matchAll(RE.pair)].map((p) => ({
    index: p.index, length: p[0].length, a: Number(p[1]), aText: p[1]!, sep: p[2]!,
    b: Number(p[3]), bLen: p[3]!.length,
  }));
  const asDate = (p: { a: number; b: number }): boolean => p.a >= 1 && p.a <= 31 && p.b >= 1 && p.b <= 12;
  const asTime = (p: { a: number; b: number; sep: string; bLen: number }): boolean =>
    p.sep !== '/' && p.bLen === 2 && p.a <= 23 && p.b <= 59;
  const datePair = date === null ? pairs.find(asDate) : undefined;
  if (datePair !== undefined) {
    date = { kind: 'abs', year: null, month: datePair.b, day: datePair.a };
    mask(datePair.index, datePair.length);
  }
  if (clock === null) {
    const timePair = pairs.find((p) => p !== datePair && asTime(p));
    if (timePair !== undefined) {
      clock = {
        hour: timePair.a, minute: timePair.b, period: periodAfter(timePair.index + timePair.length),
        plain: !timePair.aText.startsWith('0'),
      };
      mask(timePair.index, timePair.length);
    }
  }

  // 5. День недели — самый слабый источник даты: явная дата сильнее.
  const nextWeek = consume(RE.nextWeek) !== null;
  if (date === null) {
    m = consume(RE.weekday) ?? consume(RE.weekdayShort);
    if (m !== null) date = { kind: 'weekday', dow: prefixValue(WEEKDAY_PREFIXES, m[1]!) };
  }

  // 6. Час словами или цифрами без минут: «в 15», «в час дня», «в полдень».
  if (clock === null) {
    if (consume(RE.noon) !== null) {
      clock = { hour: 12, minute: 0, period: null, plain: false };
    } else {
      for (const h of rest.matchAll(RE.hour)) {
        const [, prep, word, unit, minutes, period] = h;
        if (prep === undefined && unit === undefined && period === undefined) continue;
        clock = {
          hour: numberOf(word!), minute: minutes === undefined ? 0 : Number(minutes),
          period: period ?? null, plain: !/^0\d/.test(word!),
        };
        break;
      }
    }
  }

  let hour = 0;
  if (clock !== null) {
    const h24 = to24(clock.hour, clock.period, clock.plain);
    if (h24 === null || clock.minute > 59) return unclear;
    hour = h24;
  }
  if (date === null) return unclear;
  if (clock === null) return { ok: false, reason: 'no-time' };
  const minute = clock.minute;

  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  /** null — такой даты нет в календаре (31.02): Date молча перенёс бы её на март. */
  const build = (y: number, mo: number, d: number): Date | null => {
    const at = new Date(y, mo - 1, d, hour, minute, 0, 0);
    return at.getFullYear() === y && at.getMonth() === mo - 1 && at.getDate() === d ? at : null;
  };

  let at: Date | null = null;
  if (date.kind === 'abs') {
    if (date.year !== null) {
      at = build(date.year, date.month, date.day);
      if (at === null) return unclear;
      if (at.getTime() <= now.getTime()) return { ok: false, reason: 'past' };
    } else {
      for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
        const candidate = build(year, date.month, date.day);
        if (candidate === null) continue;
        if (candidate.getTime() > now.getTime()) {
          at = candidate;
          break;
        }
        // Сегодняшнее число с прошедшим временем — не повод переезжать на год вперёд.
        if (sameDay(candidate, now)) return { ok: false, reason: 'past' };
      }
    }
  } else if (date.kind === 'dayOnly') {
    for (let k = 0; k < 13 && at === null; k += 1) {
      const first = new Date(now.getFullYear(), now.getMonth() + k, 1);
      const candidate = build(first.getFullYear(), first.getMonth() + 1, date.day);
      if (candidate === null) continue;
      if (candidate.getTime() > now.getTime()) at = candidate;
      else if (sameDay(candidate, now)) return { ok: false, reason: 'past' };
    }
  } else if (date.kind === 'offset') {
    at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + date.days, hour, minute, 0, 0);
    if (at.getTime() <= now.getTime()) return { ok: false, reason: 'past' };
  } else {
    // Дней до ближайшего понедельника: в понедельник это 7, а не 0.
    const from = nextWeek ? (8 - now.getDay()) % 7 || 7 : 0;
    for (let k = from; k <= from + 7 && at === null; k += 1) {
      const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + k, hour, minute, 0, 0);
      if (candidate.getDay() === date.dow && candidate.getTime() > now.getTime()) at = candidate;
    }
  }
  if (at === null) return unclear;
  return { ok: true, at, pretty: formatMeetTime(at, now) };
}
