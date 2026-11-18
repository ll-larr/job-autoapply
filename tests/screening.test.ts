import { describe, it, expect } from 'vitest';
import { normalizeVacancy } from '../src/core/vacancy.js';
import {
  screenVacancy,
  parseExperienceFromText,
  isSeniorTitle,
  isInternshipTitle,
  isAboveJuniorTitle,
  isExperienceWithin,
  findStopWord,
  hasTitleWord,
  DEFAULT_SCREENING,
  STOPWORD_DESCRIPTION_THRESHOLD,
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

  it('"от 3 – лет" — тире между числом и «лет» (живой пост Telegram, 2026-09-19)', () => {
    expect(parseExperienceFromText('Опыт работы: от 3 – лет')).toBe('between1And3');
    // Диапазон с тире по-прежнему диапазон, а не «от 3».
    expect(parseExperienceFromText('Опыт от 3 – 6 лет')).toBe('between3And6');
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

describe('isExperienceWithin — минимум бакета против «мой опыт»', () => {
  it.each([
    ['noExperience', 0, true], ['between1And3', 0, false],
    ['between1And3', 1, true], ['between1And3', 2, true], ['between3And6', 2, false],
    ['between3And6', 3, true], ['moreThan6', 5, false], ['moreThan6', 6, true],
  ] as const)('%s при опыте %i → %s', (level, years, expected) => {
    expect(isExperienceWithin(level, years)).toBe(expected);
  });

  it('требование неизвестно — проходит при любом опыте', () => {
    expect(isExperienceWithin(null, 0)).toBe(true);
  });

  it('опыт 2 — ровно прежний ACCEPTABLE_EXPERIENCE', () => {
    expect(DEFAULT_SCREENING.experienceYears).toBe(2);
  });
});

describe('findStopWord — заголовок или 2+ упоминаний в описании', () => {
  const words = ['1С', 'Битрикс', 'Bitrix'];

  it('порог описания — 2', () => expect(STOPWORD_DESCRIPTION_THRESHOLD).toBe(2));

  it('«Аналитик 1С» — в заголовке, сразу', () => {
    expect(findStopWord(v({ title: 'Аналитик 1С', description: 'x' }), words)).toBe('1С');
  });

  it('латинская «1C» в заголовке тоже', () => {
    expect(findStopWord(v({ title: 'Аналитик 1C', description: 'x' }), words)).toBe('1С');
  });

  it('одно упоминание в списке систем — проходит', () => {
    expect(findStopWord(v({ description: 'Системы: TOS.Solvo, 1С, ELMA, Jira.' }), words)).toBeNull();
  });

  it('два упоминания в описании — отсев (было три до 2026-09-18, спека 3.5)', () => {
    expect(findStopWord(v({ description: 'Внедрение 1С:ERP. Интеграции с 1С.' }), words)).toBe('1С');
  });

  it('«1 сотрудник» и «21С» — не 1С', () => {
    expect(findStopWord(v({ description: '1 сотрудник, 1 секция, 21С, 21С' }), words)).toBeNull();
  });

  it('«Системный аналитик Bitrix24» и «Интегратор/аналитик Битрикс24» — по заголовку', () => {
    expect(findStopWord(v({ title: 'Системный аналитик Bitrix24' }), words)).toBe('Bitrix');
    expect(findStopWord(v({ title: 'Интегратор/аналитик Битрикс24' }), words)).toBe('Битрикс');
  });

  it('Битрикс один раз среди систем — проходит', () => {
    expect(findStopWord(v({ description: 'Работали с amoCRM, Битрикс24, Jira' }), words)).toBeNull();
  });

  it('пустой список — ничего не отсекает', () => {
    expect(findStopWord(v({ title: 'Аналитик 1С' }), [])).toBeNull();
  });
});

describe('hasTitleWord', () => {
  const words = ['аналитик', 'analyst', 'BA', 'SA'];

  it.each([
    'Менеджер по операционному консалтингу',
    'Менеджер по повышению эффективности бизнеса (направление lean)',
    'Управляющий директор по развитию эффективности сегментов',
  ])('отсекает «%s»', (title) => expect(hasTitleWord(title, words)).toBe(false));

  it.each([
    'Бизнес-аналитик', 'Системный аналитик', 'Business Analyst', 'BA / SA', 'Аналитик бизнес-процессов',
  ])('пропускает «%s»', (title) => expect(hasTitleWord(title, words)).toBe(true));
});

describe('screenVacancy — профиль специальности', () => {
  const profile = { titleWords: ['продакт', 'product'], experienceYears: 3, stopWords: ['вахта'] };

  it('слова заголовка берутся из профиля', () => {
    expect(screenVacancy(v({ title: 'Product manager' }), profile)).toEqual({ passed: true });
    const r = screenVacancy(v({ title: 'Бизнес-аналитик' }), profile);
    expect(r.passed === false && r.reason).toBe('not_title');
  });

  it('стаж — из профиля: 3–6 лет проходит при опыте 3', () => {
    expect(screenVacancy(v({ title: 'Product manager', experience: 'between3And6' }), profile).passed).toBe(true);
  });

  it('стоп-слово называет себя в причине', () => {
    const r = screenVacancy(v({ title: 'Product manager вахта' }), profile);
    expect(r).toMatchObject({ passed: false, reason: 'stopword', stopWord: 'вахта' });
  });

  it('опыт 0 отсекает «Старший …» по грейду — прежний juniorOnly', () => {
    const r = screenVacancy(v({ title: 'Старший системный аналитик' }), { ...DEFAULT_SCREENING, experienceYears: 0 });
    expect(r.passed === false && r.reason).toBe('grade');
  });

  it('опыт 2 «Старший ИТ аналитик» пропускает', () => {
    expect(screenVacancy(v({ title: 'Старший ИТ аналитик' })).passed).toBe(true);
  });

  it('skipTitleGate снимает проверку заголовка', () => {
    expect(screenVacancy(v({ title: 'Пост из канала' }), { ...profile, skipTitleGate: true }).passed).toBe(true);
  });
});

describe('screenVacancy — стоп-слова по умолчанию (1С, Битрикс)', () => {
  it('«Аналитик 1С» — отсев с причиной stopword', () => {
    expect(screenVacancy(v({ title: 'Аналитик 1С' }))).toMatchObject({ passed: false, reason: 'stopword', stopWord: '1С' });
  });

  it('1С и Битрикс по разу среди систем — проходит', () => {
    const r = screenVacancy(v({
      title: 'Бизнес-аналитик',
      description: 'Работаем со стеком: SAP, 1С, Oracle, Bitrix24.',
    }));
    expect(r.passed).toBe(true);
  });

  it('карточка №5 из фикстуры hh (TOS.Solvo, 1С, ELMA) — одно упоминание, проходит', () => {
    const description =
      'Развивать и внедрять ИТ-системы для логистических объектов ' +
      '(контейнерные терминалы, порты, складские комплексы) и бэк-офиса (TOS.Solvo, 1С, ELMA...).';
    expect(screenVacancy(v({ description })).passed).toBe(true);
  });

  it('1С везде в описании — отсев', () => {
    const description =
      'Опыт работы аналитиком 1С. Знание одной из конфигураций 1С. ' +
      'Линейка программных продуктов 1С для разработки модулей: 1С:ERP, 1С:Управление торговлей.';
    expect(screenVacancy(v({ title: 'Аналитик', description })).passed).toBe(false);
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
  describe('Битрикс и «не аналитик» — через стоп-слова и слова заголовка', () => {
    it('«Системный аналитик Bitrix24» — причина stopword с названным словом', () => {
      const r = screenVacancy(v({ title: 'Системный аналитик Bitrix24' }));
      expect(r).toMatchObject({ passed: false, reason: 'stopword', stopWord: 'Bitrix' });
    });

    it('по описанию, когда вакансия про Битрикс, а заголовок молчит', () => {
      const r = screenVacancy(v({
        title: 'Системный аналитик',
        description: 'Портал на Битрикс24, дорабатываем Битрикс под задачи заказчика.',
      }));
      expect(r).toMatchObject({ passed: false, reason: 'stopword' });
    });

    it('«Менеджер по операционному консалтингу» — причина not_title', () => {
      // Скор у неё был проходной: процессная лексика в описании честно есть.
      // Гейт отвечает на другой вопрос — кем зовут, а не чем занимаются.
      const r = screenVacancy(v({ title: 'Менеджер по операционному консалтингу' }));
      expect(r).toMatchObject({ passed: false, reason: 'not_title' });
    });

    it('настоящие аналитические заголовки из очереди проходят', () => {
      for (const t of [
        'Бизнес-аналитик', 'Системный аналитик', 'Старший ИТ аналитик', 'Аналитик проектного отдела',
        'Бизнес-аналитик / Специалист по моделированию', 'Customer Business Analyst',
      ]) {
        expect(screenVacancy(v({ title: t })).passed, t).toBe(true);
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
