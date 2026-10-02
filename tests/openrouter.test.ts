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

describe('complete — остановка (signal)', () => {
  it('сигнал уже подан — в сеть не ходит, отказ называет остановку', async () => {
    process.env['OPENROUTER_API_KEY'] = 'k';
    const ctl = new AbortController();
    ctl.abort();
    let calls = 0;
    const r = await complete([{ role: 'user', content: 'x' }], {
      models: ['a', 'b'], signal: ctl.signal, fetchImpl: async () => { calls++; return reply('ok'); },
    });
    expect(calls).toBe(0);
    expect(!r.ok && r.failure).toMatch(/остановлен/i);
  });

  it('сигнал подан посреди запроса — запрос обрывается сразу, остальные модели и попытки не пробуются', async () => {
    // Иначе «Остановить» ждала бы по девяносто секунд на каждую попытку каждой
    // модели из цепочки — то есть минуты, и кнопка выглядела бы неработающей.
    process.env['OPENROUTER_API_KEY'] = 'k';
    const ctl = new AbortController();
    let calls = 0;
    const started = Date.now();
    const pending = complete([{ role: 'user', content: 'x' }], {
      models: ['a', 'b'], attemptsPerModel: 3, signal: ctl.signal, timeoutMs: 60_000,
      fetchImpl: (_url, init) => new Promise<Response>((_res, rej) => {
        calls++;
        init!.signal!.addEventListener('abort', () => rej(new DOMException('This operation was aborted', 'AbortError')));
      }),
    });
    setTimeout(() => ctl.abort(), 50);
    const r = await pending;

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(calls).toBe(1);
    expect(!r.ok && r.failure).toMatch(/остановлен/i);
  }, 15_000);

  it('без signal поведение прежнее', async () => {
    process.env['OPENROUTER_API_KEY'] = 'k';
    const r = await complete([{ role: 'user', content: 'x' }], {
      models: ['a'], attemptsPerModel: 1, fetchImpl: async () => reply('ответ'),
    });
    expect(r).toEqual({ ok: true, text: 'ответ', model: 'a' });
  });
});
