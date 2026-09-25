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
});
