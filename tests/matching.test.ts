import { describe, it, expect } from 'vitest';
import { compileTerm, containsTerm, countTerm, normalizeForMatch } from '../src/core/matching.js';

describe('normalizeForMatch', () => {
  it('нижний регистр, ё → е, латинские двойники → кириллица', () => {
    expect(normalizeForMatch('Ёлка 1C TЗ')).toBe('елка 1с тз');
  });

  it('длина строки не меняется — позиции совпадений остаются честными', () => {
    const s = 'Бизнес-аналитик BPMN 2.0, ClickHouse';
    expect(normalizeForMatch(s)).toHaveLength(s.length);
  });
});

describe('containsTerm — слово совпадает с начала слова', () => {
  it.each([
    ['битрикс', 'Интегратор Битрикс24', true],
    ['битрикс', 'опыт с 1С-Битрикс', true],
    ['битрикс', 'ребитрикс', false],
    ['регламент', 'пишем регламенты', true],
    ['аналитик', 'Бизнес-аналитик', true],
    ['аналитик', 'BI-аналитика', true],
    ['задач', 'ставим задачи', true],
  ])('%s в «%s» → %s', (term, text, expected) => {
    expect(containsTerm(text, term)).toBe(expected);
  });
});

describe('containsTerm — кириллическое слово от 5 букв теряет гласное окончание', () => {
  it.each([
    ['процессная модель', 'строим процессную модель', true],
    ['процессная модель', 'описание процессной модели', true],
    ['постановка задач', 'отвечает за постановку задач', true],
    ['функциональные требования', 'сбор функциональных требований', true],
    ['оптимизация процесс*', 'занимаемся оптимизацией процессов', true],
  ])('%s в «%s» → %s', (term, text, expected) => {
    expect(containsTerm(text, term)).toBe(expected);
  });
});

describe('containsTerm — короткие слова и аббревиатуры только целиком', () => {
  it.each([
    ['SQL', 'знание SQL и Excel', true],
    ['SQL', 'PostgreSQL', false],
    ['ТЗ', 'пишем ТЗ для разработки', true],
    ['ТЗ', 'метатзисы', false],
    ['REST', 'интеграции REST API', true],
    ['REST', 'restrictions apply', false],
    ['REST', 'RESTful', false],
    ['1С', 'Аналитик 1C', true],
    ['1С', '1С:Предприятие', true],
    ['1С', '1С-Битрикс', true],
    ['1С', 'в команде 1 сотрудник', false],
    ['1С', 'температура 21С', false],
    ['A/B', 'проводим A/B-тесты', true],
    ['BA', 'BA / SA', true],
    ['BA', 'Basis', false],
  ])('%s в «%s» → %s', (term, text, expected) => {
    expect(containsTerm(text, term)).toBe(expected);
  });
});

describe('containsTerm — * и фразы', () => {
  it('* — любые буквы дальше, окончание не отрезается', () => {
    expect(containsTerm('пишем user stories', 'user stor*')).toBe(true);
    expect(containsTerm('юнит-экономика продукта', 'юнит-эконом*')).toBe(true);
  });

  it('пробел во фразе — любые пробелы; дефис — только дефис или тире', () => {
    expect(containsTerm('бизнес   процессы', 'бизнес процесс')).toBe(true);
    expect(containsTerm('бизнес-процессы', 'бизнес процесс')).toBe(false);
    expect(containsTerm('бизнес-процессы', 'бизнес-процесс')).toBe(true);
    expect(containsTerm('бизнес–процессы', 'бизнес-процесс')).toBe(true);
    expect(containsTerm('модель TO-BE', 'TO-BE')).toBe(true);
    expect(containsTerm('ability to be proactive', 'TO-BE')).toBe(false);
    expect(containsTerm('отчёты в Power BI', 'Power BI')).toBe(true);
  });
});

describe('countTerm', () => {
  it('считает непересекающиеся вхождения', () => {
    expect(countTerm('1С, 1C и снова 1С:ERP', '1С')).toBe(3);
    expect(countTerm('ничего', '1С')).toBe(0);
  });
});

describe('compileTerm', () => {
  it('пустой терм — null, а не регэксп, совпадающий со всем', () => {
    expect(compileTerm('   ')).toBeNull();
    expect(containsTerm('любой текст', '  ')).toBe(false);
    expect(countTerm('любой текст', '')).toBe(0);
  });
});
