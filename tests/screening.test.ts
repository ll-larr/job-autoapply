import { describe, it, expect } from 'vitest';
import { normalizeVacancy, type ExperienceLevel } from '../src/core/vacancy.js';
import {
  screenVacancy,
  isExperienceAcceptable,
  parseExperienceFromText,
  isSeniorTitle,
  is1cCentric,
  isJuniorExperience,
  JUNIOR_EXPERIENCE,
} from '../src/core/screening.js';

function v(over: Partial<Parameters<typeof normalizeVacancy>[0]> = {}) {
  return normalizeVacancy({
    source: 'hh',
    sourceId: 'x',
    title: 'Бизнес-аналитик',
    company: 'C',
    url: 'u',
    description: 'Собираем требования, пишем регламенты бизнес-процессов.',
    geo: 'Москва',
    postedAt: '2026-08-20T00:00:00Z',
    ...over,
  });
}

// ============================================================================
// experience
// ============================================================================

describe('isExperienceAcceptable', () => {
  it('пропускает noExperience и between1And3', () => {
    expect(isExperienceAcceptable('noExperience')).toBe(true);
    expect(isExperienceAcceptable('between1And3')).toBe(true);
  });

  it('отклоняет between3And6 и moreThan6', () => {
    expect(isExperienceAcceptable('between3And6')).toBe(false);
    expect(isExperienceAcceptable('moreThan6')).toBe(false);
  });

  it('неизвестное/непроставленное требование пропускает, а не режет', () => {
    expect(isExperienceAcceptable(null)).toBe(true);
  });

  it('второй параметр переопределяет допустимый набор бакетов', () => {
    const onlySenior = new Set<ExperienceLevel>(['moreThan6']);
    expect(isExperienceAcceptable('moreThan6', onlySenior)).toBe(true);
    expect(isExperienceAcceptable('noExperience', onlySenior)).toBe(false);
    // null по-прежнему проходит независимо от переданного набора.
    expect(isExperienceAcceptable(null, onlySenior)).toBe(true);
  });
});

// ============================================================================
// junior-only per-query constraint (config.json → searchQueries[].constraints)
// ============================================================================

describe('isJuniorExperience / JUNIOR_EXPERIENCE', () => {
  it('пропускает только noExperience — строже общего ACCEPTABLE_EXPERIENCE', () => {
    expect(isJuniorExperience('noExperience')).toBe(true);
  });

  it('отклоняет between1And3, хотя он проходит общий гейт isExperienceAcceptable', () => {
    expect(isExperienceAcceptable('between1And3')).toBe(true); // общий гейт: проходит
    expect(isJuniorExperience('between1And3')).toBe(false); // junior-only: не проходит
  });

  it('отклоняет between3And6 и moreThan6', () => {
    expect(isJuniorExperience('between3And6')).toBe(false);
    expect(isJuniorExperience('moreThan6')).toBe(false);
  });

  it('null (сигнал неизвестен) проходит — та же философия, что и общий гейт', () => {
    expect(isJuniorExperience(null)).toBe(true);
  });

  it('стажировки проходят: на hh.ru они структурно размечены как noExperience', () => {
    expect(isJuniorExperience('noExperience')).toBe(true);
    expect(JUNIOR_EXPERIENCE.has('noExperience')).toBe(true);
  });
});

describe('parseExperienceFromText — русские фразы, structured-сигнала нет', () => {
  it('"от 3 лет" — верхняя граница диапазона 1-3, проходит', () => {
    expect(parseExperienceFromText('Требуется опыт работы от 3 лет')).toBe('between1And3');
  });

  it('"от 5 лет" — выше диапазона, не проходит', () => {
    expect(parseExperienceFromText('Опыт работы от 5 лет в аналогичной роли')).toBe('between3And6');
  });

  it('"более 6 лет" — явно выше диапазона', () => {
    expect(parseExperienceFromText('Стаж более 6 лет')).toBe('moreThan6');
  });

  it('"3–6 лет" (диапазон) — потолок диапазона выше 3, не проходит', () => {
    expect(parseExperienceFromText('Ищем кандидата с опытом 3–6 лет')).toBe('between3And6');
  });

  it('"не менее 4 лет" — минимум выше 3', () => {
    expect(parseExperienceFromText('Опыт работы не менее 4 лет')).toBe('between3And6');
  });

  it('"опыт работы от ..." — общий шаблон с числом', () => {
    expect(parseExperienceFromText('опыт работы от 2 лет приветствуется')).toBe('between1And3');
  });

  it('без упоминания опыта — неизвестно (null), не гейт', () => {
    expect(parseExperienceFromText('Ищем внимательного и ответственного человека.')).toBeNull();
  });

  it('"без опыта" — явный ноль', () => {
    expect(parseExperienceFromText('Рассмотрим кандидатов без опыта работы')).toBe('noExperience');
  });

  it('"не более 6 лет" — это потолок-ограничение, а не требование минимума, проходит', () => {
    // "не более" ("no more than") — это разрешающая формулировка, противоположная
    // "не менее". Наивный regex на одно только "более" спутал бы их.
    expect(parseExperienceFromText('Опыт не более 6 лет — не критично')).toBeNull();
  });
});

describe('screenVacancy — experience', () => {
  it('отклоняет вакансию с between3And6 из структурного поля', () => {
    const r = screenVacancy(v({ experience: 'between3And6' }));
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.reason).toBe('experience');
  });

  it('пропускает between1And3 из структурного поля', () => {
    const r = screenVacancy(v({ experience: 'between1And3' }));
    expect(r.passed).toBe(true);
  });

  it('структурное поле имеет приоритет над текстом описания', () => {
    // Описание врёт про "от 10 лет", но структурный сигнал с hh — between1And3.
    const r = screenVacancy(v({
      experience: 'between1And3',
      description: 'Требуется опыт работы от 10 лет по ошибке редактора.',
    }));
    expect(r.passed).toBe(true);
  });

  it('без структурного поля — падает на разбор описания', () => {
    const r = screenVacancy(v({
      experience: null,
      description: 'Опыт работы от 8 лет обязателен. Собираем требования.',
    }));
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.reason).toBe('experience');
  });

  it('experience не проставлено и описание молчит про опыт — проходит', () => {
    const r = screenVacancy(v({ experience: null, description: 'Собираем требования, пишем регламенты.' }));
    expect(r.passed).toBe(true);
  });
});

// ============================================================================
// grade
// ============================================================================

describe('isSeniorTitle', () => {
  it('ловит "ведущий" в разных заголовках', () => {
    expect(isSeniorTitle('Ведущий бизнес-аналитик')).toBe(true);
    expect(isSeniorTitle('Ведущий специалист по оптимизации бизнес-процессов')).toBe(true);
  });

  it('ловит "директор" — "Управляющий директор по развитию эффективности сегментов"', () => {
    expect(isSeniorTitle('Управляющий директор по развитию эффективности сегментов')).toBe(true);
  });

  it('ловит "руководитель"', () => {
    expect(isSeniorTitle('Руководитель бизнес-аналитики')).toBe(true);
  });

  it('ловит "главный" и "начальник"', () => {
    expect(isSeniorTitle('Главный бизнес-аналитик')).toBe(true);
    expect(isSeniorTitle('Начальник отдела бизнес-анализа')).toBe(true);
  });

  it('ловит английские маркеры senior / lead / head of', () => {
    expect(isSeniorTitle('Senior Business Analyst')).toBe(true);
    expect(isSeniorTitle('Аналитик Senior')).toBe(true);
    expect(isSeniorTitle('Lead Business Analyst')).toBe(true);
    expect(isSeniorTitle('Head of Business Analysis')).toBe(true);
  });

  it('не ловит "дирекция" — это не заявка на грейд "директор"', () => {
    expect(isSeniorTitle('Бизнес-аналитик в дирекцию')).toBe(false);
    expect(isSeniorTitle('Стажер - бизнес-аналитик (Дирекция проблемных активов)')).toBe(false);
  });

  it('обычные junior/middle заголовки проходят', () => {
    expect(isSeniorTitle('Бизнес-аналитик')).toBe(false);
    expect(isSeniorTitle('Системный аналитик')).toBe(false);
    expect(isSeniorTitle('Junior Product Manager')).toBe(false);
    expect(isSeniorTitle('Fullstack-аналитик (middle+)')).toBe(false);
  });

  it('не ловит упоминание грейда в описании, только в заголовке', () => {
    // "работа с ведущими специалистами" в описании — это не заявка на лид-роль.
    const r = screenVacancy(v({
      title: 'Бизнес-аналитик',
      description: 'Тесная работа с ведущими специалистами команды.',
    }));
    expect(r.passed).toBe(true);
  });
});

describe('screenVacancy — grade', () => {
  it('отклоняет по грейду с причиной grade', () => {
    const r = screenVacancy(v({ title: 'Ведущий бизнес-аналитик' }));
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.reason).toBe('grade');
  });
});

// ============================================================================
// 1С
// ============================================================================

describe('is1cCentric', () => {
  it('заголовок "Аналитик 1С" — 1С в подлежащем, отклоняем', () => {
    expect(is1cCentric({ title: 'Аналитик 1С', description: '' })).toBe(true);
  });

  it('латинская "1C" в заголовке тоже считается', () => {
    expect(is1cCentric({ title: 'Программист 1C', description: '' })).toBe(true);
  });

  it('единичное упоминание 1С в списке систем — не центральная тема, проходит', () => {
    // Ровно случай из tests/fixtures/hh-search.html (карточка №5, БЦ Уралсиб):
    // "...ИТ-системы для логистических объектов ... и бэк-офиса (TOS.Solvo, 1С, ELMA...)"
    const description =
      'Развивать и внедрять ИТ-системы для логистических объектов ' +
      '(контейнерные терминалы, порты, складские комплексы) и бэк-офиса (TOS.Solvo, 1С, ELMA...).';
    expect(is1cCentric({ title: 'Бизнес-аналитик', description })).toBe(false);
  });

  it('многократные упоминания 1С в описании — центральная тема, отклоняем', () => {
    const description =
      'Опыт работы аналитиком 1С. Знание одной из конфигураций 1С. ' +
      'Линейка программных продуктов 1С для разработки модулей: 1С:ERP, 1С:Управление торговлей.';
    expect(is1cCentric({ title: 'Аналитик', description })).toBe(true);
  });

  it('не путает "1 сотрудник"/"1 секция" с 1С — цифра 1 плюс кириллическая "с" внутри слова', () => {
    const description = 'Ищем 1 сотрудника в команду из 5 секций для срочного проекта.';
    expect(is1cCentric({ title: 'Бизнес-аналитик', description })).toBe(false);
  });

  it('не путает "1С" внутри числа "21С" (например, температуры/индекса)', () => {
    const description = 'Индекс изделия 21С применяется только во внутренней документации.';
    expect(is1cCentric({ title: 'Бизнес-аналитик', description })).toBe(false);
  });

  it('BITRIX24 в заголовке не считается 1С (другой продукт)', () => {
    expect(is1cCentric({ title: 'Бизнес-аналитик (BITRIX24 / Разработка процессов)', description: '' })).toBe(false);
  });
});

describe('screenVacancy — 1С', () => {
  it('отклоняет 1С-центричную вакансию с причиной 1c', () => {
    const r = screenVacancy(v({ title: 'Аналитик 1С' }));
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.reason).toBe('1c');
  });

  it('пропускает вакансию, где 1С — одна из систем среди прочих', () => {
    const r = screenVacancy(v({
      title: 'Бизнес-аналитик',
      description: 'Работаем со стеком: SAP, 1С, Oracle, Bitrix24.',
    }));
    expect(r.passed).toBe(true);
  });
});

// ============================================================================
// комбинации / приоритет причин
// ============================================================================

describe('screenVacancy — обычная вакансия без нарушений проходит целиком', () => {
  it('passed: true, без reason', () => {
    const r = screenVacancy(v());
    expect(r).toEqual({ passed: true });
  });
});
