import { describe, it, expect } from 'vitest';
import { allowedNumbers, validateAnswer } from '../src/core/interview.js';

const allowed = allowedNumbers([
  'Сократил трудозатраты с 76 до 11 часов в месяц, на 85,5%',
  'Зарплатная вилка 280–360',
  'Расскажите про опыт с 2024 года',
]);

describe('validateAnswer', () => {
  it('пропускает ответ с числами из источников', () => {
    expect(validateAnswer('С 76 до 11 часов, это 85,5%, с 2024 года.', { allowed })).toBeNull();
  });

  it('режет выдуманное число', () => {
    expect(validateAnswer('Сократил примерно на 90%.', { allowed }))
      .toBe('выдуманное число: 90');
  });

  it('режет сдвинутый год', () => {
    expect(validateAnswer('Работал там с 2023 года.', { allowed }))
      .toBe('выдуманное число: 2023');
  });

  it('пустой ответ не годится', () => {
    expect(validateAnswer('   ', { allowed })).toBe('пустой ответ');
  });

  it('слишком длинный ответ не годится', () => {
    const long = 'а'.repeat(1501);
    expect(validateAnswer(long, { allowed })).toBe('длиннее 1500 символов');
  });

  it('режет маркер автомата', () => {
    expect(validateAnswer('Как языковая модель, я не могу ответить.', { allowed }))
      .toBe('маркер автомата');
  });

  it('режет утечку секрета', () => {
    expect(validateAnswer('Ключ sk-abcdefgh12345 лежит в .env', { allowed }))
      .toBe('в ответе ключ');
  });

  it('ММ.ГГГГ дата в ответе пропускает, если компоненты разрешены', () => {
    const allowedWithDateParts = allowedNumbers(['Пробел в занятости 07–12.2025']);
    expect(validateAnswer('Не было работы с 07.2025 по 12.2025.', { allowed: allowedWithDateParts }))
      .toBeNull();
  });

  it('число с хвостовыми нулями пропускает, если основание разрешено', () => {
    const allowedWithTrailing = allowedNumbers(['85,5%']);
    expect(validateAnswer('это 85,50%', { allowed: allowedWithTrailing }))
      .toBeNull();
  });

  it('сумма с разрядами «280 000» проходит, если в источнике та же сумма словами «280–360 тысяч» (H1)', () => {
    const withUnit = allowedNumbers(['Зарплатная вилка 280–360 тысяч']);
    expect(validateAnswer('Ожидаю от 280 000 до 360 000 рублей.', { allowed: withUnit })).toBeNull();
  });

  it('ноль больше не разрешён всегда: хвостом суммы он не бывает, а сам по себе — число (H1)', () => {
    expect(validateAnswer('Было 0 инцидентов.', { allowed })).toBe('выдуманное число: 0');
  });

  it('частые HTTP-коды разрешены всегда (I3)', () => {
    expect(validateAnswer('Проверял коды ответов 200, 400 и 500.', { allowed })).toBeNull();
    expect(validateAnswer('Разбирал 201, 204, 301, 302, 304, 401, 403, 404, 409, 422, 429, 502, 503 и 504.', { allowed }))
      .toBeNull();
  });

  it('число вне белого списка и вне HTTP-кодов по-прежнему режется', () => {
    expect(validateAnswer('Возвращал код 418.', { allowed })).toBe('выдуманное число: 418');
  });

  it('«Как ИИ» и «я бот» на кириллице ловятся: граница слова в JS-регэкспе только латинская (I4)', () => {
    expect(validateAnswer('Как ИИ, я отвечаю за кандидата.', { allowed })).toBe('маркер автомата');
    expect(validateAnswer('Отвечаю как ИИ', { allowed })).toBe('маркер автомата');
    expect(validateAnswer('Я бот, отвечаю за кандидата.', { allowed })).toBe('маркер автомата');
  });

  it('слово, которое лишь начинается с «бот», — не маркер (I4)', () => {
    expect(validateAnswer('Вчера я ботинки купил.', { allowed })).toBeNull();
    expect(validateAnswer('По первому образованию я ботаник.', { allowed })).toBeNull();
  });

  it('режет приписанный навык', () => {
    expect(validateAnswer('Писал JOIN и CTE каждый день.', { allowed }))
      .toMatch(/^выдуман навык:/);
  });
});

describe('validateAnswer: зарплата сверяется по величине (H1)', () => {
  // Настоящая строка data/facts.md владельца на 2026-09-26 и строка «как в резюме».
  const salary = allowedNumbers([
    'Зарплатная вилка: 180–260 тысяч рублей на руки. Конкретная цифра зависит от грейда.',
    'Опыт бизнес-анализа — 3 года, из них 1.5 года в Озон Банке, более 1 млн клиентов.',
    'Какие у вас зарплатные ожидания?',
  ]);

  it.each([
    'Ориентируюсь на 180–260 тысяч на руки.',
    'от 180 000 до 260 000 рублей',
    '180 тыс.',
    'коды ответов 200, 400 и 500',
  ])('правда проходит: «%s»', (answer) => {
    expect(validateAnswer(answer, { allowed: salary })).toBeNull();
  });

  it.each([
    ['Ожидаю от 400 000 рублей.', '400000'],
    ['Рассчитываю на 200–400 тысяч.', '200000'],
    ['Хочу 500 тысяч на руки.', '500000'],
    ['Ожидаю 3 000 000 в год.', '3000000'],
    ['3 млн', '3000000'],
  ])('выдуманная сумма режется: «%s»', (answer, number) => {
    expect(validateAnswer(answer, { allowed: salary })).toBe(`выдуманное число: ${number}`);
  });
});
