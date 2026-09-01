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
  isAnalystTitle,
  isInternshipTitle,
  isAboveJuniorTitle,
  isBitrixCentric,
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

describe('screenVacancy — платформы, которыми владелец не владеет', () => {
  it('отклоняет 1С-центричную вакансию с причиной platform', () => {
    const r = screenVacancy(v({ title: 'Аналитик 1С' }));
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.reason).toBe('platform');
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


/**
 * Правила, выведенные из разбора отменённых вакансий 2026-09-01. Каждый
 * заголовок ниже — настоящий, из очереди: владелец их отменил и назвал
 * причину. Проверяем не абстракции, а ровно те случаи, которые прошли фильтры
 * и не должны были.
 */
describe('правила по разбору отменённых 2026-09-01', () => {
  describe('Битрикс — платформа, которой владелец не владеет', () => {
    it('отсекает «Системный аналитик Bitrix24» по заголовку', () => {
      const r = screenVacancy(v({ title: 'Системный аналитик Bitrix24' }));
      expect(r.passed).toBe(false);
      if (!r.passed) expect(r.reason).toBe('platform');
    });

    it('отсекает «Интегратор/аналитик Битрикс24» — кириллицей тоже', () => {
      expect(screenVacancy(v({ title: 'Интегратор/аналитик Битрикс24' })).passed).toBe(false);
    });

    it('отсекает по описанию, когда вакансия про Битрикс, а заголовок молчит', () => {
      expect(isBitrixCentric(v({
        title: 'Системный аналитик',
        description: 'Портал на Битрикс24, дорабатываем Битрикс под задачи заказчика.',
      }))).toBe(true);
    });

    it('НЕ отсекает вакансию, где Битрикс упомянут единожды среди систем', () => {
      // Тот же принцип, что у 1С: одно упоминание в перечислении систем —
      // не повод считать вакансию про эту платформу.
      expect(isBitrixCentric(v({
        title: 'Бизнес-аналитик',
        description: 'Интеграции: SAP, Битрикс24, самописная CRM, шина данных.',
      }))).toBe(false);
    });
  });

  describe('заголовок обязан называть аналитика', () => {
    it('отсекает «Менеджер по операционному консалтингу»', () => {
      // Скор у неё был проходной: процессная лексика в описании честно есть.
      // Гейт отвечает на другой вопрос — кем зовут, а не чем занимаются.
      const r = screenVacancy(v({ title: 'Менеджер по операционному консалтингу' }));
      expect(r.passed).toBe(false);
      if (!r.passed) expect(r.reason).toBe('not_analyst');
    });

    it('отсекает «Менеджер по повышению эффективности бизнеса (направление lean)»', () => {
      expect(isAnalystTitle('Менеджер по повышению эффективности бизнеса (направление lean)')).toBe(false);
    });

    it('отсекает «Управляющий директор по развитию эффективности сегментов»', () => {
      expect(isAnalystTitle('Управляющий директор по развитию эффективности сегментов')).toBe(false);
    });

    it('пропускает настоящие аналитические заголовки из очереди', () => {
      for (const t of [
        'Бизнес-аналитик',
        'Системный аналитик',
        'Старший ИТ аналитик',
        'Аналитик проектного отдела',
        'Бизнес-аналитик / Специалист по моделированию',
        'Customer Business Analyst',
      ]) {
        expect(isAnalystTitle(t), t).toBe(true);
      }
    });
  });

  describe('стажировки', () => {
    it('отсекает «Аналитик внедрения-стажер»', () => {
      const r = screenVacancy(v({ title: 'Аналитик внедрения-стажер' }));
      expect(r.passed).toBe(false);
      if (!r.passed) expect(r.reason).toBe('internship');
    });

    it('ловит и «стажёр» через ё, и латиницу', () => {
      expect(isInternshipTitle('Стажёр-аналитик')).toBe(true);
      expect(isInternshipTitle('Analyst Intern')).toBe(true);
      expect(isInternshipTitle('Trainee Business Analyst')).toBe(true);
    });

    it('не считает стажировкой обычную вакансию', () => {
      expect(isInternshipTitle('Бизнес-аналитик')).toBe(false);
    });
  });

  describe('грейд выше junior — только для запросов juniorOnly', () => {
    it('«Старший системный аналитик» считается выше junior', () => {
      expect(isAboveJuniorTitle('Старший системный аналитик')).toBe(true);
    });

    it('«Старший ИТ аналитик» тоже — и это НЕ мешает ему пройти обычный screening', () => {
      // Владелец отправил на неё отклик руками в тот же день, когда отменил
      // «Старшего системного аналитика»: «старший» отсекается не везде, а
      // только там, где запрос помечен juniorOnly.
      expect(isAboveJuniorTitle('Старший ИТ аналитик')).toBe(true);
      expect(screenVacancy(v({ title: 'Старший ИТ аналитик' })).passed).toBe(true);
    });

    it('обычный «Системный аналитик» junior-гейт проходит', () => {
      expect(isAboveJuniorTitle('Системный аналитик')).toBe(false);
    });

    it('маркеры лид-ролей тоже выше junior', () => {
      expect(isAboveJuniorTitle('Ведущий бизнес-аналитик')).toBe(true);
      expect(isAboveJuniorTitle('Senior Analyst')).toBe(true);
    });
  });
});
