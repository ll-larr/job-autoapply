import { describe, it, expect, afterEach } from 'vitest';
import { buildPrompt, pickTemplate, pickMode, generateLetter } from '../src/core/letter.js';
import { normalizeVacancy } from '../src/core/vacancy.js';

function mk(over: Partial<Parameters<typeof normalizeVacancy>[0]> = {}) {
  return normalizeVacancy({
    source: 'hh', sourceId: '1', title: 'Бизнес-аналитик', company: 'Сбер',
    url: 'u', description: 'Описание вакансии', geo: 'Москва',
    postedAt: '2026-08-20T00:00:00Z', ...over,
  });
}

const RESUME = 'РЕЗЮМЕ АРТЁМА';

describe('pickMode', () => {
  it('скор ниже порога — hybrid', () => expect(pickMode(60, 75)).toBe('hybrid'));
  it('скор на пороге — full', () => expect(pickMode(75, 75)).toBe('full'));
  it('скор выше порога — full', () => expect(pickMode(90, 75)).toBe('full'));
});

describe('pickTemplate', () => {
  it('площадка hrge даёт английский скелет', () => {
    expect(pickTemplate(mk({ source: 'hrge' }), ['sql'])).toBe('english-generic');
  });
  it('совпадение ai-llm даёт ai-llm-ba', () => {
    expect(pickTemplate(mk(), ['ai-llm', 'sql'])).toBe('ai-llm-ba');
  });
  it('продуктовые ключевики дают product-ba', () => {
    expect(pickTemplate(mk(), ['product'])).toBe('product-ba');
  });
  it('иначе fullstack-analyst', () => {
    expect(pickTemplate(mk(), ['sql', 'bpmn'])).toBe('fullstack-analyst');
  });
});

describe('buildPrompt — порядок сообщений для OpenRouter', () => {
  it('стабильный блок (инструкция + резюме) идёт первым, как system-сообщение', () => {
    const p = buildPrompt({
      vacancy: mk(), matched: ['sql'], mode: 'hybrid', resume: RESUME, template: 'x',
    });
    expect(p.messages[0].role).toBe('system');
    expect(p.messages[0].content).toContain(RESUME);
  });

  it('текст вакансии идёт в user-сообщение и отсутствует в system — он волатилен', () => {
    const p = buildPrompt({
      vacancy: mk({ description: 'УНИКАЛЬНЫЙ ТЕКСТ' }), matched: ['sql'],
      mode: 'hybrid', resume: RESUME, template: 'x',
    });
    expect(p.messages[0].content).not.toContain('УНИКАЛЬНЫЙ ТЕКСТ');
    expect(p.messages[1].role).toBe('user');
    expect(p.messages[1].content).toContain('УНИКАЛЬНЫЙ ТЕКСТ');
  });

  it('режим full не подмешивает скелет', () => {
    const p = buildPrompt({
      vacancy: mk(), matched: [], mode: 'full', resume: RESUME, template: 'СКЕЛЕТ',
    });
    expect(JSON.stringify(p)).not.toContain('СКЕЛЕТ');
  });

  it('не содержит cache_control — это фича Anthropic, OpenRouter её не понимает', () => {
    const p = buildPrompt({
      vacancy: mk(), matched: [], mode: 'hybrid', resume: RESUME, template: 'x',
    });
    expect(JSON.stringify(p)).not.toContain('cache_control');
  });
});

describe('generateLetter', () => {
  const ORIGINAL_KEY = process.env['OPENROUTER_API_KEY'];

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env['OPENROUTER_API_KEY'];
    else process.env['OPENROUTER_API_KEY'] = ORIGINAL_KEY;
  });

  const input = { vacancy: mk(), matched: [], mode: 'hybrid' as const, resume: RESUME, template: 't' };

  it('возвращает текст первой же модели, если та ответила успешно', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ГОТОВОЕ ПИСЬМО' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const r = await generateLetter(input, { models: ['model-a:free'], fetchImpl });

    expect(r.letter).toBe('ГОТОВОЕ ПИСЬМО');
    expect(r.mode).toBe('hybrid');
    expect(calls).toBe(1);
  });

  it('шлёт запрос на openrouter с ключом из окружения, без ключа нигде в теле', async () => {
    process.env['OPENROUTER_API_KEY'] = 'secret-test-key';
    let seenUrl = '';
    let seenAuth: string | null = null;
    let seenBody = '';
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = (init?.headers as Record<string, string>)?.['Authorization'] ?? null;
      seenBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'X' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await generateLetter(input, { models: ['model-a:free'], fetchImpl });

    expect(seenUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(seenAuth).toBe('Bearer secret-test-key');
    expect(seenBody).not.toContain('secret-test-key');
  });

  it('когда первая модель отвечает ошибкой, пробует следующую по списку из config.letterModels', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    const calledModels: string[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      calledModels.push(body.model);
      if (body.model === 'model-a:free') {
        return new Response('rate limited', { status: 429 });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ПИСЬМО ОТ ВТОРОЙ МОДЕЛИ' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const r = await generateLetter(
      input,
      { models: ['model-a:free', 'model-b:free'], fetchImpl },
    );

    expect(calledModels).toEqual(['model-a:free', 'model-b:free']);
    expect(r.letter).toBe('ПИСЬМО ОТ ВТОРОЙ МОДЕЛИ');
    expect(r.mode).toBe('hybrid');
  });

  it('когда все модели из списка отвечают ошибкой, возвращает пустое письмо и режим none', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;

    const r = await generateLetter(
      input,
      { models: ['model-a:free', 'model-b:free'], fetchImpl },
    );

    expect(r.letter).toBe('');
    expect(r.mode).toBe('none');
  });

  it('на сетевой ошибке всех моделей возвращает пустое письмо и режим none — не бросает', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    const fetchImpl = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;

    const r = await generateLetter(
      input,
      { models: ['model-a:free', 'model-b:free'], fetchImpl },
    );

    expect(r.letter).toBe('');
    expect(r.mode).toBe('none');
  });

  it('на ответе без текста (сломанная форма) переходит к следующей модели', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      if (body.model === 'model-a:free') {
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ПИСЬМО ОТ ВТОРОЙ МОДЕЛИ' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const r = await generateLetter(
      input,
      { models: ['model-a:free', 'model-b:free'], fetchImpl },
    );

    expect(r.letter).toBe('ПИСЬМО ОТ ВТОРОЙ МОДЕЛИ');
  });

  it('без OPENROUTER_API_KEY возвращает пустое письмо и режим none, не трогая сеть', async () => {
    delete process.env['OPENROUTER_API_KEY'];
    let touched = false;
    const fetchImpl = (async () => {
      touched = true;
      throw new Error('network must not be touched when the key is missing');
    }) as unknown as typeof fetch;

    const r = await generateLetter(
      input,
      { models: ['model-a:free', 'model-b:free'], fetchImpl },
    );

    expect(r.letter).toBe('');
    expect(r.mode).toBe('none');
    expect(touched).toBe(false);
  });
});
