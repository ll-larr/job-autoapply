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
