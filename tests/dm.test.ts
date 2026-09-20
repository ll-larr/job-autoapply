import { describe, it, expect, afterEach } from 'vitest';
import { buildDmMessages, isUsableDm, generateDm, DM_MAX_LENGTH } from '../src/core/dm.js';
import { normalizeVacancy } from '../src/core/vacancy.js';

const V = normalizeVacancy({
  source: 'tg', sourceId: '-1001:7', title: 'Системный аналитик', company: '', url: 'https://t.me/workayte/7',
  description: 'Нужен BPMN, UML, SQL. Контакты: @hr', geo: '', postedAt: '2026-09-19T00:00:00Z',
  contact: 'hr', channel: 'Работа в ИТ',
});
const KEY = process.env['OPENROUTER_API_KEY'];
afterEach(() => { if (KEY === undefined) delete process.env['OPENROUTER_API_KEY']; else process.env['OPENROUTER_API_KEY'] = KEY; });

describe('buildDmMessages', () => {
  const [system, user] = buildDmMessages({ vacancy: V, resume: 'РЕЗЮМЕ', role: 'Системный аналитик' });
  it('правила личного сообщения: вакансия и ссылка сразу, 2–3 предложения, резюме во вложении', () => {
    expect(system!.content).toMatch(/ссылк/);
    expect(system!.content).toMatch(/2–3 предложения/);
    expect(system!.content).toMatch(/во вложении/);
  });
  it('без правил письма, которые здесь неверны', () => {
    expect(system!.content).not.toContain('Не начинай с упоминания того, что это отклик');
    expect(system!.content).not.toContain('"Резюме прикреплено"');
  });
  it('общие запреты письма — на месте', () => {
    expect(system!.content).toContain('Никаких длинных тире');
    expect(system!.content).toContain('диплом');
  });
  it('в user — пост, ссылка, название чата', () => {
    expect(user!.content).toContain('https://t.me/workayte/7');
    expect(user!.content).toContain('Работа в ИТ');
    expect(user!.content).toContain('Нужен BPMN');
  });
});

describe('isUsableDm', () => {
  it('годное — null', () => {
    expect(isUsableDm('Здравствуйте! Пишу по вакансии системного аналитика https://t.me/workayte/7. Делал BPMN-схемы. Резюме во вложении.', V)).toBeNull();
  });
  it('без ссылки на пост — негодно', () => {
    expect(isUsableDm('Здравствуйте! Хочу к вам. Резюме во вложении.', V)).toMatch(/ссылк/);
  });
  it('длиннее предела — негодно', () => {
    expect(isUsableDm(`https://t.me/workayte/7 ${'а'.repeat(DM_MAX_LENGTH)}`, V)).toMatch(/длин/);
  });
  it('выдуманный навык — негодно', () => {
    expect(isUsableDm('https://t.me/workayte/7 Писал оконные функции.', V)).toMatch(/оконные функции/);
  });
});

describe('generateDm', () => {
  it('негодный ответ пропускается, годный возвращается с mode dm', async () => {
    process.env['OPENROUTER_API_KEY'] = 'k';
    const answers = ['Без ссылки', 'Здравствуйте! По вакансии https://t.me/workayte/7 — делал BPMN. Резюме во вложении.'];
    const r = await generateDm({ vacancy: V, resume: 'R', role: 'Системный аналитик' }, {
      models: ['m'], attemptsPerModel: 2,
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: answers.shift() } }] })),
    });
    expect(r.mode).toBe('dm');
    expect(r.letter).toContain('https://t.me/workayte/7');
  });
});
