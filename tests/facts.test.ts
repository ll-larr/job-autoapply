import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractNumbers, readFacts } from '../src/core/facts.js';

describe('extractNumbers', () => {
  it('собирает целые, дробные и проценты', () => {
    const n = extractNumbers('сократил с 76 до 11 часов, это 85,5% и 87.5 процента');
    expect(n.has('76')).toBe(true);
    expect(n.has('11')).toBe(true);
    expect(n.has('85.5')).toBe(true);
    expect(n.has('87.5')).toBe(true);
  });

  it('запятая и точка в дробях — одно и то же число', () => {
    expect(extractNumbers('85,5').has('85.5')).toBe(true);
  });

  it('годы и диапазоны разбираются на числа', () => {
    const n = extractNumbers('с 04/2024 по 09/2024, вилка 280–360');
    expect([...n].sort()).toEqual(['2024', '280', '360', '4', '9']);
  });

  it('точечные даты ММ.ГГГГ разбираются на месяц и год отдельно', () => {
    expect(extractNumbers('07.2025').has('7')).toBe(true);
    expect(extractNumbers('07.2025').has('2025')).toBe(true);
    expect(extractNumbers('07.2025').size).toBe(2);
  });

  it('точечные даты ДД.ММ.ГГГГ разбираются на день, месяц и год отдельно', () => {
    const n = extractNumbers('12.10.2025');
    expect(n.has('12')).toBe(true);
    expect(n.has('10')).toBe(true);
    expect(n.has('2025')).toBe(true);
    expect(n.size).toBe(3);
  });

  it('хвостовые нули в дробях отсекаются', () => {
    expect(extractNumbers('85,50').has('85.5')).toBe(true);
    expect(extractNumbers('85,50').has('85.50')).toBe(false);
  });

  it('числительные словами не считаются числами', () => {
    expect(extractNumbers('три вещи и две части').size).toBe(0);
  });

  it('точечные десятичные дроби не путаются с датами', () => {
    expect(extractNumbers('Точность 87.5024 процента').has('87.5024')).toBe(true);
    expect(extractNumbers('Точность 87.5024 процента').has('5024')).toBe(false);
  });

  it('короткие дроби вида 1.2345 не путаются с датами', () => {
    expect(extractNumbers('курс 1.2345').has('1.2345')).toBe(true);
    expect(extractNumbers('курс 1.2345').has('2345')).toBe(false);
  });

  it('число с несуществующим месяцем не разбивается', () => {
    const n = extractNumbers('13.2025');
    expect(n.has('13.2025')).toBe(true);
    expect(n.has('13')).toBe(false);
    expect(n.has('2025')).toBe(false);
  });

  it('длинные последовательности цифр не теряют точность', () => {
    expect(extractNumbers('12345678901234567890').has('12345678901234567890')).toBe(true);
    expect(extractNumbers('12345678901234567891').has('12345678901234567891')).toBe(true);
  });

  it('ведущие нули отсекаются правильно', () => {
    expect(extractNumbers('007').has('7')).toBe(true);
    expect(extractNumbers('007').has('007')).toBe(false);
  });

  it('ноль остаётся нулём', () => {
    expect(extractNumbers('0').has('0')).toBe(true);
    expect(extractNumbers('0').size).toBe(1);
  });

  it('9.00 становится 9', () => {
    expect(extractNumbers('9.00').has('9')).toBe(true);
    expect(extractNumbers('9.00').has('9.00')).toBe(false);
  });
});

// Суммы должны сравниваться по величине, а не по кускам (H1): «400 000»
// раньше распадалось на 400 и 0, и выдуманная зарплата проходила валидатор.
const sorted = (s: string): string[] => [...extractNumbers(s)].sort();

describe('extractNumbers: разряды через пробел — одно число (H1)', () => {
  it('«180 000» — это 180000, а не 180 и 0', () => {
    expect(sorted('180 000')).toEqual(['180000']);
  });

  it('несколько разрядов: «3 000 000» — 3000000', () => {
    expect(sorted('Ожидаю 3 000 000 в год.')).toEqual(['3000000']);
  });

  it('неразрывный и узкий неразрывный пробел — тоже разделитель разрядов', () => {
    expect(sorted('180\u00A0000 и 260\u202F000')).toEqual(['180000', '260000']);
  });

  it('диапазон из сумм с разрядами — два полных числа', () => {
    expect(sorted('от 180 000 до 260 000 рублей')).toEqual(['180000', '260000']);
    expect(sorted('180 000–260 000')).toEqual(['180000', '260000']);
  });

  it('год и следом трёхзначное число не склеиваются: «2024 200»', () => {
    expect(sorted('в 2024 200 задач')).toEqual(['200', '2024']);
  });

  it('первая группа не откусывается от длинного числа: «12024 200» — два числа', () => {
    expect(sorted('12024 200')).toEqual(['12024', '200']);
  });

  it('группа не из трёх цифр не приклеивается: «180 00» и «1 5»', () => {
    expect(sorted('180 00')).toEqual(['0', '180']);
    expect(sorted('1 5')).toEqual(['1', '5']);
  });

  it('список через запятую не склеивается: «200, 400 и 500»', () => {
    expect(sorted('коды ответов 200, 400 и 500')).toEqual(['200', '400', '500']);
  });

  it('дробная часть после разрядов остаётся при числе: «1 234,50» — 1234.5', () => {
    expect(sorted('1 234,50')).toEqual(['1234.5']);
  });

  it('ведущие нули первой группы отсекаются, как у любого целого', () => {
    expect(sorted('00 500')).toEqual(['500']);
  });

  it('длинный ряд разрядов не теряет точность', () => {
    expect(sorted('123 456 789 012 345 678 901')).toEqual(['123456789012345678901']);
  });
});

describe('extractNumbers: множители тысяч и миллионов (H1)', () => {
  it('«500 тысяч» — и 500, и 500000', () => {
    expect(sorted('Хочу 500 тысяч на руки.')).toEqual(['500', '500000']);
  });

  it('все формы тысяч: тысяча, тысячи, тысяч, тысячу, тыс, тыс., т.р., т. р., к, k', () => {
    for (const s of [
      '1 тысяча', '2 тысячи', '5 тысяч', 'на 1 тысячу', '180 тыс', '180 тыс.', '180 т.р.', '180 т. р.',
      '180к', '180 к', '180k', '180 K', '180 Тыс.', '180 ТЫСЯЧ',
    ]) {
      const n = extractNumbers(s);
      const raw = s.match(/\d+/)![0];
      expect([...n].sort(), s).toEqual([raw, `${raw}000`].sort());
    }
  });

  it('все формы миллионов: миллион, миллиона, миллионов, млн, млн.', () => {
    expect(sorted('1 миллион')).toEqual(['1', '1000000']);
    expect(sorted('2 миллиона')).toEqual(['2', '2000000']);
    expect(sorted('5 миллионов')).toEqual(['5', '5000000']);
    expect(sorted('3 млн')).toEqual(['3', '3000000']);
    expect(sorted('3 млн.')).toEqual(['3', '3000000']);
    expect(sorted('более 1 млн клиентов')).toEqual(['1', '1000000']);
  });

  it('диапазон с единицей — единица на оба конца: «180–260 тысяч»', () => {
    expect(sorted('Зарплатная вилка: 180–260 тысяч рублей на руки.'))
      .toEqual(['180', '180000', '260', '260000']);
  });

  it('любое тире и дефис, с пробелами и без, и «до» тоже задают диапазон', () => {
    for (const s of ['180-260 тыс.', '180 — 260 тыс.', '180 – 260 тыс.', '180−260 тыс.', 'от 180 до 260 тыс.']) {
      expect(sorted(s), s).toEqual(['180', '180000', '260', '260000']);
    }
  });

  it('дробь с единицей умножается текстом: «1,5 млн» — 1.5 и 1500000, «85,5 тыс.» — 85500', () => {
    expect(sorted('1,5 млн')).toEqual(['1.5', '1500000']);
    expect(sorted('85,5 тыс.')).toEqual(['85.5', '85500']);
    expect(sorted('0,25 тыс.')).toEqual(['0.25', '250']);
    expect(sorted('1.23456 тыс.')).toEqual(['1.23456', '1234.56']);
  });

  it('разряды и единица вместе: «1 500 тысяч» — 1500 и 1500000', () => {
    expect(sorted('1 500 тысяч')).toEqual(['1500', '1500000']);
  });

  it('умножение без Number(): длинное число с единицей не теряет точность', () => {
    expect(sorted('12345678901234567891 тыс.')).toEqual(['12345678901234567891', '12345678901234567891000']);
  });

  it('слово, лишь начинающееся с «к» или «т», — не единица: «5 кандидатов», «3 тысячелетия» нет', () => {
    expect(sorted('5 кандидатов')).toEqual(['5']);
    expect(sorted('k8s на 3 kubelet')).toEqual(['3', '8']);
    expect(sorted('4 т.е. четыре')).toEqual(['4']);
    expect(sorted('3 тысячелетия')).toEqual(['3']);
  });

  it('единица после даты не множит компоненты даты', () => {
    expect(sorted('с 07.2025 тысячи задач')).toEqual(['2025', '7']);
  });

  it('единица без числа перед ней не даёт ничего', () => {
    expect(sorted('несколько тысяч')).toEqual([]);
  });
});

describe('readFacts', () => {
  it('читает файл и собирает из него числа', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-'));
    const p = join(dir, 'facts.md');
    writeFileSync(p, 'Зарплатная вилка: 280–360 тысяч на руки.', 'utf8');
    const f = readFacts(p);
    expect(f.text).toContain('280');
    expect(f.numbers.has('360')).toBe(true);
  });

  it('файла нет — пустые факты, не исключение', () => {
    const f = readFacts(join(tmpdir(), 'нет-такого-файла.md'));
    expect(f.text).toBe('');
    expect(f.numbers.size).toBe(0);
  });
});
