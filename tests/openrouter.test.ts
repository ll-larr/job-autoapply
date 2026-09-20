import { describe, it, expect, afterEach } from 'vitest';
import { complete } from '../src/core/openrouter.js';

const KEY = process.env['OPENROUTER_API_KEY'];
afterEach(() => {
  if (KEY === undefined) delete process.env['OPENROUTER_API_KEY'];
  else process.env['OPENROUTER_API_KEY'] = KEY;
});

function reply(text: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status });
}

describe('complete', () => {
  it('без ключа — отказ с объяснением, в сеть не ходит', async () => {
    delete process.env['OPENROUTER_API_KEY'];
    let calls = 0;
    const r = await complete([{ role: 'user', content: 'x' }], {
      models: ['m'], fetchImpl: async () => { calls++; return reply('ok'); },
    });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.failure).toMatch(/OPENROUTER_API_KEY/);
    expect(calls).toBe(0);
  });

  it('отвергнутый ответ — пробует дальше, первый принятый возвращается с моделью', async () => {
    process.env['OPENROUTER_API_KEY'] = 'k';
    const texts = ['плохо', 'хорошо'];
    const r = await complete([{ role: 'user', content: 'x' }], {
      models: ['a', 'b'], attemptsPerModel: 1,
      fetchImpl: async () => reply(texts.shift()!),
    }, (t) => (t === 'плохо' ? 'не годится' : null));
    expect(r).toEqual({ ok: true, text: 'хорошо', model: 'b' });
  });

  it('все модели провалились — последняя причина с именем модели', async () => {
    process.env['OPENROUTER_API_KEY'] = 'k';
    const r = await complete([{ role: 'user', content: 'x' }], {
      models: ['a'], attemptsPerModel: 1, fetchImpl: async () => new Response('', { status: 429 }),
    });
    expect(!r.ok && r.failure).toMatch(/^a: лимит запросов/);
  });
});
