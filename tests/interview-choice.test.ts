import { describe, it, expect, vi } from 'vitest';
import type { DialogMessage } from '../src/telegram/interview-session.js';
import {
  CHOICE_GRACE_MS, isChoicePrompt, isChoiceMade, isChoiceText, isInterviewStart, interviewTitle, normalizeTitle, withInterviewed,
  decideChoice, promptStatus, choiceStep, type ChoiceStepInput,
} from '../src/core/interview-choice.js';

// Живые тексты ГигаРекрутёра 2026-09-27 (G2).
const FOOTER = 'Вы всегда можете сменить вакансию, по которой хотите пройти первичное интервью - для этого нажмите '
  + 'на кнопку "сменить вакансию", расположенную в "меню" рядом с полем для ввода.';
const PROMPT = 'Вижу, что вы откликнулись на несколько вакансий. По какой из них вы хотели бы продолжить диалог?\n'
  + '1. Стажер системный аналитик\n2. Системный аналитик\n3. Системный аналитик (ОКТУС)\n4. Data analyst\n'
  + '5. Middle Системный аналитик (Продукт массовых зачислений)\n'
  + FOOTER;
const OPTIONS = [
  '1. Стажер системный аналитик', '2. Системный аналитик', '3. Системный аналитик (ОКТУС)', '4. Data analyst',
  '5. Middle Системный аналитик (Продукт массовых зачислений)',
];
const STARS = ['★☆☆☆☆', '★★☆☆☆', '★★★☆☆', '★★★★☆', '★★★★★'];
const CHOSEN = 'Спасибо за выбор вакансии! Дайте мне несколько секунд — и мы начнем диалог 👍';
const start = (title: string): string =>
  `Здравствуйте, Артём! Меня зовут ГигаРекрутёр. Получил Ваш отклик на позицию ${title}. `
  + 'Будет удобно прямо сейчас ответить на несколько вопросов по этой позиции?';
/** Вторая страница подсказки после «Далее»: бот правит и текст, и кнопки. */
const PAGE2 = 'По какой из них вы хотели бы продолжить диалог?\n6. Бизнес-аналитик\n7. Аналитик данных\n' + FOOTER;
const PAGE2_BUTTONS = ['6. Бизнес-аналитик', '7. Аналитик данных', 'Назад', 'Далее'];

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
    expect(isChoicePrompt(prompt(10, OPTIONS))).toBe(true);
    expect(isChoicePrompt(msg(1, 'Выберите вакансию:\n1. Data analyst\n2. Системный аналитик', {
      buttons: ['1. Data analyst', '2. Системный аналитик'],
    }))).toBe(true);
    // Варианты одной строкой, длинное название в кнопке обрезано многоточием.
    expect(isChoicePrompt(msg(1, 'По какой из них продолжим диалог? 1. Data analyst 2. Middle Системный аналитик '
      + '(Продукт массовых зачислений) ' + FOOTER, {
      buttons: ['1. Data analyst', '2. Middle Системный аналитик (Продукт мас…'],
    }))).toBe(true);
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
    expect(isChoicePrompt(msg(1, 'Какой у вас опыт с Kafka?', { buttons: ['1. Да', '2. Нет'] }))).toBe(false);
  });

  // C1: пробы ревью. Любая из них раньше нажимала первую кнопку через 3 минуты.
  it('вопрос посреди интервью с подвалом «сменить вакансию» и кнопками [Да, Нет] — не подсказка', () => {
    expect(isChoicePrompt(msg(1, `Готовы ли вы к переезду? ${FOOTER}`, { buttons: ['Да', 'Нет'] }))).toBe(false);
  });

  it('подвал «сменить вакансию» и кнопка «Сменить вакансию» — не подсказка', () => {
    expect(isChoicePrompt(msg(1, FOOTER, { buttons: ['Сменить вакансию'] }))).toBe(false);
  });

  it('оценка без слов «оцените»/«звёзд» в тексте, но со звёздами в кнопках — не подсказка', () => {
    const buttons = ['1 звезда', '2 звезды', '3 звезды', '4 звезды', '5 звёзд'];
    expect(isChoicePrompt(msg(1, `Как вам наш диалог? ${FOOTER}`, { buttons }))).toBe(false);
    expect(isChoicePrompt(msg(1, 'По какой из них продолжим?\n1. звезда\n2. звезды', { buttons: ['1. звезда', '2. звезды'] })))
      .toBe(false);
  });

  it('«сменить вакансию» — не слова подсказки: нужны «по какой из них» или «выберите вакансию»', () => {
    expect(isChoicePrompt(msg(1, 'Вы всегда можете сменить вакансию:\n1. Data analyst\n2. Системный аналитик', {
      buttons: ['1. Data analyst', '2. Системный аналитик'],
    }))).toBe(false);
  });

  it('нумерованные кнопки, которых нет в нумерованном списке текста, — не варианты', () => {
    expect(isChoicePrompt(msg(1, 'По какой из них хотели бы продолжить диалог?', { buttons: ['1. Да', '2. Нет'] }))).toBe(false);
    // «1. Data analyst» не то же, что «11. Data analyst» в тексте.
    expect(isChoicePrompt(msg(1, 'По какой из них?\n11. Data analyst\n12. Системный аналитик', {
      buttons: ['1. Data analyst', '2. Системный аналитик'],
    }))).toBe(false);
  });

  it('нужно не меньше двух вариантов из списка: один вариант или одна «Далее» — не подсказка', () => {
    expect(isChoicePrompt(msg(1, 'Выберите вакансию:\n1. Data analyst', { buttons: ['1. Data analyst'] }))).toBe(false);
    expect(isChoicePrompt(msg(1, 'По какую из вакансий продолжим?', { buttons: ['Далее'] }))).toBe(false);
  });

  it('варианты со словами отказа, отмены, смены и оценки не считаются, даже если они в списке', () => {
    expect(isChoicePrompt(msg(1, 'По какой из них продолжим?\n1. Отменить отклик\n2. Сменить вакансию\n3. Отказаться', {
      buttons: ['1. Отменить отклик', '2. Сменить вакансию', '3. Отказаться'],
    }))).toBe(false);
  });
});

describe('isChoiceText (M2)', () => {
  it('служебные строки выбора вакансии узнаются и без кнопок', () => {
    expect(isChoiceText(msg(1, 'Пожалуйста, выберите вакансию из списка выше.'))).toBe(true);
    expect(isChoiceText(msg(1, FOOTER))).toBe(true);
    expect(isChoiceText(msg(1, PROMPT))).toBe(true);
    expect(isChoiceText(msg(1, 'По какую из вакансий продолжим?'))).toBe(true);
  });

  it('обычный вопрос или своё сообщение — нет', () => {
    expect(isChoiceText(msg(1, 'Какой у вас опыт с Kafka?'))).toBe(false);
    expect(isChoiceText(msg(1, 'Выберите вакансию', { out: true }))).toBe(false);
  });

  it('начало интервью с подвалом «сменить вакансию» — не служебная строка: его отвечают', () => {
    expect(isChoiceText(msg(1, `${start('Data analyst')} ${FOOTER}`))).toBe(false);
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

  // C2: пробы ревью — «на вакансию» не узнавалось, «(г. Москва)» резалось на «г.».
  it('«на вакансию» — тоже начало интервью', () => {
    expect(interviewTitle('Получил Ваш отклик на вакансию Data analyst. Будет удобно?')).toBe('Data analyst');
  });

  it('точка режет только перед заглавной или в конце строки; «(г. Москва)» и «г. Москва» не режутся', () => {
    expect(interviewTitle(start('Бизнес-аналитик (г. Москва)'))).toBe('Бизнес-аналитик (г. Москва)');
    expect(interviewTitle(start('Бизнес-аналитик, г. Москва'))).toBe('Бизнес-аналитик, г. Москва');
    expect(interviewTitle('Получил Ваш отклик на позицию <b>Бизнес-аналитик (г. Москва)</b>. Будет удобно?'))
      .toBe('Бизнес-аналитик (г. Москва)');
    expect(interviewTitle('Получил Ваш отклик на позицию «Аналитик. Данные». Будет удобно?')).toBe('Аналитик. Данные');
    expect(interviewTitle('Получил Ваш отклик на позицию Data analyst.')).toBe('Data analyst');
    expect(interviewTitle('Получил Ваш отклик на позицию Аналитик 1С. Будет удобно?')).toBe('Аналитик 1С');
  });
});

describe('isInterviewStart', () => {
  it('входящее «Получил Ваш отклик на позицию|вакансию X» — начало интервью; своё или другое — нет', () => {
    expect(isInterviewStart(msg(1, start('Data analyst')))).toBe(true);
    expect(isInterviewStart(msg(1, 'Получил Ваш отклик на вакансию Data analyst.'))).toBe(true);
    expect(isInterviewStart(msg(1, start('Data analyst'), { out: true }))).toBe(false);
    expect(isInterviewStart(msg(1, CHOSEN))).toBe(false);
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
    expect(decideChoice(prompt(), [], '', false))
      .toEqual({ kind: 'option', button: '1. Стажер системный аналитик', title: 'Стажер системный аналитик' });
  });

  it('первый пройден — второй; «Системный аналитик» и «(ОКТУС)» — разные вакансии', () => {
    expect(decideChoice(prompt(10, OPTIONS), ['стажер системный аналитик'], '', false))
      .toEqual({ kind: 'option', button: '2. Системный аналитик', title: 'Системный аналитик' });
    expect(decideChoice(prompt(10, OPTIONS), ['стажер системный аналитик', 'системный аналитик'], '', false))
      .toEqual({ kind: 'option', button: '3. Системный аналитик (ОКТУС)', title: 'Системный аналитик (ОКТУС)' });
  });

  it('вариант идущего интервью (currentTitle) не жмётся, даже если его нет в пройденных (C1)', () => {
    expect(decideChoice(prompt(), [], 'Стажер системный аналитик', false))
      .toMatchObject({ kind: 'option', button: '2. Системный аналитик' });
    expect(decideChoice(prompt(10, ['5. Middle Системный аналитик (Продукт мас…', '4. Data analyst']), [],
      'Middle Системный аналитик (Продукт массовых зачислений)', false))
      .toMatchObject({ kind: 'option', button: '4. Data analyst' });
  });

  it('все видимые пройдены, есть «Далее» — «Далее»; второй раз на той же подсказке — ничего', () => {
    const all = OPTIONS.map(normalizeTitle);
    expect(decideChoice(prompt(), all, '', false)).toEqual({ kind: 'next', button: 'Далее' });
    expect(decideChoice(prompt(10, [...OPTIONS, 'Далее ➡️']), all, '', false)).toEqual({ kind: 'next', button: 'Далее ➡️' });
    expect(decideChoice(prompt(), all, '', true)).toEqual({ kind: 'none' });
  });

  it('все пройдены и «Далее» нет — ничего; навигация и звёзды вариантами не считаются', () => {
    expect(decideChoice(prompt(10, OPTIONS), OPTIONS.map(normalizeTitle), '', false)).toEqual({ kind: 'none' });
    expect(decideChoice(prompt(10, ['← Назад', '→']), [], '', true)).toEqual({ kind: 'none' });
    expect(decideChoice(prompt(10, STARS), [], '', false)).toEqual({ kind: 'none' });
  });

  it('кнопка без номера — никогда не вариант: «Отменить отклик», «Ни одна из них» и просто названия (C1)', () => {
    const buttons = ['Отменить отклик', ...OPTIONS, 'Ни одна из них', 'Далее'];
    expect(decideChoice(prompt(10, buttons), [], '', false)).toMatchObject({ kind: 'option', button: '1. Стажер системный аналитик' });
    expect(decideChoice(prompt(10, buttons), OPTIONS.map(normalizeTitle), '', false)).toEqual({ kind: 'next', button: 'Далее' });
    expect(decideChoice(prompt(10, buttons), OPTIONS.map(normalizeTitle), '', true)).toEqual({ kind: 'none' });
    // Нет нумерации вовсе — вариантов нет: жать нечего.
    const plain = msg(1, 'Выберите вакансию: Системный аналитик, Data analyst', { buttons: ['Системный аналитик', 'Data analyst'] });
    expect(decideChoice(plain, ['системный аналитик'], '', false)).toEqual({ kind: 'none' });
  });

  it('нумерованная кнопка, которой нет в списке текста, — не вариант, даже первой по порядку (C1)', () => {
    const m = prompt(10, ['1. Да', ...OPTIONS]);
    expect(decideChoice(m, [], '', false)).toMatchObject({ kind: 'option', button: '1. Стажер системный аналитик' });
    expect(decideChoice(prompt(10, ['1. Да', '2. Нет', 'Далее']), [], '', false)).toEqual({ kind: 'next', button: 'Далее' });
  });

  it('варианты со словами отказа, отмены, смены или оценки не жмутся никогда (C1)', () => {
    const text = 'По какой из них продолжим?\n1. Отменить отклик\n2. Data analyst\n3. Оценить интервью';
    expect(decideChoice(msg(1, text, { buttons: ['1. Отменить отклик', '2. Data analyst', '3. Оценить интервью'] }), [], '', false))
      .toMatchObject({ kind: 'option', button: '2. Data analyst' });
    expect(decideChoice(msg(1, text, { buttons: ['1. Отменить отклик', '2. Data analyst', '3. Оценить интервью'] }),
      ['data analyst'], '', false)).toEqual({ kind: 'none' });
  });

  it('название, обрезанное в кнопке многоточием, узнаётся по началу', () => {
    const interviewed = ['middle системный аналитик (продукт массовых зачислений)'];
    expect(decideChoice(prompt(10, ['5. Middle Системный аналитик (Продукт мас…', '4. Data analyst']), interviewed, '', false))
      .toEqual({ kind: 'option', button: '4. Data analyst', title: 'Data analyst' });
    // И наоборот: пройденное записано с многоточием (нажато по обрезанной кнопке), кнопка полная.
    expect(decideChoice(prompt(10, ['5. Middle Системный аналитик (Продукт массовых зачислений)', '4. Data analyst']),
      ['middle системный аналитик (продукт мас…'], '', false))
      .toEqual({ kind: 'option', button: '4. Data analyst', title: 'Data analyst' });
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
      prompt: p, msgs: [p], now: T0 + CHOICE_GRACE_MS, interviewed: [], current: '', pagedAt: undefined, canStart: true,
      getMessage: async () => p, history: async () => [], press, owns: () => true, ...over,
    } as ChoiceStepInput & { press: ReturnType<typeof vi.fn> };
  }

  it('готово — перечитывает подсказку, нажимает первый вариант, новое интервью; в строке только название', async () => {
    const i = input();
    const step = await choiceStep(i);
    expect(i.press).toHaveBeenCalledWith(10, '1. Стажер системный аналитик');
    // C2: нажатая вакансия отдаётся циклу — он пишет её сразу, не дожидаясь начала интервью.
    expect(step).toEqual({
      kind: 'done', started: true, pressed: 'Стажер системный аналитик', line: 'выбор вакансии 10: нажата «Стажер системный аналитик»',
    });
  });

  it('потолок интервью за окно — вариант не жмётся и подсказка не перечитывается; «Далее» жмётся (C2)', async () => {
    const getMessage = vi.fn(async () => prompt());
    const i = input({ canStart: false, getMessage });
    expect(await choiceStep(i)).toEqual({ kind: 'capped' });
    expect(i.press).not.toHaveBeenCalled();
    expect(getMessage).not.toHaveBeenCalled();

    const paging = input({ canStart: false, interviewed: OPTIONS.map(normalizeTitle) });
    expect(await choiceStep(paging)).toMatchObject({ kind: 'paged' });
    expect(paging.press).toHaveBeenCalledWith(10, 'Далее');
  });

  it('пока шла выдержка, подсказку поправили в «Спасибо за выбор…» — не нажимает, новое интервью', async () => {
    const i = input({ getMessage: async () => msg(10, CHOSEN) });
    const step = await choiceStep(i);
    expect(i.press).not.toHaveBeenCalled();
    expect(step).toMatchObject({ kind: 'done', started: true });
  });

  it('подсказку удалили или переписали во что-то другое — не нажимает', async () => {
    for (const current of [null, msg(10, 'Диалог завершён'), prompt(10, ['1. Да', '2. Нет', 'Далее'])]) {
      const i = input({ getMessage: async () => current });
      expect(await choiceStep(i)).toMatchObject({ kind: 'done', started: false });
      expect(i.press).not.toHaveBeenCalled();
    }
  });

  it('у свежей подсказки нет выбранной кнопки — ждать, решит следующий проход по новым кнопкам', async () => {
    const i = input({ getMessage: async () => prompt(10, ['4. Data analyst', '2. Системный аналитик']) });
    expect(await choiceStep(i)).toEqual({ kind: 'wait', until: 0 });
    expect(i.press).not.toHaveBeenCalled();
  });

  it('прямо перед нажатием в чате появилось новое — в этот проход не жмёт (M3)', async () => {
    const history = vi.fn(async () => [msg(11, 'Вы тут?')]);
    const i = input({ history });
    expect(await choiceStep(i)).toEqual({ kind: 'wait', until: 0 });
    expect(history).toHaveBeenCalledWith(10);
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

    const page2 = msg(10, PAGE2, { buttons: PAGE2_BUTTONS });
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
