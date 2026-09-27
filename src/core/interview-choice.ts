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
 * Здесь только решения; журнал, метка и нажатие — у цикла (interview-runner.ts).
 */

/** Выдержка перед нажатием: бот часто выбирает сам в первую минуту. */
export const CHOICE_GRACE_MS = 3 * 60_000;

const PROMPT_RE = /по как(ой|ую) из (них|вакансий)|выберите вакансию|сменить вакансию/i;
/** Оценка никогда не подсказка выбора, какие бы слова в ней ни встретились. */
const RATING_RE = /оцените|оценить|звёзд|звезд/i;
const CHOICE_MADE_RE = /спасибо за выбор вакансии/i;
const START_RE = /получил[аи]?\s+ваш\s+отклик\s+на\s+позицию\s*:?\s*([^.\n]*)/i;

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

/** Вариант — кнопка с буквами в названии: звёзды оценки и стрелки вариантами не бывают. */
function isOption(text: string): boolean {
  return navKind(text) === null && /\p{L}/u.test(stripNumbering(text));
}

/**
 * Подсказка выбора вакансии: входящее с кнопками, текст которого спрашивает,
 * по какой вакансии продолжать, среди кнопок есть вариант или «Далее», и это
 * не оценка.
 */
export function isChoicePrompt(m: DialogMessage): boolean {
  return !m.out && m.hasButtons && PROMPT_RE.test(m.text) && !RATING_RE.test(m.text)
    && m.buttons.some((b) => isOption(b) || navKind(b) === 'next');
}

/**
 * «Спасибо за выбор вакансии!…» — вакансия уже выбрана (бот правит в это
 * саму подсказку). Служебная строка: вопроса в ней нет, отвечать нечего.
 */
export function isChoiceMade(m: DialogMessage): boolean {
  return !m.out && CHOICE_MADE_RE.test(m.text);
}

/** Подсказка или её след «Спасибо за выбор…»: граница между интервью. */
export function isChoiceItem(m: DialogMessage): boolean {
  return isChoicePrompt(m) || isChoiceMade(m);
}

/**
 * Вакансия из начала интервью: «Получил Ваш отклик на позицию X. …» — X до
 * первой точки или перевода строки, без кавычек и разметки. Не начало — null.
 */
export function interviewTitle(text: string): string | null {
  const m = START_RE.exec(text);
  if (m === null) return null;
  const title = clean(m[1] ?? '');
  return title === '' ? null : title;
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

/** Название на кнопке пройдено? Обрезанное многоточием узнаётся по началу. */
function interviewed(button: string, done: readonly string[]): boolean {
  const t = normalizeTitle(button);
  const cut = t.replace(/(?:…|\.\.\.)$/, '').trim();
  return done.some((x) => x === t || (cut !== t && cut !== '' && x.startsWith(cut)));
}

export type ChoiceDecision =
  | { kind: 'option'; button: string; title: string }
  | { kind: 'next'; button: string }
  | { kind: 'none' };

const NUMBERED_RE = /^\s*\d{1,2}\s*[.)]\s*\S/;

/**
 * Первый по порядку вариант, которого нет среди пройденных. Все видимые
 * пройдены — «Далее», если она есть и на этой подсказке ещё не нажималась.
 * Если варианты пронумерованы («1. …»), кнопка без номера вариантом не
 * считается: «Отменить отклик» рядом с вакансиями нажать нельзя ни при каком
 * раскладе.
 */
export function decideChoice(buttons: readonly string[], done: readonly string[], nextUsed: boolean): ChoiceDecision {
  const numbered = buttons.some((b) => isOption(b) && NUMBERED_RE.test(b));
  for (const b of buttons) {
    if (!isOption(b) || (numbered && !NUMBERED_RE.test(b))) continue;
    if (!interviewed(b, done)) return { kind: 'option', button: b, title: clean(stripNumbering(b)) };
  }
  const next = buttons.find((b) => navKind(b) === 'next');
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
  /** Кнопки подсказки, при которых этой сессией уже нажата «Далее»; не нажималась — undefined. */
  pagedAt: string | undefined;
  getMessage(id: number): Promise<DialogMessage | null>;
  press(messageId: number, button: string): Promise<boolean>;
  /** Блокировка всё ещё наша? Спрашивается последним перед нажатием (FR-5). */
  owns(): boolean;
}

/**
 * 'wait' — не сейчас: until > 0 — до этого момента держать сессию (выдержка),
 * 0 — просто посмотреть на следующем проходе. 'paged' — нажата «Далее», ждём
 * новую страницу. 'done' — подсказка разобрана, метка встаёт на неё; started —
 * вакансия выбрана (нами или без нас), началось новое интервью. 'lost' —
 * блокировку перехватили, ничего не нажато.
 */
export type ChoiceStep =
  | { kind: 'wait'; until: number }
  | { kind: 'paged'; snapshot: string; line: string }
  | { kind: 'done'; started: boolean; line: string }
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
  const d = decideChoice(prompt.buttons, input.interviewed, input.pagedAt !== undefined);
  if (d.kind === 'none') return { kind: 'done', started: false, line: `${head}: все варианты уже пройдены, ничего не нажато` };

  // Перечитать прямо перед нажатием: выбрать могли и без нас.
  const current = await input.getMessage(prompt.id);
  if (current !== null && isChoiceMade(current)) {
    return { kind: 'done', started: true, line: `${head}: вакансию уже выбрали без нас, ничего не нажато` };
  }
  if (current === null || !isChoicePrompt(current)) {
    return { kind: 'done', started: false, line: `${head}: подсказка изменилась, ничего не нажато` };
  }
  if (!current.buttons.includes(d.button)) return { kind: 'wait', until: 0 };
  if (!input.owns()) return { kind: 'lost' };

  const label = d.kind === 'option' ? d.title : d.button;
  if (!(await input.press(prompt.id, d.button))) {
    return { kind: 'done', started: false, line: `${head}: кнопка «${label}» не нажалась` };
  }
  if (d.kind === 'next') return { kind: 'paged', snapshot, line: `${head}: видимые варианты пройдены, нажата «${label}»` };
  return { kind: 'done', started: true, line: `${head}: нажата «${label}»` };
}
