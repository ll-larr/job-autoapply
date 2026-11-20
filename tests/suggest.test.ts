import { describe, it, expect, afterEach } from 'vitest';
import { buildSuggestMessages, parseSuggestion, suggestSpecialty } from '../src/core/suggest.js';

const KEY = process.env['OPENROUTER_API_KEY'];
afterEach(() => {
  if (KEY === undefined) delete process.env['OPENROUTER_API_KEY'];
  else process.env['OPENROUTER_API_KEY'] = KEY;
});

function reply(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
}

describe('suggestSpecialty', () => {
  it('негодный ответ пропускается, первый годный возвращается', async () => {
    process.env['OPENROUTER_API_KEY'] = 'k';
    const answers = [
      'не знаю',
      JSON.stringify({ titleWords: ['продакт'], skills: [{ name: 'Роадмап', synonyms: ['роадмап'], weight: 20, core: true }] }),
    ];
    const r = await suggestSpecialty('Менеджер продукта', 'РЕЗЮМЕ', {
      models: ['m'], attemptsPerModel: 2, fetchImpl: async () => reply(answers.shift()!),
    });
    // Старый формат ответа (без новых полей) годится: они необязательны.
    expect(r).toEqual({
      ok: true,
      suggestion: {
        name: null, queries: [], titleWords: ['продакт'],
        skills: [{ name: 'Роадмап', synonyms: ['роадмап'], weight: 20, core: true }],
        experienceYears: null, salaryFrom: null,
      },
    });
  });

  it('модель не ответила — причина для человека', async () => {
    process.env['OPENROUTER_API_KEY'] = 'k';
    const r = await suggestSpecialty('X', 'R', {
      models: ['m'], attemptsPerModel: 1, fetchImpl: async () => reply('просто текст'),
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/не похож на JSON/);
  });
});

describe('parseSuggestion', () => {
  const good = {
    titleWords: ['менеджер продукта', 'product manager'],
    skills: [
      { name: 'Роадмап', synonyms: ['роадмап', 'roadmap'], weight: 25, core: true },
      { name: 'Метрики', synonyms: ['метрик*'], weight: 10, core: false },
    ],
  };

  const full = {
    name: 'Менеджер продукта', queries: ['менеджер продукта', 'product manager'],
    ...good, experienceYears: 4, salaryFrom: 250000,
  };

  it('читает JSON и в ограде ```json', () => {
    expect(parseSuggestion(JSON.stringify(full))).toEqual(full);
    expect(parseSuggestion('Вот:\n```json\n' + JSON.stringify(full) + '\n```')).toEqual(full);
  });

  it('новые поля необязательны: без них — null и пустой список', () => {
    expect(parseSuggestion(JSON.stringify(good))).toEqual({
      ...good, name: null, queries: [], experienceYears: null, salaryFrom: null,
    });
  });

  it('мусор в новых полях — null / [], ответ не отбрасывается', () => {
    expect(parseSuggestion(JSON.stringify({
      ...good, name: '  ', queries: 'pm', experienceYears: 'много', salaryFrom: { rub: 1 },
    }))).toEqual({ ...good, name: null, queries: [], experienceYears: null, salaryFrom: null });
    expect(parseSuggestion(JSON.stringify({ ...good, name: 7, queries: [' pm ', '', 3] })))
      .toMatchObject({ name: null, queries: ['pm'] });
  });

  it.each([
    [3.6, 4], [-2, 0], [80, 50], ['5', 5], [null, null], ['5 лет', null],
  ])('опыт %j → %j (целое 0–50)', (raw, want) => {
    expect(parseSuggestion(JSON.stringify({ ...good, experienceYears: raw }))!.experienceYears).toBe(want);
  });

  it.each([
    [150000, 150000], [150000.4, 150000], ['200000', 200000], [0, null], [-5, null], [null, null], ['от 100 тыс', null],
    [100_000_000, 100_000_000], [5_000_000_000, null],
  ])('зарплата %j → %j (положительное целое не выше потолка валидации)', (raw, want) => {
    expect(parseSuggestion(JSON.stringify({ ...good, salaryFrom: raw }))!.salaryFrom).toBe(want);
  });

  it('вес приводится к целому 0–100, пустые синонимы выкидываются', () => {
    const r = parseSuggestion(JSON.stringify({
      titleWords: ['x'],
      skills: [{ name: 'A', synonyms: ['a', ' '], weight: 140.6, core: 'да' }],
    }));
    expect(r!.skills[0]).toEqual({ name: 'A', synonyms: ['a'], weight: 100, core: false });
  });

  it.each([
    ['не JSON', 'просто текст'],
    ['без слов заголовка', JSON.stringify({ titleWords: [], skills: good.skills })],
    ['без навыков', JSON.stringify({ titleWords: ['x'], skills: [] })],
  ])('null: %s', (_l, text) => expect(parseSuggestion(text)).toBeNull());
});

describe('buildSuggestMessages', () => {
  it('в промпте название специальности, резюме и формат ответа', () => {
    const [system, user] = buildSuggestMessages('Менеджер продукта', 'РЕЗЮМЕ');
    expect(system!.content).toContain('titleWords');
    expect(system!.content).toContain('Правила совпадения');
    for (const field of ['"name"', '"queries"', '"experienceYears"', '"salaryFrom"']) expect(system!.content).toContain(field);
    expect(user!.content).toContain('Специальность: Менеджер продукта');
    expect(user!.content).toContain('РЕЗЮМЕ');
  });

  it('без названия — просим предложить должность по резюме', () => {
    const [, user] = buildSuggestMessages('  ', 'РЕЗЮМЕ');
    expect(user!.content).toContain('не указана — предложи должность по резюме');
    expect(user!.content).toContain('РЕЗЮМЕ');
  });
});
