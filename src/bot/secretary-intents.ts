import { parseMeetTime } from './meet.js';
import type { FactTopic } from '../core/facts.js';
import type { ChatMode } from './state.js';
import type { SocialKind } from './memory.js';

/**
 * Что хочет рекрутёр, по правилам и без модели (спека 2026-10-09, 6.3, 6.5, 6.6).
 * Чистые функции: ни сети, ни базы, ни часов — «сейчас» приходит аргументом.
 * Запись на собеседование решают именно правила: модель не должна «записывать»
 * встречу словами, а один и тот же текст всегда должен давать один и тот же
 * исход. Регулярки написаны под нормализованный текст (нижний регистр, ё → е).
 *
 * Граница слова \b в JS знает только латиницу, поэтому везде, где нужна граница
 * кириллического слова, стоит «дальше не буква» и «раньше не буква».
 */

/** Нижний регистр, ё → е, неразрывные пробелы → пробел, повторы пробелов схлопнуты. */
export function normalizeForRules(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[    ]/g, ' ').replace(/\s+/g, ' ').trim();
}

const B = '(?<![а-яa-z])'; // начало слова
const E = '(?![а-яa-z])'; // конец слова

// ---------------------------------------------------------------------------
// Социальные сообщения
// ---------------------------------------------------------------------------

const GREETING_RE = new RegExp(
  `${B}(привет(?:ствую)?|здравствуй(?:те)?|добр(?:ый|ое|ого)\\s+(?:день|утро|вечер|времени суток)|хай|hello|hi|салют)${E}`, 'g');
const THANKS_RE = new RegExp(`${B}(спасибо|благодарю|спс|сенкс|thanks|thank you)${E}`, 'g');
const BYE_RE = new RegExp(
  `${B}(до свидания|всего (?:доброго|хорошего|наилучшего)|хорошего (?:дня|вечера|вам дня)|до связи|пока|удачи)${E}`, 'g');
const TAIL_RE = new RegExp(
  `${B}за\\s+(?:сообщение|информацию|ответ|отклик|резюме|предложение|обратную связь|быстрый ответ)${E}`, 'g');
const FILLER_RE = new RegExp(`${B}(хаер|большое|огромное|заранее|вам|вас|тебе|тебя|всем|очень)${E}`, 'g');
const ACK_RE = new RegExp(
  `${B}(ок|окей|okay|ok|понял|поняла|понятно|хорошо|принято|ясно|угу|ага|отлично|супер|договорились|ладно|класс)${E}`, 'g');
const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

/**
 * Приветствие, благодарность, прощание или подтверждение без содержания. Из
 * текста вырезается всё социальное; осталось меньше трёх букв — сообщение
 * только вежливость. Приветствие вместе с благодарностью («Привет, спасибо за
 * сообщение!») — уже ответ на наше первое сообщение, и ему нужен живой ответ, а
 * не готовая фраза: null. Прощание главнее благодарности.
 */
export function socialKind(text: string): SocialKind | 'ack' | null {
  let t = normalizeForRules(text);
  if (t === '') return null;
  const kinds = new Set<SocialKind>();
  let ack = false;
  const cut = (re: RegExp, kind?: SocialKind): void => {
    t = t.replace(re, () => {
      if (kind !== undefined) kinds.add(kind);
      return ' ';
    });
  };
  cut(BYE_RE, 'bye');
  cut(THANKS_RE, 'thanks');
  cut(GREETING_RE, 'greeting');
  cut(TAIL_RE);
  t = t.replace(FILLER_RE, ' ');
  t = t.replace(ACK_RE, () => { ack = true; return ' '; });
  t = t.replace(EMOJI_RE, () => { ack = true; return ' '; });
  const letters = t.replace(/[^a-zа-я]/g, '');
  if (letters.length >= 3) return null;
  if (kinds.has('bye')) return 'bye';
  if (kinds.size === 1) return [...kinds][0]!;
  if (kinds.size > 1) return null;
  return ack ? 'ack' : null;
}

// ---------------------------------------------------------------------------
// Просьба прислать резюме
// ---------------------------------------------------------------------------

const CV_NOUN_RE = new RegExp(`${B}(резюме|cv|сиви|портфолио)${E}`, 'g');
const CV_VERB_RE = new RegExp(
  `${B}(пришли|пришлите|скинь|скиньте|отправь|отправьте|дай|дайте|приложи|приложите|поделись|поделитесь|`
  + `прислать|скинуть|отправить|выслать|вышли|вышлите|кинь|киньте|посмотреть|ознакомиться|`
  + `можно|есть|нужн[оа]|жду|актуальн[а-я]*)${E}`);
const CV_DONE_RE = new RegExp(`${B}(получил[а-я]*|посмотрел[а-я]*|видел[а-я]*|изучил[а-я]*)${E}`);

/** Включая «ты», «вы» и текст из одного слова: «резюме?», «cv?», «а резюме». */
export function isCvRequest(text: string): boolean {
  const t = normalizeForRules(text);
  if (/^(?:а\s+)?(?:резюме|cv|сиви)\s*[?!.]*$/.test(t)) return true;
  for (const m of t.matchAll(CV_NOUN_RE)) {
    const at = m.index;
    // «в резюме написано», «по резюме вопросов нет» — разговор о резюме, а не просьба.
    if (/(?:^|\s)(?:в|по)\s+$/.test(t.slice(Math.max(0, at - 6), at))) continue;
    const around = t.slice(Math.max(0, at - 40), at + m[0].length + 40);
    if (CV_DONE_RE.test(around)) continue;
    const before = t.slice(Math.max(0, at - 40), at);
    const after = t.slice(at + m[0].length, at + m[0].length + 40);
    if (CV_VERB_RE.test(before) || CV_VERB_RE.test(after)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Факты
// ---------------------------------------------------------------------------

const FACT_RES: Array<[FactTopic, RegExp]> = [
  ['salary', new RegExp(`(зарплат|${B}зп${E}|з/п|оклад|вилк|по деньгам|доход|компенсац|на руки|сколько\\s+(?:хочет|просит|получать))`)],
  ['start', new RegExp(
    `(когда\\s+(?:[а-яa-z]+\\s+){0,2}(?:выйти|приступить|начать)|срок[а-я]*\\s+выхода|выход[а-я]*\\s+на\\s+работу|как\\s+скоро|когда\\s+выйдет|notice)`)],
  ['format', new RegExp(`(удален|офис|гибрид|формат[а-я]*\\s+работ|из\\s+дома|remote)`)],
  ['relocation', new RegExp('(переезд|переехать|релокац|relocat)')],
  ['test', new RegExp('(тестов[а-я]*\\s+задани|тестовое|test\\s*task)')],
  ['citizenship', new RegExp(`(гражданств|паспорт\\s+рф|резидент|${B}внж${E}|${B}рвп${E}|вид на жительство)`)],
  ['city', new RegExp(
    '(где\\s+(?:вы\\s+|ты\\s+|он\\s+|кандидат\\s+)?(?:живет[е]?|живешь|находится|находитесь|проживает[е]?|проживаешь)'
    + '|город\\s+проживания|в каком городе|из какого города)')],
  ['english', new RegExp('(английск|english|уровень языка)')],
  ['military', new RegExp('(военн|воинск|армия|отсрочк)')],
  ['education', new RegExp(`(образовани|${B}вуз${E}|университет|институт|диплом)`)],
];

/** Темы фактов, о которых спрашивает текст, в порядке появления. */
export function factTopics(text: string): FactTopic[] {
  const t = normalizeForRules(text);
  const found: Array<{ topic: FactTopic; at: number }> = [];
  for (const [topic, re] of FACT_RES) {
    const m = re.exec(t);
    if (m !== null) found.push({ topic, at: m.index });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.topic);
}

/**
 * Весь текст — только вопросы о фактах (и вежливость): тогда отвечаем без модели
 * дословными строками из data/facts.md. Выдумать такой ответ нельзя, и он
 * работает без OpenRouter.
 */
export function isFactsOnly(text: string): boolean {
  if (text.trim().length > 300) return false;
  const sentences = text.split(/[.!?\n]+/).map((s) => s.trim()).filter((s) => s !== '');
  if (sentences.length === 0) return false;
  let hasTopic = false;
  for (const sentence of sentences) {
    if (factTopics(sentence).length > 0) { hasTopic = true; continue; }
    if (socialKind(sentence) !== null) continue;
    return false;
  }
  return hasTopic;
}

// ---------------------------------------------------------------------------
// Да / нет / выбор слота
// ---------------------------------------------------------------------------

const YES_RE = new RegExp(`^(да|ага|верно|подтверждаю|ок|окей|хорошо|давай|точно|yes)${E}`);
const NO_RE = new RegExp(`^(нет|не то|неверно|не так)${E}`);

export function isYes(text: string): boolean {
  const t = normalizeForRules(text);
  return t.length <= 40 && YES_RE.test(t);
}

export function isNo(text: string): boolean {
  const t = normalizeForRules(text);
  return t.length <= 40 && NO_RE.test(t);
}

const ORDINALS: Array<[RegExp, number]> = [
  [new RegExp(`${B}перв(?:ый|ое|ую|ого)${E}`), 0],
  [new RegExp(`${B}втор(?:ой|ое|ую|ого)${E}`), 1],
  [new RegExp(`${B}трет(?:ий|ье|ью|ьего)${E}`), 2],
];

/**
 * Какой из предложенных слотов выбрал рекрутёр: «первый», «2», «вариант 3»,
 * «любой» (первый) или час, совпавший ровно с одним слотом («в 11», «11:00»).
 * null — не понятно, режим ожидания остаётся.
 */
export function pickOfferedSlot(
  text: string, slots: readonly number[], clockOf: (ms: number) => { hour: number; minute: number },
): number | null {
  if (slots.length === 0) return null;
  const t = normalizeForRules(text).replace(/[.!?,;()«»"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t === '' || t.length > 60) return null;
  if (new RegExp(`${B}(любой|любое|любую|любые|какой угодно)${E}`).test(t)) return slots[0] ?? null;
  for (const [re, i] of ORDINALS) if (re.test(t)) return slots[i] ?? null;
  const digit = /^(?:вариант |номер |слот |давай |давайте )?([1-9])(?:-?[а-я]{0,3})?(?: вариант)?$/.exec(t);
  if (digit !== null) return slots[Number(digit[1]) - 1] ?? null;
  const hits = new Set<number>();
  for (const m of t.matchAll(/(?<![\d:])(\d{1,2})(?::(\d{2}))?(?![\d:])/g)) {
    const hour = Number(m[1]);
    const minute = m[2] === undefined ? 0 : Number(m[2]);
    for (const ms of slots) {
      const c = clockOf(ms);
      if (c.hour === hour && c.minute === minute) hits.add(ms);
    }
  }
  return hits.size === 1 ? [...hits][0]! : null;
}

// ---------------------------------------------------------------------------
// Встреча
// ---------------------------------------------------------------------------

const MEET_RE = new RegExp(
  '(собеседован|интервью|созвон|звон|встреч|встрет|zoom|зум|teams|телемост|google meet|'
  + `${B}meet${E}|видеосвяз|видеозвон|онлайн[- ]?встреч|подключ|слот|приглаша|скрининг|этап)`);
const NEG_RE = /(не\s+(?:могу|можем|получится|смогу|сможем|удобно|подходит|выйдет)|отмен|перенес|перенос|не будет)/;
const RESCHEDULE_RE = /(перенес|перенос)/;
const PAST_RE = /(вчера|прошл[а-я]*\s+(?:неделе|раз)|как прошл|было\s+)/;
const ASK_RE = /(когда|во сколько|в какое время|какое время|какие (?:дни|слоты|окна)|удобн[а-я]*\s+(?:время|день)|предлож[а-я]*\s+(?:время|слот)|свободн[а-я]*\s+(?:время|окн|слот))/;
/** Слова, которыми зовут на разговор: без них «15 октября, собеседования в zoom» в описании вакансии — не просьба назвать время. */
const PROPOSE_RE = /(давай|давайте|предлага|назнач|созвон|позвон|пообщ|обсуд|можем|могу|готов|хотим|хотел|приглаш|набер|свяж)/;

const WEEKDAY_RE = new RegExp(`${B}(понедельник|вторник|сред[ауые]|четверг|пятниц[ауые]|суббот[ауые]|воскресень[ея])${E}`, 'g');
const RELATIVE_RE = new RegExp(`${B}(послезавтра|завтра|сегодня)${E}`, 'g');
const MONTHS = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря';
const NAMED_DATE_RE = new RegExp(`${B}(\\d{1,2})\\s+(${MONTHS})${E}`, 'g');
const NUMERIC_DATE_RE = /(?<![\d.:])(\d{1,2})[./](\d{1,2})(?:[./]\d{2,4})?(?![\d:])/g;
const ISO_DATE_RE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g;

/** Сколько дат названо в тексте: дни недели, «завтра», «10 октября», «10.10». */
export function countDates(norm: string): number {
  let n = 0;
  n += [...norm.matchAll(WEEKDAY_RE)].length;
  n += [...norm.matchAll(RELATIVE_RE)].length;
  n += [...norm.matchAll(NAMED_DATE_RE)].length;
  n += [...norm.matchAll(ISO_DATE_RE)].length;
  for (const m of norm.matchAll(NUMERIC_DATE_RE)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a >= 1 && a <= 31 && b >= 1 && b <= 12) n += 1;
  }
  return n;
}

/** Как день назван в тексте, для вопроса «Во сколько <день> удобно?». */
function dayPhrase(norm: string): string | null {
  const rel = new RegExp(`${B}(послезавтра|завтра|сегодня)${E}`).exec(norm);
  if (rel !== null) return rel[1]!;
  const wd = new RegExp(`${B}(понедельник|вторник|сред[ауые]|четверг|пятниц[ауые]|суббот[ауые]|воскресень[ея])${E}`).exec(norm);
  if (wd !== null) {
    const accusative: Record<string, string> = { среда: 'среду', среду: 'среду', пятница: 'пятницу', пятницу: 'пятницу', суббота: 'субботу', субботу: 'субботу' };
    const word = wd[1]!;
    return `в ${accusative[word] ?? word}`;
  }
  const named = new RegExp(`${B}(\\d{1,2})\\s+(${MONTHS})${E}`).exec(norm);
  if (named !== null) return `${named[1]} ${named[2]}`;
  const numeric = /(?<![\d.:])(\d{1,2})[./](\d{1,2})(?![\d:])/.exec(norm);
  return numeric === null ? null : `${numeric[1]}.${numeric[2]!.padStart(2, '0')}`;
}

export type MeetingSignal =
  | { kind: 'none' }
  /** Время названо однозначно и в контексте встречи: можно записывать. reschedule — «перенесём на…». */
  | { kind: 'confirmed'; at: Date; reschedule: boolean }
  /** Время названо, но слов о встрече нет: перед записью переспросим. */
  | { kind: 'ask_confirm'; at: Date }
  /** Про встречу говорят, дату назвали, времени нет. day — как день назван в тексте. */
  | { kind: 'need_time'; day: string | null }
  | { kind: 'past' }
  /** Две даты или отрицание с датой: «в среду не могу, давай в четверг». Просим назвать одно время. */
  | { kind: 'ambiguous' }
  /** Отмена или «не могу» без нового времени. Не автоматизируем. */
  | { kind: 'declined' }
  | { kind: 'ask_slots' };

export interface MeetingContext {
  /** Режим ожидания времени (рекрутёр уже получил вопрос «когда удобно?»). */
  mode: ChatMode;
  /** В этом чате уже записана встреча — тогда «не могу» и «перенесём» касаются её. */
  hasMeeting: boolean;
}

/**
 * Порядок проверок имеет значение (спека 6.5). `now` — «местные» часы пояса
 * владельца (Date, чьи поля равны стенным часам пояса): parseMeetTime считает в
 * местном времени Date.
 */
export function meetingSignal(text: string, now: Date, ctx: MeetingContext): MeetingSignal {
  const t = normalizeForRules(text);
  const waiting = ctx.mode === 'await_time';
  if (t.length > 400 && !waiting) return { kind: 'none' };

  const meet = MEET_RE.test(t);
  const dates = countDates(t);
  const p = parseMeetTime(text, now);
  const inMeetContext = meet || waiting || ctx.hasMeeting;

  // «Не могу», «отменяем», «перенесём на…» — только в разговоре о встрече: иначе
  // «не могу найти ваше резюме» превратилось бы в отмену.
  if (NEG_RE.test(t) && (inMeetContext || dates >= 1)) {
    if (RESCHEDULE_RE.test(t) && p.ok && dates === 1) return { kind: 'confirmed', at: p.at, reschedule: true };
    if (dates >= 2) return { kind: 'ambiguous' };
    if (p.ok) return { kind: 'ask_confirm', at: p.at };
    return { kind: 'declined' };
  }
  if (dates >= 2 && (meet || waiting)) return { kind: 'ambiguous' };

  if (p.ok) {
    if (PAST_RE.test(t)) return { kind: 'none' };
    if (meet || waiting) return { kind: 'confirmed', at: p.at, reschedule: false };
    return { kind: 'ask_confirm', at: p.at };
  }

  if (p.reason === 'past' && (meet || waiting)) return { kind: 'past' };
  if (p.reason === 'no-time' && (meet || waiting) && (waiting || PROPOSE_RE.test(t) || t.includes('?'))) {
    return { kind: 'need_time', day: dayPhrase(t) };
  }
  // «Когда сможете выйти на работу?» — вопрос о сроке выхода, а не о времени встречи: «сможете» здесь не признак.
  if (ASK_RE.test(t) && (meet || /удобно|свободн/.test(t)) && (t.includes('?') || /^(?:предлож|дай)/.test(t))) {
    return { kind: 'ask_slots' };
  }
  return { kind: 'none' };
}
