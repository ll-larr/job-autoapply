import { describe, it, expect } from 'vitest';
import {
  socialKind, isCvRequest, factTopics, isFactsOnly, isYes, isNo, pickOfferedSlot, meetingSignal, countDates,
  normalizeForRules,
} from '../src/bot/secretary-intents.js';
import type { ChatMode } from '../src/bot/state.js';

/** Пятница, 9 октября 2026, 12:00 — «сейчас» для всех проверок встреч. */
const NOW = new Date(2026, 9, 9, 12, 0, 0, 0);
const idle: { mode: ChatMode; hasMeeting: boolean } = { mode: 'idle', hasMeeting: false };

describe('normalizeForRules', () => {
  it('нижний регистр, ё → е, неразрывные пробелы, схлопнутые пробелы', () => {
    expect(normalizeForRules('  Ёлка  НА   Столе ')).toBe('елка на столе');
  });
});

describe('socialKind', () => {
  it.each([
    ['Привет!', 'greeting'],
    ['Здравствуйте', 'greeting'],
    ['Добрый день!', 'greeting'],
    ['Доброго времени суток', 'greeting'],
    ['Спасибо большое 🙏', 'thanks'],
    ['Спасибо за информацию', 'thanks'],
    ['Благодарю!', 'thanks'],
    ['Хорошего дня!', 'bye'],
    ['До свидания', 'bye'],
    ['Спасибо, до связи', 'bye'],
    ['ок', 'ack'],
    ['Понял, принято', 'ack'],
    ['👍', 'ack'],
    ['Хорошо, спасибо', 'thanks'],
  ])('«%s» — %s', (text, kind) => {
    expect(socialKind(text)).toBe(kind);
  });

  it.each([
    'Привет, спасибо за сообщение!',
    'Привет, а какая зарплата?',
    'Добрый день, расскажите про опыт',
    'Пока не знаю, подумаю',
    'Хорошо, пришлите резюме',
    'Спасибо, посмотрю и вернусь с ответом',
    '',
    '???',
  ])('«%s» — не социальное', (text) => {
    expect(socialKind(text)).toBeNull();
  });
});

describe('isCvRequest', () => {
  it.each([
    'скинь резюме',
    'Пришлите, пожалуйста, ваше резюме',
    'резюме?',
    'а резюме',
    'А CV есть?',
    'можно резюме',
    'Жду резюме',
    'отправьте ваше cv на почту',
    'Хочу посмотреть резюме',
    'Резюме актуальное?',
  ])('«%s» — просьба о резюме', (text) => {
    expect(isCvRequest(text)).toBe(true);
  });

  it.each([
    'получил резюме, спасибо',
    'в резюме написано про SQL',
    'по резюме вопросов нет',
    'Посмотрел резюме, интересно',
    'Расскажите об опыте',
    'Какая зарплата?',
  ])('«%s» — не просьба', (text) => {
    expect(isCvRequest(text)).toBe(false);
  });
});

describe('factTopics', () => {
  it.each([
    ['Какая у вас зарплатная вилка?', ['salary']],
    ['Когда можете выйти на работу? Работа удаленная?', ['start', 'format']],
    ['Готовы к переезду?', ['relocation']],
    ['Есть гражданство РФ?', ['citizenship']],
    ['Где вы живёте?', ['city']],
    ['Какой уровень английского?', ['english']],
    ['Есть отсрочка от армии?', ['military']],
    ['Где учились? Какой вуз?', ['education']],
    ['Сделаете тестовое задание?', ['test']],
    ['Расскажите про опыт', []],
  ])('«%s»', (text, topics) => {
    expect(factTopics(text)).toEqual(topics);
  });
});

describe('isFactsOnly', () => {
  it('только вопросы о фактах — да', () => {
    expect(isFactsOnly('Какая зарплата?')).toBe(true);
    expect(isFactsOnly('Привет! Какая зарплата и когда сможете выйти?')).toBe(true);
  });
  it('факт вместе с вопросом по существу, голая вежливость, длинный текст — нет', () => {
    expect(isFactsOnly('Какая зарплата? Расскажите про проект')).toBe(false);
    expect(isFactsOnly('Привет')).toBe(false);
    expect(isFactsOnly(`Какая зарплата? ${'а'.repeat(310)}`)).toBe(false);
  });
});

describe('isYes / isNo', () => {
  it('да', () => {
    for (const t of ['да', 'Да, верно', 'ага', 'ок', 'Давай', 'yes']) expect(isYes(t)).toBe(true);
    for (const t of ['нет', 'Не то', 'ладно, подумаю', 'датаbase']) expect(isYes(t)).toBe(false);
  });
  it('нет', () => {
    for (const t of ['нет', 'Не то', 'неверно', 'не так']) expect(isNo(t)).toBe(true);
    for (const t of ['да', 'нетерпеливо ждем']) expect(isNo(t)).toBe(false);
  });
});

describe('pickOfferedSlot', () => {
  const slots = [new Date(2026, 9, 12, 11, 0), new Date(2026, 9, 13, 15, 0), new Date(2026, 9, 14, 17, 0)].map((d) => d.getTime());
  const clockOf = (ms: number): { hour: number; minute: number } => ({ hour: new Date(ms).getHours(), minute: new Date(ms).getMinutes() });
  const pick = (t: string): number | null => pickOfferedSlot(t, slots, clockOf);

  it('порядковые слова и цифры', () => {
    expect(pick('первый')).toBe(slots[0]);
    expect(pick('Второй вариант')).toBe(slots[1]);
    expect(pick('3')).toBe(slots[2]);
    expect(pick('вариант 2')).toBe(slots[1]);
    expect(pick('3й')).toBe(slots[2]);
  });
  it('«любой» — первый', () => {
    expect(pick('любой')).toBe(slots[0]);
  });
  it('час, совпавший ровно с одним слотом', () => {
    expect(pick('в 15')).toBe(slots[1]);
    expect(pick('17:00 подойдёт')).toBe(slots[2]);
    expect(pick('давайте в 11')).toBe(slots[0]);
  });
  it('непонятно — null', () => {
    expect(pick('в 14')).toBeNull();
    expect(pick('не знаю')).toBeNull();
    expect(pick('')).toBeNull();
    expect(pickOfferedSlot('второй', [], clockOf)).toBeNull();
  });
});

describe('countDates', () => {
  it('дни недели, завтра, именованные и числовые даты', () => {
    expect(countDates('в среду не могу, давай в четверг')).toBe(2);
    expect(countDates('завтра или послезавтра')).toBe(2);
    expect(countDates('10 октября и 11.10')).toBe(2);
    expect(countDates('в 15.30')).toBe(0);
    expect(countDates('привет')).toBe(0);
  });
});

describe('meetingSignal', () => {
  const sig = (text: string, ctx: Partial<typeof idle> = {}) => meetingSignal(text, NOW, { ...idle, ...ctx });

  it('«давай созвонимся завтра в 15» — запись', () => {
    const s = sig('давай созвонимся завтра в 15');
    expect(s.kind).toBe('confirmed');
    if (s.kind === 'confirmed') {
      expect(s.reschedule).toBe(false);
      expect(s.at.getTime()).toBe(new Date(2026, 9, 10, 15, 0).getTime());
    }
  });
  it('«Собеседование 10.10 в 15:00» и «Позвоним 3 ноября в 11:30» — запись', () => {
    expect(sig('Собеседование 10.10 в 15:00').kind).toBe('confirmed');
    expect(sig('Позвоним 3 ноября в 11:30').kind).toBe('confirmed');
  });
  it('время без слов о встрече — переспрос', () => {
    expect(sig('завтра в 15').kind).toBe('ask_confirm');
  });
  it('описание вакансии и опыт — не встреча', () => {
    expect(sig('Вакансия открыта до 15 октября, собеседования в zoom').kind).toBe('none');
    expect(sig('Опыт от 3 лет').kind).toBe('none');
    expect(sig('вчера в 15 созванивались').kind).toBe('none');
    expect(sig(`собеседование ${'слово '.repeat(90)}`).kind).toBe('none');
  });
  it('«до 15:00 пришли резюме» — времени встречи нет (резюме разберёт своё правило)', () => {
    expect(sig('до 15:00 пришли резюме').kind).toBe('none');
  });
  it('две даты и отрицание — просим назвать одно время', () => {
    expect(sig('в среду не могу, давай в четверг в 15').kind).toBe('ambiguous');
    expect(sig('созвонимся в среду или в четверг?').kind).toBe('ambiguous');
  });
  it('«перенесём на пятницу в 12» — запись с переносом', () => {
    const s = sig('перенесём на пятницу в 12', { hasMeeting: true });
    expect(s.kind).toBe('confirmed');
    if (s.kind === 'confirmed') expect(s.reschedule).toBe(true);
  });
  it('отмена без нового времени — declined, но только в разговоре о встрече', () => {
    expect(sig('отменяем собеседование').kind).toBe('declined');
    expect(sig('не получится завтра', { hasMeeting: true }).kind).toBe('declined');
    expect(sig('не могу найти ваше резюме').kind).toBe('none');
  });
  it('дата без времени — спрашиваем время, день называем так, как его назвали', () => {
    expect(sig('позвоню завтра')).toEqual({ kind: 'need_time', day: 'завтра' });
    expect(sig('Хотим пригласить вас на собеседование, удобно в четверг?')).toEqual({ kind: 'need_time', day: 'в четверг' });
    expect(sig('в пятницу', { mode: 'await_time' })).toEqual({ kind: 'need_time', day: 'в пятницу' });
  });
  it('в режиме ожидания времени одно «в четверг в 15» — запись', () => {
    expect(sig('в четверг в 15', { mode: 'await_time' }).kind).toBe('confirmed');
  });
  it('прошедшее время при разговоре о встрече — past', () => {
    expect(sig('встреча 9 октября в 9:00').kind).toBe('past');
  });
  it('«когда удобно созвониться?» — просьба о слотах', () => {
    expect(sig('когда удобно созвониться?').kind).toBe('ask_slots');
    expect(sig('Предложите время для созвона').kind).toBe('ask_slots');
  });
  it('«Когда сможете выйти на работу?» — вопрос о сроке выхода, а не о времени встречи', () => {
    expect(sig('Когда сможете выйти на работу?').kind).toBe('none');
  });
  it('обычный вопрос — ничего', () => {
    expect(sig('Расскажите про опыт с BPMN?').kind).toBe('none');
  });
});
