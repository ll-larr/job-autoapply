import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  isVacancyPost, pickContact, platformLink, postTitle, contentHash, postUrl, postToVacancy,
} from '../src/telegram/parse.js';
import type { TgChat, TgMessage } from '../src/telegram/types.js';

interface Fixture { chat: TgChat; message: Omit<TgMessage, 'date'> & { date: string }; synthetic?: boolean }
const FIXTURES = (JSON.parse(readFileSync('tests/fixtures/tg-posts.json', 'utf8')) as Fixture[])
  .map((f) => ({ chat: f.chat, message: { ...f.message, date: new Date(f.message.date) } }));
function post(startsWith: string) {
  const f = FIXTURES.find((x) => x.message.text.trimStart().startsWith(startsWith));
  if (!f) throw new Error(`нет поста «${startsWith}» в фикстуре`);
  return f;
}
const WORDS = ['аналитик', 'analyst', 'BA', 'SA'];

describe('isVacancyPost', () => {
  it('настоящие вакансии — да', () => {
    expect(isVacancyPost(post('Ищем Senior аналитика').message.text)).toBe(true);
    expect(isVacancyPost(post('На проект ведущего банка').message.text)).toBe(true);
  });
  it('подкаст, дайджест резюме, короткий пост — нет', () => {
    expect(isVacancyPost(post('😎 Ищем героев').message.text)).toBe(false);
    // «Дайдежст» — опечатка самого канала, пост взят как есть.
    expect(isVacancyPost(post('Дайдежст резюме').message.text)).toBe(false);
    expect(isVacancyPost('Вакансия аналитика, пишите')).toBe(false);
  });
  it('#резюме и «ищу работу» — нет, даже со словом «вакансия»', () => {
    const long = 'x'.repeat(300);
    expect(isVacancyPost(`#резюме Бизнес-аналитик, ищу вакансию. ${long}`)).toBe(false);
    expect(isVacancyPost(`Ищу работу бизнес-аналитиком, требования к вакансии: ${long}`)).toBe(false);
  });
});

describe('pickContact', () => {
  it('строка «Отклик:» / «Контакты:» / «tg:» — контакт', () => {
    expect(pickContact(post('Ищем Senior аналитика').message.text, 'workayte')).toBe('recruiter_a');
    expect(pickContact(post('На проект ведущего банка').message.text, 'workayte')).toBe('recruiter_b');
    expect(pickContact(post('‼️SDR').message.text, 'workayte')).toMatch(/^recruiter_/);
  });
  it('реклама канала «Больше вакансий: @…» — не контакт', () => {
    expect(pickContact(post('Junior / Middle System Analyst').message.text, 'foranalysts')).toBeNull();
  });
  it('упоминание самого канала — не контакт', () => {
    expect(pickContact('Вакансия. Пишите @workayte, резюме в личку', 'workayte')).toBeNull();
  });
  it('без слов-признаков берётся первый @ не из рекламной строки', () => {
    expect(pickContact('Бизнес-аналитик в банк\n@hr_person\nПодписывайтесь на @channel_x', null)).toBe('hr_person');
  });
  it('почта и e-mail@домен — не username', () => {
    expect(pickContact('Резюме на hr@example.com', null)).toBeNull();
  });
});

describe('platformLink', () => {
  it('hh.ru — источник hh с id', () => {
    expect(platformLink(['https://hh.ru/vacancy/123456789?from=tg'], '')).toEqual({
      source: 'hh', sourceId: '123456789', url: 'https://hh.ru/vacancy/123456789',
    });
  });
  it('ссылка в тексте тоже считается', () => {
    expect(platformLink([], 'Подробнее: spb.hh.ru/vacancy/42')!.sourceId).toBe('42');
  });
  it('careerist — id из хвоста адреса', () => {
    expect(platformLink(['https://careerist.ru/vakansii/biznes-analitik-89110600.html'], '')).toEqual({
      source: 'careerist', sourceId: '89110600', url: 'https://careerist.ru/vakansii/biznes-analitik-89110600.html',
    });
  });
  it('LinkedIn и прочее — нет', () => {
    expect(platformLink(['https://lnkd.in/x'], '')).toBeNull();
  });
});

describe('postTitle', () => {
  it('первая строка со словом заголовка, без эмодзи и хэштегов', () => {
    expect(postTitle('🔥🔥\n#вакансия #удаленка\n💼 Бизнес-аналитик (middle) #fintech\nОписание', WORDS))
      .toBe('Бизнес-аналитик (middle)');
  });
  it('слово только в хэштеге — следующая строка со словом, иначе первая непустая', () => {
    expect(postTitle('#аналитик #вакансия\nВедущий специалист\nОписание', WORDS)).toBe('Ведущий специалист');
  });
  it('обрезается до 120 символов', () => {
    expect(postTitle(`Аналитик ${'x'.repeat(300)}`, WORDS).length).toBeLessThanOrEqual(120);
  });
});

describe('contentHash', () => {
  it('репост с другими эмодзи, хэштегами, ссылками и пробелами — тот же хэш', () => {
    const a = '🔥 Бизнес-аналитик\n\nОпыт от 1 года. Пишите @hr';
    const b = 'Бизнес-аналитик #вакансия\nОпыт   от 1 года. https://t.me/x Пишите @hr ✅';
    expect(contentHash(a)).toBe(contentHash(b));
  });
  it('другой текст — другой хэш', () => {
    expect(contentHash('Бизнес-аналитик')).not.toBe(contentHash('Системный аналитик'));
  });
});

describe('postUrl', () => {
  it('публичный канал — t.me/<username>/<id>', () => {
    expect(postUrl({ id: '-1001', title: 't', username: 'workayte', kind: 'channel' }, 4320))
      .toBe('https://t.me/workayte/4320');
  });
  it('закрытый — t.me/c/<id без -100>/<id>', () => {
    expect(postUrl({ id: '-1001234567', title: 't', username: null, kind: 'group' }, 7))
      .toBe('https://t.me/c/1234567/7');
  });
});

describe('postToVacancy', () => {
  it('вакансия с контактом — источник tg, контакт, опыт, ссылка на пост', () => {
    const f = post('На проект ведущего банка');
    const r = postToVacancy(f.chat, f.message, WORDS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vacancy.source).toBe('tg');
    expect(r.vacancy.sourceId).toBe(`${f.chat.id}:${f.message.id}`);
    expect(r.vacancy.contact).toBe('recruiter_b');
    expect(r.vacancy.title).toMatch(/Системный аналитик/);
    expect(r.vacancy.url).toBe(postUrl(f.chat, f.message.id));
    expect(r.vacancy.company).toBe('');
    expect(r.vacancy.description).toContain('Контакты: @recruiter_b');
    expect(r.vacancy.experience).toBe('between1And3');
  });
  it('вакансия без контакта — no_contact: отклик через бота канала, @ человека нет', () => {
    const f = post('Область и стек: Системная аналитика');
    expect(postToVacancy(f.chat, f.message, WORDS)).toEqual({ ok: false, reason: 'no_contact' });
  });

  it('пост-реклама без признаков вакансии — not_vacancy, до контакта не доходит', () => {
    const f = post('Junior / Middle System Analyst');
    expect(postToVacancy(f.chat, f.message, WORDS)).toEqual({ ok: false, reason: 'not_vacancy' });
  });
  it('не вакансия — not_vacancy', () => {
    const f = post('😎 Ищем героев');
    expect(postToVacancy(f.chat, f.message, WORDS)).toEqual({ ok: false, reason: 'not_vacancy' });
  });
  it('ссылка на hh без контакта — вакансия hh, подаётся адаптером hh', () => {
    const f = FIXTURES.find((x) => x.message.urls.some((u) => u.includes('hh.ru/vacancy/')))!;
    const r = postToVacancy(f.chat, f.message, WORDS);
    expect(r.ok && r.vacancy.source).toBe('hh');
    expect(r.ok && r.vacancy.sourceId).toBe('123456789');
    expect(r.ok && r.vacancy.url).toBe('https://hh.ru/vacancy/123456789');
    expect(r.ok && r.vacancy.contact).toBeNull();
  });
});
