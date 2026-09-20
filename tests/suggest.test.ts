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
    expect(r).toEqual({
      ok: true,
      suggestion: { titleWords: ['продакт'], skills: [{ name: 'Роадмап', synonyms: ['роадмап'], weight: 20, core: true }] },
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

  it('читает JSON и в ограде ```json', () => {
    expect(parseSuggestion(JSON.stringify(good))).toEqual(good);
    expect(parseSuggestion('Вот:\n```json\n' + JSON.stringify(good) + '\n```')).toEqual(good);
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
    expect(user!.content).toContain('Менеджер продукта');
    expect(user!.content).toContain('РЕЗЮМЕ');
  });
});
