import { describe, it, expect, vi } from 'vitest';
import type { DialogMessage } from '../src/telegram/interview-session.js';
import {
  CHOICE_GRACE_MS, isChoicePrompt, isChoiceMade, interviewTitle, normalizeTitle, withInterviewed,
  decideChoice, promptStatus, choiceStep, type ChoiceStepInput,
} from '../src/core/interview-choice.js';

// Живые тексты ГигаРекрутёра 2026-09-27 (G2).
const PROMPT = 'Вижу, что вы откликнулись на несколько вакансий. По какой из них вы хотели бы продолжить диалог?\n'
  + '1. Стажер системный аналитик\n2. Системный аналитик\n3. Системный аналитик (ОКТУС)\n4. Data analyst\n'
  + '5. Middle Системный аналитик (Продукт массовых зачислений)\n'
  + 'Вы всегда можете сменить вакансию, написав мне об этом.';
const OPTIONS = [
  '1. Стажер системный аналитик', '2. Системный аналитик', '3. Системный аналитик (ОКТУС)', '4. Data analyst',
  '5. Middle Системный аналитик (Продукт массовых зачислений)',
];
const STARS = ['★☆☆☆☆', '★★☆☆☆', '★★★☆☆', '★★★★☆', '★★★★★'];
const CHOSEN = 'Спасибо за выбор вакансии! Дайте мне несколько секунд — и мы начнем диалог 👍';
const start = (title: string): string =>
  `Здравствуйте, Артём! Меня зовут ГигаРекрутёр. Получил Ваш отклик на позицию ${title}. `
  + 'Будет удобно прямо сейчас ответить на несколько вопросов по этой позиции?';

const T0 = 1_800_000_000_000;
function msg(id: number, text: string, over: Partial<DialogMessage> = {}): DialogMessage {
  const buttons = over.buttons ?? [];
  return { id, date: new Date(T0), text, urls: [], out: false, hasButtons: buttons.length > 0, buttons, ...over };
}
const prompt = (id = 10, buttons = [...OPTIONS, 'Далее'], over: Partial<DialogMessage> = {}): DialogMessage =>
  msg(id, PROMPT, { buttons, ...over });

describe('isChoicePrompt', () => {
  it('живая подсказка выбора вакансии с вариантами и «Далее» — да', () => {
    expect(isChoicePrompt(prompt())).toBe(true);
    expect(isChoicePrompt(msg(1, 'Выберите вакансию', { buttons: ['1. Data analyst'] }))).toBe(true);
    expect(isChoicePrompt(msg(1, 'По какую из вакансий продолжим?', { buttons: ['Далее'] }))).toBe(true);
  });

  it('оценка звёздами — нет, даже со словами о смене вакансии в тексте', () => {
    expect(isChoicePrompt(msg(1, 'Пожалуйста, оцените мою работу!', { buttons: STARS }))).toBe(false);
    expect(isChoicePrompt(msg(1, 'Оцените интервью. Вы всегда можете сменить вакансию.', { buttons: STARS }))).toBe(false);
    expect(isChoicePrompt(msg(1, 'Вы всегда можете сменить вакансию', { buttons: STARS }))).toBe(false);
  });

  it('без кнопок, без текстов кнопок, своё сообщение или чужой текст — нет', () => {
    expect(isChoicePrompt(msg(1, PROMPT))).toBe(false);
    expect(isChoicePrompt(msg(1, 'Выберите вакансию', { hasButtons: true, buttons: [] }))).toBe(false);
    expect(isChoicePrompt(prompt(1, OPTIONS, { out: true }))).toBe(false);
    expect(isChoicePrompt(msg(1, 'Какой у вас опыт с Kafka?', { buttons: ['1. Да'] }))).toBe(false);
  });
});

describe('isChoiceMade', () => {
  it('подсказка, поправленная ботом в «Спасибо за выбор вакансии!», — служебная строка, не вопрос', () => {
    expect(isChoiceMade(msg(1, CHOSEN))).toBe(true);
    expect(isChoiceMade(msg(1, CHOSEN, { out: true }))).toBe(false);
    expect(isChoiceMade(msg(1, start('Data analyst')))).toBe(false);
  });
});

describe('interviewTitle', () => {
  it('название после «позицию» до первой точки или перевода строки', () => {
    expect(interviewTitle(start('Стажер системный аналитик'))).toBe('Стажер системный аналитик');
    expect(interviewTitle('Получил Ваш отклик на позицию Системный аналитик (ОКТУС)\nБудет удобно?'))
      .toBe('Системный аналитик (ОКТУС)');
  });

  it('кавычки и разметка снимаются', () => {
    expect(interviewTitle('Получил Ваш отклик на позицию «Data analyst». Будет удобно?')).toBe('Data analyst');
    expect(interviewTitle('Получил Ваш отклик на позицию <b>Системный аналитик</b>. Будет удобно?')).toBe('Системный аналитик');
    expect(interviewTitle('Получил Ваш отклик на позицию "Системный  аналитик". Ок?')).toBe('Системный аналитик');
  });

  it('не начало интервью — null', () => {
    expect(interviewTitle('Какой у вас опыт с Kafka?')).toBeNull();
    expect(interviewTitle(CHOSEN)).toBeNull();
    expect(interviewTitle('Получил Ваш отклик на позицию . Ок?')).toBeNull();
  });
});

describe('normalizeTitle и withInterviewed', () => {
  it('нижний регистр, один пробел, без «N. », без кавычек, ё как е', () => {
    expect(normalizeTitle('1. Стажер  системный\u00A0аналитик')).toBe('стажер системный аналитик');
    expect(normalizeTitle('  12) «Стажёр» системный аналитик ')).toBe('стажер системный аналитик');
    expect(normalizeTitle('Системный аналитик (ОКТУС)')).toBe('системный аналитик (октус)');
  });

  it('добавляет нормализованное, без повторов; пустое не добавляет', () => {
    expect(withInterviewed([], 'Стажер системный аналитик')).toEqual(['стажер системный аналитик']);
    expect(withInterviewed(['стажер системный аналитик'], '«Стажёр системный аналитик»')).toEqual(['стажер системный аналитик']);
    expect(withInterviewed(['a'], '  ')).toEqual(['a']);
  });
});

describe('decideChoice', () => {
  it('ничего не пройдено — первый вариант', () => {
    expect(decideChoice([...OPTIONS, 'Далее'], [], false))
      .toEqual({ kind: 'option', button: '1. Стажер системный аналитик', title: 'Стажер системный аналитик' });
  });

  it('первый пройден — второй; «Системный аналитик» и «(ОКТУС)» — разные вакансии', () => {
    expect(decideChoice(OPTIONS, ['стажер системный аналитик'], false))
      .toEqual({ kind: 'option', button: '2. Системный аналитик', title: 'Системный аналитик' });
    expect(decideChoice(OPTIONS, ['стажер системный аналитик', 'системный аналитик'], false))
      .toEqual({ kind: 'option', button: '3. Системный аналитик (ОКТУС)', title: 'Системный аналитик (ОКТУС)' });
  });

  it('все видимые пройдены, есть «Далее» — «Далее»; второй раз на той же подсказке — ничего', () => {
    const all = OPTIONS.map(normalizeTitle);
    expect(decideChoice([...OPTIONS, 'Далее'], all, false)).toEqual({ kind: 'next', button: 'Далее' });
    expect(decideChoice([...OPTIONS, 'Далее ➡️'], all, false)).toEqual({ kind: 'next', button: 'Далее ➡️' });
    expect(decideChoice([...OPTIONS, 'Далее'], all, true)).toEqual({ kind: 'none' });
  });

  it('все пройдены и «Далее» нет — ничего; навигация и звёзды вариантами не считаются', () => {
    expect(decideChoice(OPTIONS, OPTIONS.map(normalizeTitle), false)).toEqual({ kind: 'none' });
    expect(decideChoice(['← Назад', '→'], [], true)).toEqual({ kind: 'none' });
    expect(decideChoice(STARS, [], false)).toEqual({ kind: 'none' });
  });

  it('рядом с нумерованными вариантами кнопка без номера («Отменить отклик») вариантом не считается', () => {
    const buttons = ['Отменить отклик', ...OPTIONS, 'Ни одна из них', 'Далее'];
    expect(decideChoice(buttons, [], false)).toMatchObject({ kind: 'option', button: '1. Стажер системный аналитик' });
    expect(decideChoice(buttons, OPTIONS.map(normalizeTitle), false)).toEqual({ kind: 'next', button: 'Далее' });
    expect(decideChoice(buttons, OPTIONS.map(normalizeTitle), true)).toEqual({ kind: 'none' });
    // Нет нумерации вовсе — вариантом считается любая кнопка с названием, как в находках G2.
    expect(decideChoice(['Системный аналитик', 'Data analyst'], ['системный аналитик'], false))
      .toEqual({ kind: 'option', button: 'Data analyst', title: 'Data analyst' });
  });

  it('название, обрезанное в кнопке многоточием, узнаётся по началу', () => {
    const interviewed = ['middle системный аналитик (продукт массовых зачислений)'];
    expect(decideChoice(['1. Middle Системный аналитик (Продукт мас…', '2. Data analyst'], interviewed, false))
      .toEqual({ kind: 'option', button: '2. Data analyst', title: 'Data analyst' });
  });
});

describe('promptStatus: выдержка перед нажатием', () => {
  it('подсказка последняя и моложе трёх минут — ждать до даты + 3 минуты', () => {
    expect(CHOICE_GRACE_MS).toBe(3 * 60_000);
    expect(promptStatus(prompt(), [prompt()], T0 + 2 * 60_000)).toEqual({ kind: 'wait', until: T0 + CHOICE_GRACE_MS });
  });

  it('подсказка последняя и ей три минуты — можно нажимать', () => {
    expect(promptStatus(prompt(), [prompt()], T0 + CHOICE_GRACE_MS)).toEqual({ kind: 'ready' });
  });

  it('за ней «Спасибо за выбор…» или начало интервью — бот выбрал сам', () => {
    expect(promptStatus(prompt(), [prompt(), msg(11, CHOSEN)], T0 + 10 * 60_000)).toEqual({ kind: 'botChose' });
    expect(promptStatus(prompt(), [prompt(), msg(11, start('Data analyst'))], T0)).toEqual({ kind: 'botChose' });
  });

  it('за ней что-то другое — не нажимать', () => {
    expect(promptStatus(prompt(), [prompt(), msg(11, 'Вы тут?')], T0 + 10 * 60_000)).toEqual({ kind: 'superseded' });
  });
});

describe('choiceStep', () => {
  function input(over: Partial<ChoiceStepInput> = {}): ChoiceStepInput & { press: ReturnType<typeof vi.fn> } {
    const p = prompt();
    const press = vi.fn(async () => true);
    return {
      prompt: p, msgs: [p], now: T0 + CHOICE_GRACE_MS, interviewed: [], pagedAt: undefined,
      getMessage: async () => p, press, owns: () => true, ...over,
    } as ChoiceStepInput & { press: ReturnType<typeof vi.fn> };
  }

  it('готово — перечитывает подсказку, нажимает первый вариант, новое интервью; в строке только название', async () => {
    const i = input();
    const step = await choiceStep(i);
    expect(i.press).toHaveBeenCalledWith(10, '1. Стажер системный аналитик');
    expect(step).toEqual({ kind: 'done', started: true, line: 'выбор вакансии 10: нажата «Стажер системный аналитик»' });
  });

  it('пока шла выдержка, подсказку поправили в «Спасибо за выбор…» — не нажимает, новое интервью', async () => {
    const i = input({ getMessage: async () => msg(10, CHOSEN) });
    const step = await choiceStep(i);
    expect(i.press).not.toHaveBeenCalled();
    expect(step).toMatchObject({ kind: 'done', started: true });
  });

  it('подсказку удалили или переписали во что-то другое — не нажимает', async () => {
    for (const current of [null, msg(10, 'Диалог завершён')]) {
      const i = input({ getMessage: async () => current });
      expect(await choiceStep(i)).toMatchObject({ kind: 'done', started: false });
      expect(i.press).not.toHaveBeenCalled();
    }
  });

  it('у свежей подсказки нет выбранной кнопки — ждать, решит следующий проход по новым кнопкам', async () => {
    const i = input({ getMessage: async () => prompt(10, ['1. Data analyst']) });
    expect(await choiceStep(i)).toEqual({ kind: 'wait', until: 0 });
    expect(i.press).not.toHaveBeenCalled();
  });

  it('моложе трёх минут — ждать, ничего не читает и не жмёт', async () => {
    const getMessage = vi.fn(async () => prompt());
    const i = input({ now: T0 + 60_000, getMessage });
    expect(await choiceStep(i)).toEqual({ kind: 'wait', until: T0 + CHOICE_GRACE_MS });
    expect(getMessage).not.toHaveBeenCalled();
    expect(i.press).not.toHaveBeenCalled();
  });

  it('«Далее»: нажата — снимок кнопок; та же страница после нажатия — ждать; новая — снова решать без «Далее»', async () => {
    const all = OPTIONS.map(normalizeTitle);
    const i = input({ interviewed: all });
    const paged = await choiceStep(i);
    expect(i.press).toHaveBeenCalledWith(10, 'Далее');
    expect(paged).toMatchObject({ kind: 'paged', snapshot: [...OPTIONS, 'Далее'].join('\n') });
    if (paged.kind !== 'paged') throw new Error('ожидалась «Далее»');

    const same = input({ interviewed: all, pagedAt: paged.snapshot });
    expect(await choiceStep(same)).toEqual({ kind: 'wait', until: 0 });
    expect(same.press).not.toHaveBeenCalled();

    const page2 = prompt(10, ['6. Бизнес-аналитик', 'Назад', 'Далее']);
    const next = input({ prompt: page2, msgs: [page2], getMessage: async () => page2, interviewed: all, pagedAt: paged.snapshot });
    expect(await choiceStep(next)).toMatchObject({ kind: 'done', started: true });
    expect(next.press).toHaveBeenCalledWith(10, '6. Бизнес-аналитик');

    const empty = prompt(10, ['Назад', 'Далее']);
    const none = input({ prompt: empty, msgs: [empty], getMessage: async () => empty, interviewed: all, pagedAt: paged.snapshot });
    expect(await choiceStep(none)).toMatchObject({ kind: 'done', started: false });
    expect(none.press).not.toHaveBeenCalled();
  });

  it('все варианты пройдены — ничего не жмёт, подсказка разобрана', async () => {
    const p = prompt(10, OPTIONS);
    const i = input({ prompt: p, msgs: [p], getMessage: async () => p, interviewed: OPTIONS.map(normalizeTitle) });
    expect(await choiceStep(i)).toEqual({ kind: 'done', started: false, line: 'выбор вакансии 10: все варианты уже пройдены, ничего не нажато' });
    expect(i.press).not.toHaveBeenCalled();
  });

  it('блокировку перехватили — не жмёт (FR-5)', async () => {
    const i = input({ owns: () => false });
    expect(await choiceStep(i)).toEqual({ kind: 'lost' });
    expect(i.press).not.toHaveBeenCalled();
  });

  it('кнопка не нажалась — подсказка разобрана, нового интервью нет', async () => {
    const i = input({ press: vi.fn(async () => false) });
    expect(await choiceStep(i)).toMatchObject({ kind: 'done', started: false });
  });

  it('бот выбрал сам — не жмёт, не перечитывает', async () => {
    const getMessage = vi.fn(async () => prompt());
    const i = input({ msgs: [prompt(), msg(11, CHOSEN)], getMessage });
    expect(await choiceStep(i)).toMatchObject({ kind: 'done', started: true });
    expect(i.press).not.toHaveBeenCalled();
  });
});
