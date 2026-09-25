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
    expect([...n].sort()).toEqual(['04', '09', '2024', '280', '360']);
  });

  it('числительные словами не считаются числами', () => {
    expect(extractNumbers('три вещи и две части').size).toBe(0);
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
