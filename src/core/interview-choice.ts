import type { DialogMessage } from '../telegram/interview-session.js';

/**
 * Выбор вакансии в чате ГигаРекрутёра (G2, решение контроллера 2026-09-27).
 *
 * Когда откликов несколько, ГигаРекрутёр не начинает интервью, пока не нажат
 * один из вариантов его подсказки («По какой из них хотели бы продолжить
 * диалог?» с кнопками «1. …», «2. …» и «Далее»). Это единственная кнопка,
 * которую цикл вообще нажимает; оценку звёздами и всё прочее — никогда (R7).
 *
 * Живое поведение бота (2026-09-27): подсказка приходит сразу за оценкой
 * прошлого интервью; иногда бот сам выбирает первый вариант через минуту,
 * иногда подсказка висит днями. Поэтому нажатие только после выдержки
 * CHOICE_GRACE_MS, когда подсказка — последнее входящее, и только если,
 * перечитанная по id прямо перед нажатием, она всё ещё подсказка с этой
 * кнопкой: после выбора (ботом, владельцем или нами) бот правит её на месте в
 * «Спасибо за выбор вакансии!…» и снимает кнопки.
 *
 * Жмётся только пункт нумерованного списка из текста подсказки (C1), и перед
 * нажатием чат перечитывается (M3). Когда вакансия осталась одна, подсказки нет
 * вовсе: за оценкой сразу идёт начало нового интервью (isInterviewStart) — оно
 * законное и отвечается. Каждое начатое интервью считается в потолок за окно (C2).
 *
 * Здесь только решения; журнал, метка и нажатие — у цикла (interview-runner.ts).
 */

/** Выдержка перед нажатием: бот часто выбирает сам в первую минуту. */
export const CHOICE_GRACE_MS = 3 * 60_000;

/**
 * Слова самой подсказки (C1). «Сменить вакансию» сюда не входит: это подвал,
 * который бот ставит и под обычный вопрос интервью.
 */
const PROMPT_RE = /по как(ой|ую) из (них|вакансий)|выберите вакансию/i;
/** Любая строка про выбор вакансии, с подвалом, — служебная, не вопрос (M2). */
const CHOICE_TEXT_RE = /по как(ой|ую) из (них|вакансий)|выберите вакансию|сменить вакансию/i;
/** Оценка никогда не подсказка выбора, какие бы слова в ней ни встретились. */
const RATING_RE = /оцените|оценить|звёзд|звезд/i;
/** Кнопки, которые не жмутся ни при каком раскладе, даже из нумерованного списка (C1). */
const DENY_RE = /оцен|звезд|звёзд|★|⭐|сменить|отмен|отказ/i;
const CHOICE_MADE_RE = /спасибо за выбор вакансии/i;
/** Начало интервью: бот пишет то «на позицию», то «на вакансию» (C2). */
const START_RE = /получил[аи]?\s+ваш\s+отклик\s+на\s+(?:позицию|вакансию)\s*:?\s*/i;
/** «N. название» или «N) название» на кнопке. */
const NUMBERED_RE = /^\s*(\d{1,2})\s*[.)]\s*(.*\S)\s*$/;
const ELLIPSIS_RE = /\s*(?:…|\.\.\.)$/;

/** «1. Системный аналитик» → «Системный аналитик». */
function stripNumbering(text: string): string {
  return text.replace(/^\s*\d{1,2}\s*[.)]\s*/, '');
}

function clean(text: string): string {
  return text.replace(/<[^>]*>/g, '').replace(/[«»"“”„*_]/g, '').replace(/\s+/g, ' ').trim();
}

/** Навигация подсказки: «Далее», «Назад» и стрелки — не вакансии. */
function navKind(text: string): 'next' | 'prev' | null {
  const bare = text.toLowerCase().replace(/[^a-zа-яё]/g, '');
  if (bare === 'далее') return 'next';
  if (bare === 'назад') return 'prev';
  if (bare !== '') return null;
  if (/[→➡▶]/.test(text)) return 'next';
  if (/[←⬅◀]/.test(text)) return 'prev';
  return null;
}

/** Для сверки кнопки со списком: без разметки и кавычек, нижний регистр, ё как е, «N) » как «N. ». */
function matchKey(text: string): string {
  return clean(text).toLowerCase().replace(/ё/g, 'е').replace(/(\d{1,2})\s*[.)]\s*/g, '$1. ');
}

/**
 * Кнопка — пункт нумерованного списка из текста подсказки (C1): на ней «N.
 * название», и в тексте есть то же «N. название» (обрезанное многоточием —
 * по началу). Перед номером в тексте не цифра: «1. X» — не «11. X».
 */
function listedIn(button: string, text: string): boolean {
  const m = NUMBERED_RE.exec(button);
  if (m === null) return false;
  const title = (m[2] ?? '').replace(ELLIPSIS_RE, '');
  if (!/\p{L}/u.test(title)) return false;
  const needle = matchKey(`${m[1]}. ${title}`);
  const hay = matchKey(text);
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    if (i === 0 || !/\d/.test(hay[i - 1]!)) return true;
  }
  return false;
}

/**
 * Варианты подсказки по порядку (C1): только кнопки из её нумерованного списка
 * и без слов оценки, отмены, отказа и смены. Кнопка без номера вариантом не
 * бывает никогда; из них жмётся одна «Далее».
 */
function choiceOptions(m: Pick<DialogMessage, 'text' | 'buttons'>): string[] {
  return m.buttons.filter((b) => !DENY_RE.test(b) && listedIn(b, m.text));
}

/**
 * Подсказка выбора вакансии (C1): входящее с кнопками, текст спрашивает, по
 * какой вакансии продолжать («по какой из них», «выберите вакансию»), и не
 * меньше двух кнопок — пункты нумерованного списка из этого же текста. Не
 * оценка. Подвал «сменить вакансию» сам по себе подсказкой не делает.
 */
export function isChoicePrompt(m: DialogMessage): boolean {
  return !m.out && m.hasButtons && PROMPT_RE.test(m.text) && !RATING_RE.test(m.text)
    && choiceOptions(m).length >= 2;
}

/**
 * Строка про выбор вакансии — с кнопками или без («Пожалуйста, выберите
 * вакансию из списка выше.», подвал «сменить вакансию»). Служебная: не вопрос,
 * не отвечается никогда (M2). Кроме начала интервью: оно отвечается всегда,
 * даже с подвалом «сменить вакансию» (решение 2026-09-27 о начале без подсказки).
 */
export function isChoiceText(m: DialogMessage): boolean {
  return !m.out && CHOICE_TEXT_RE.test(m.text) && interviewTitle(m.text) === null;
}

/**
 * «Спасибо за выбор вакансии!…» — вакансия уже выбрана (бот правит в это
 * саму подсказку). Служебная строка: вопроса в ней нет, отвечать нечего.
 */
export function isChoiceMade(m: DialogMessage): boolean {
  return !m.out && CHOICE_MADE_RE.test(m.text);
}

/**
 * Название из хвоста после «на позицию» (C2): до перевода строки или до точки,
 * за которой пробел и заглавная (следующее предложение) либо конец строки.
 * Точка в скобках или кавычках («(г. Москва)», «"Аналитик. Данные"») и после
 * сокращения в одну-две строчные буквы («г. Москва») название не режет.
 */
function cutTitle(rest: string): string {
  const line = rest.replace(/<[^>]*>/g, '').split('\n')[0] ?? '';
  let parens = 0;
  let guillemets = 0;
  let straight = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (c === '(') parens += 1;
    else if (c === ')') parens = Math.max(0, parens - 1);
    else if (c === '«') guillemets += 1;
    else if (c === '»') guillemets = Math.max(0, guillemets - 1);
    else if (c === '"') straight = !straight;
    else if (c === '.' && parens === 0 && guillemets === 0 && !straight) {
      const after = line.slice(i + 1);
      const abbreviation = /(?:^|[^\p{L}])\p{Ll}{1,2}$/u.test(line.slice(0, i));
      if (after.trim() === '' || (/^\s+\p{Lu}/u.test(after) && !abbreviation)) return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Вакансия из начала интервью: «Получил Ваш отклик на позицию X. …» или «…на
 * вакансию X…» — X без кавычек и разметки (cutTitle). Не начало — null.
 */
export function interviewTitle(text: string): string | null {
  const m = START_RE.exec(text);
  if (m === null) return null;
  const title = clean(cutTitle(text.slice(m.index + m[0].length)));
  return title === '' ? null : title;
}

/**
 * Начало интервью: бот сам называет вакансию («Получил Ваш отклик на позицию
 * X»). После нашего нажатия, после выбора ботом, а когда вакансия осталась
 * одна — и сразу за оценкой прошлого, без подсказки (живое наблюдение
 * 2026-09-27). Всегда законное новое интервью: отвечается.
 */
export function isInterviewStart(m: DialogMessage): boolean {
  return !m.out && interviewTitle(m.text) !== null;
}

/** Граница между интервью: подсказка, её след «Спасибо за выбор…» или начало нового. */
export function isInterviewBoundary(m: DialogMessage): boolean {
  return isChoicePrompt(m) || isChoiceMade(m) || isInterviewStart(m);
}

/** Для сравнения: без «N. », кавычек и разметки, нижний регистр, один пробел, ё как е. */
export function normalizeTitle(text: string): string {
  return clean(stripNumbering(text)).toLowerCase().replace(/ё/g, 'е');
}

/** Список пройденных вакансий с ещё одной: нормализованной, без повторов. */
export function withInterviewed(list: readonly string[], title: string): string[] {
  const t = normalizeTitle(title);
  return t === '' || list.includes(t) ? [...list] : [...list, t];
}

/**
 * Одна и та же вакансия? Сравнение нормализованных названий; обрезанное
 * многоточием (в кнопке или в записанном по такой кнопке) узнаётся по началу.
 */
function sameTitle(a: string, b: string): boolean {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  const cx = x.replace(ELLIPSIS_RE, '');
  const cy = y.replace(ELLIPSIS_RE, '');
  if (cx === '' || cy === '') return false;
  if (cx !== x && cy !== y) return cx.startsWith(cy) || cy.startsWith(cx);
  if (cx !== x) return y.startsWith(cx);
  if (cy !== y) return x.startsWith(cy);
  return x === y;
}

export type ChoiceDecision =
  | { kind: 'option'; button: string; title: string }
  | { kind: 'next'; button: string }
  | { kind: 'none' };

/**
 * Первый по порядку вариант подсказки (только из её нумерованного списка, C1),
 * которого нет среди пройденных и который не вакансия идущего интервью
 * (`current`). Все пройдены — «Далее», если она есть и на этой подсказке ещё
 * не нажималась. Кроме «Далее», кнопка без номера не жмётся никогда.
 */
export function decideChoice(
  m: Pick<DialogMessage, 'text' | 'buttons'>,
  done: readonly string[],
  current: string,
  nextUsed: boolean,
): ChoiceDecision {
  for (const b of choiceOptions(m)) {
    if (done.some((x) => sameTitle(b, x)) || sameTitle(b, current)) continue;
    return { kind: 'option', button: b, title: clean(stripNumbering(b)) };
  }
  const next = m.buttons.find((b) => navKind(b) === 'next' && !DENY_RE.test(b));
  return next !== undefined && !nextUsed ? { kind: 'next', button: next } : { kind: 'none' };
}

export type PromptStatus =
  | { kind: 'botChose' }
  | { kind: 'superseded' }
  | { kind: 'wait'; until: number }
  | { kind: 'ready' };

/**
 * Можно ли уже жать. За подсказкой пришли «Спасибо за выбор…» или начало
 * интервью — бот выбрал сам. Пришло что-то другое — не жмём. Подсказка
 * последняя, но моложе выдержки — ждём до её даты плюс CHOICE_GRACE_MS.
 */
export function promptStatus(prompt: DialogMessage, msgs: readonly DialogMessage[], now: number): PromptStatus {
  const after = msgs.filter((m) => !m.out && m.id > prompt.id);
  if (after.some((m) => isChoiceMade(m) || interviewTitle(m.text) !== null)) return { kind: 'botChose' };
  if (after.length > 0) return { kind: 'superseded' };
  const until = prompt.date.getTime() + CHOICE_GRACE_MS;
  return now < until ? { kind: 'wait', until } : { kind: 'ready' };
}

export interface ChoiceStepInput {
  prompt: DialogMessage;
  /** Пачка, в которой найдена подсказка: по ней видно, что пришло за ней. */
  msgs: readonly DialogMessage[];
  now: number;
  /** Пройденные вакансии (RunnerState.interviewedTitles). */
  interviewed: readonly string[];
  /** Вакансия идущего интервью (RunnerState.currentTitle): её вариант не жмётся; '' — нет. */
  current: string;
  /**
   * Кнопки подсказки в момент, когда на ней уже нажата «Далее» (RunnerState.
   * pagedSnapshot при pagedPromptId = её id, I2); не нажималась — undefined.
   */
  pagedAt: string | undefined;
  /** Можно ли начать ещё одно интервью: потолок maxInterviewsPerWindow не набран (C2). */
  canStart: boolean;
  getMessage(id: number): Promise<DialogMessage | null>;
  /** История чата новее id (TgDialog.history): перед нажатием — нет ли нового (M3). */
  history(minId: number): Promise<DialogMessage[]>;
  press(messageId: number, button: string): Promise<boolean>;
  /** Блокировка всё ещё наша? Спрашивается последним перед нажатием (FR-5). */
  owns(): boolean;
}

/**
 * 'wait' — не сейчас: until > 0 — до этого момента держать сессию (выдержка),
 * 0 — просто посмотреть на следующем проходе. 'paged' — нажата «Далее», ждём
 * новую страницу. 'done' — подсказка разобрана, метка встаёт на неё; started —
 * вакансия выбрана (нами или без нас), началось новое интервью; pressed —
 * название варианта, который нажали мы (C2). 'capped' — нажатие начало бы
 * интервью сверх потолка за окно, ничего не нажато. 'lost' — блокировку
 * перехватили, ничего не нажато.
 */
export type ChoiceStep =
  | { kind: 'wait'; until: number }
  | { kind: 'paged'; snapshot: string; line: string }
  | { kind: 'done'; started: boolean; pressed?: string; line: string }
  | { kind: 'capped' }
  | { kind: 'lost' };

/** Один шаг разбора подсказки. В строках журнала — только id и название вакансии. */
export async function choiceStep(input: ChoiceStepInput): Promise<ChoiceStep> {
  const { prompt } = input;
  const head = `выбор вакансии ${prompt.id}`;
  const st = promptStatus(prompt, input.msgs, input.now);
  if (st.kind === 'botChose') return { kind: 'done', started: true, line: `${head}: бот выбрал сам, ничего не нажато` };
  if (st.kind === 'superseded') {
    return { kind: 'done', started: false, line: `${head}: за подсказкой пришли другие сообщения, ничего не нажато` };
  }
  if (st.kind === 'wait') return st;

  const snapshot = prompt.buttons.join('\n');
  // «Далее» нажата, а страница ещё прежняя: бот её не успел поправить.
  if (input.pagedAt === snapshot) return { kind: 'wait', until: 0 };
  const nextUsed = input.pagedAt !== undefined;
  const d = decideChoice(prompt, input.interviewed, input.current, nextUsed);
  if (d.kind === 'none') return { kind: 'done', started: false, line: `${head}: все варианты уже пройдены, ничего не нажато` };
  // Вариант начинает интервью: сверх потолка за окно не жмём (C2). «Далее» — не начало.
  if (d.kind === 'option' && !input.canStart) return { kind: 'capped' };

  // Перечитать прямо перед нажатием: выбрать могли и без нас.
  const current = await input.getMessage(prompt.id);
  if (current !== null && isChoiceMade(current)) {
    return { kind: 'done', started: true, line: `${head}: вакансию уже выбрали без нас, ничего не нажато` };
  }
  if (current === null || !isChoicePrompt(current)) {
    return { kind: 'done', started: false, line: `${head}: подсказка изменилась, ничего не нажато` };
  }
  // По свежей подсказке решение то же? Нет — решит следующий проход по новым кнопкам.
  const again = decideChoice(current, input.interviewed, input.current, nextUsed);
  if (again.kind === 'none' || again.kind !== d.kind || again.button !== d.button) return { kind: 'wait', until: 0 };
  // В чате что-то новое (владелец написал, бот дописал) — в этот проход не жмём (M3).
  if ((await input.history(prompt.id)).length > 0) return { kind: 'wait', until: 0 };
  if (!input.owns()) return { kind: 'lost' };

  const label = d.kind === 'option' ? d.title : d.button;
  if (!(await input.press(prompt.id, d.button))) {
    return { kind: 'done', started: false, line: `${head}: кнопка «${label}» не нажалась` };
  }
  if (d.kind === 'next') return { kind: 'paged', snapshot, line: `${head}: видимые варианты пройдены, нажата «${label}»` };
  return { kind: 'done', started: true, pressed: d.title, line: `${head}: нажата «${label}»` };
}
