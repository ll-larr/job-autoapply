import { describe, it, expect } from 'vitest';
import { buildSearchUrl } from '../src/adapters/hh.js';
import { DEFAULT_FILTERS, type VacancyFilters } from '../src/core/specialty.js';

/**
 * URL поиска hh.ru с фильтром специальности (редизайн настроек 2026-11-19).
 * Отдельно от tests/hh.test.ts: там поднимается браузер, а здесь чистая функция.
 */

describe('buildSearchUrl — без фильтра', () => {
  it('без фильтра и с пустым фильтром URL байт-в-байт прежний', () => {
    const before = 'https://hh.ru/search/vacancy?text=%D0%B1%D0%B8%D0%B7%D0%BD%D0%B5%D1%81-%D0%B0%D0%BD%D0%B0%D0%BB%D0%B8%D1%82%D0%B8%D0%BA&area=1&page=2&items_on_page=100';
    expect(buildSearchUrl('бизнес-аналитик', 2)).toBe(before);
    expect(buildSearchUrl('бизнес-аналитик', 2, DEFAULT_FILTERS)).toBe(before);
  });
});

describe('buildSearchUrl — фильтр специальности', () => {
  const F = (over: Partial<VacancyFilters>): VacancyFilters => ({ ...DEFAULT_FILTERS, ...over });
  const params = (f: VacancyFilters) => new URL(buildSearchUrl('q', 0, f)).searchParams;
  /** Всё, кроме базовых text/area/page/items_on_page — чтобы видеть и лишнее. */
  const extra = (f: VacancyFilters) => [...params(f).entries()]
    .filter(([k]) => !['text', 'area', 'page', 'items_on_page'].includes(k));

  it('зарплата «от» — salary; «до» в URL не идёт (у hh нет такого параметра)', () => {
    expect(extra(F({ salaryFrom: 150000, salaryTo: 300000 }))).toEqual([['salary', '150000']]);
    expect(extra(F({ salaryTo: 300000 }))).toEqual([]);
  });

  it('снятое «Не указана» — only_with_salary=true', () => {
    expect(extra(F({ includeNoSalary: false }))).toEqual([['only_with_salary', 'true']]);
    expect(extra(F({ includeNoSalary: true }))).toEqual([]);
  });

  it('формы занятости — повторяющийся employment_form', () => {
    expect(params(F({ employment: ['FULL', 'PART', 'PROJECT'] })).getAll('employment_form')).toEqual(['FULL', 'PART', 'PROJECT']);
    expect(extra(F({ employment: ['PART'] }))).toEqual([['employment_form', 'PART']]);
  });

  it('только стажировка — label=internship', () => {
    expect(extra(F({ employment: ['INTERNSHIP'] }))).toEqual([['label', 'internship']]);
  });

  it('стажировка вместе с другими формами — без метки (И сузило бы до одних стажировок)', () => {
    expect(extra(F({ employment: ['INTERNSHIP', 'FULL'] }))).toEqual([['employment_form', 'FULL']]);
    expect(extra(F({ employment: ['PART', 'INTERNSHIP', 'PROJECT'] })))
      .toEqual([['employment_form', 'PART'], ['employment_form', 'PROJECT']]);
  });

  it('оформление: трудовой — метка, ГПХ — accept_temporary, оба — ничего', () => {
    expect(extra(F({ contract: ['LABOR'] }))).toEqual([['label', 'accept_labor_contract']]);
    expect(extra(F({ contract: ['GPH'] }))).toEqual([['accept_temporary', 'true']]);
    expect(extra(F({ contract: ['LABOR', 'GPH'] }))).toEqual([]);
  });

  it('стажировка и трудовой договор — две метки разом', () => {
    expect(params(F({ employment: ['INTERNSHIP'], contract: ['LABOR'] })).getAll('label'))
      .toEqual(['internship', 'accept_labor_contract']);
  });

  it('график — повторяющийся work_schedule_by_days', () => {
    expect(extra(F({ schedule: ['FIVE_ON_TWO_OFF', 'WEEKEND'] })))
      .toEqual([['work_schedule_by_days', 'FIVE_ON_TWO_OFF'], ['work_schedule_by_days', 'WEEKEND']]);
  });

  it('рабочие часы — working_hours', () => {
    expect(extra(F({ workingHours: 'HOURS_8' }))).toEqual([['working_hours', 'HOURS_8']]);
    expect(extra(F({ workingHours: 'FLEXIBLE' }))).toEqual([['working_hours', 'FLEXIBLE']]);
  });

  it('формат — повторяющийся work_format', () => {
    expect(extra(F({ workFormat: ['REMOTE', 'HYBRID'] }))).toEqual([['work_format', 'REMOTE'], ['work_format', 'HYBRID']]);
  });

  it('всё вместе — базовые параметры на месте, опыт в URL не идёт', () => {
    const p = params(F({
      salaryFrom: 100000, includeNoSalary: false, employment: ['FULL'], contract: ['GPH'],
      schedule: ['FLEXIBLE'], workingHours: 'HOURS_6', workFormat: ['ON_SITE'],
    }));
    expect(p.get('text')).toBe('q');
    expect(p.get('items_on_page')).toBe('100');
    expect(p.has('experience')).toBe(false);
    expect(p.get('salary')).toBe('100000');
    expect(p.get('only_with_salary')).toBe('true');
    expect(p.get('employment_form')).toBe('FULL');
    expect(p.get('accept_temporary')).toBe('true');
    expect(p.get('work_schedule_by_days')).toBe('FLEXIBLE');
    expect(p.get('working_hours')).toBe('HOURS_6');
    expect(p.get('work_format')).toBe('ON_SITE');
  });
});
