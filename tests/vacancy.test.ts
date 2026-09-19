import { describe, it, expect } from 'vitest';
import { normalizeVacancy, vacancyKey } from '../src/core/vacancy.js';

describe('normalizeVacancy', () => {
  it('обрезает пробелы и схлопывает переносы в описании', () => {
    const v = normalizeVacancy({
      source: 'hh',
      sourceId: '123',
      title: '  Бизнес-аналитик  ',
      company: ' Сбер ',
      url: 'https://hh.ru/vacancy/123',
      description: 'Первая строка\n\n\n\nВторая строка   ',
      geo: 'Москва',
      postedAt: '2026-08-20T10:00:00Z',
    });

    expect(v.title).toBe('Бизнес-аналитик');
    expect(v.company).toBe('Сбер');
    expect(v.description).toBe('Первая строка\n\nВторая строка');
    expect(v.postedAt).toBeInstanceOf(Date);
  });

  it('по умолчанию проставляет false для isRemote и hasSponsorship', () => {
    const v = normalizeVacancy({
      source: 'hrge', sourceId: '9', title: 'Analyst', company: 'X',
      url: 'https://hr.ge/announcement/9', description: 'text',
      geo: 'Tbilisi', postedAt: '2026-08-20T10:00:00Z',
    });
    expect(v.isRemote).toBe(false);
    expect(v.hasSponsorship).toBe(false);
    expect(v.salaryFrom).toBeNull();
  });

  it('бросает на пустой sourceId — без него дедуп невозможен', () => {
    expect(() => normalizeVacancy({
      source: 'hh', sourceId: '  ', title: 'T', company: 'C',
      url: 'u', description: 'd', geo: 'g', postedAt: '2026-08-20T10:00:00Z',
    })).toThrow('sourceId');
  });
});

describe('vacancyKey', () => {
  it('склеивает source и sourceId — это ключ дедупликации', () => {
    const v = normalizeVacancy({
      source: 'hh', sourceId: '123', title: 'T', company: 'C',
      url: 'u', description: 'd', geo: 'g', postedAt: '2026-08-20T10:00:00Z',
    });
    expect(vacancyKey(v)).toBe('hh:123');
  });
});

describe('normalizeVacancy — поля Telegram', () => {
  it('contact, contentHash, channel — необязательны, по умолчанию null', () => {
    const v = normalizeVacancy({ source: 'hh', sourceId: '1', title: 't', company: 'c', url: 'u', description: 'd', geo: 'g', postedAt: '2026-09-19T00:00:00Z' });
    expect(v.contact).toBeNull();
    expect(v.contentHash).toBeNull();
    expect(v.channel).toBeNull();
  });

  it('contact чистится от @ и пробелов', () => {
    const v = normalizeVacancy({ source: 'tg', sourceId: '1:2', title: 't', company: '', url: 'u', description: 'd', geo: '', postedAt: new Date(), contact: ' @hr_person ' });
    expect(v.contact).toBe('hr_person');
  });
});
