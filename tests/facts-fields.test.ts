import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { factFields, lookupFact, FACT_LABELS } from '../src/core/facts.js';

const sample = readFileSync('tests/fixtures/facts-sample.md', 'utf8');

describe('factFields', () => {
  const fields = factFields(sample);
  const byKey = (k: string) => fields.find((f) => f.key.startsWith(k));

  it('значение продолжается на следующих строках до нового поля или пустой строки', () => {
    expect(byKey('зарплатная вилка')?.value).toBe(
      '180–260 тысяч рублей на руки. Конкретная цифра зависит от грейда и состава пакета.',
    );
  });

  it('пустое поле остаётся пустым и не берёт значение соседнего', () => {
    expect(byKey('формат')?.value).toBe('');
    expect(byKey('готовность к переезду')?.value).toBe('нет');
  });

  it('заголовки и пустые строки полей не создают; ё в ключе заменено', () => {
    expect(fields.map((f) => f.key)).not.toContain('деньги');
    expect(byKey('годы учебы')?.value).toBe('2019-2023');
  });

  it('CRLF не мешает', () => {
    expect(factFields('Срок выхода: сразу\r\nФормат: гибрид\r\n').map((f) => f.value)).toEqual(['сразу', 'гибрид']);
  });
});

describe('lookupFact', () => {
  const fields = factFields(sample);

  it('находит поле по началу подписи: «Формат (офис, …)» по «Формат»', () => {
    const f = factFields('Формат (офис, гибрид, удалёнка): гибрид\n');
    expect(lookupFact(f, 'format')).toEqual([{ label: 'Формат', value: 'гибрид' }]);
  });

  it('пустое и отсутствующее поле — null', () => {
    expect(lookupFact(fields, 'format')).toEqual([{ label: 'Формат', value: null }]);
    expect(lookupFact(fields, 'military')).toEqual([{ label: 'Отношение к воинской обязанности', value: null }]);
  });

  it('образование — две строки', () => {
    expect(lookupFact(fields, 'education')).toEqual([
      { label: 'Вуз', value: 'Тестовый университет' },
      { label: 'Годы учёбы', value: '2019-2023' },
    ]);
  });

  it('у каждой темы есть хотя бы одна подпись', () => {
    for (const labels of Object.values(FACT_LABELS)) expect(labels.length).toBeGreaterThan(0);
  });
});
