import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setApiKey } from '../src/core/openrouter.js';
import { buildInterviewMessages, generateAnswer } from '../src/core/interview.js';
import type { Turn } from '../src/core/interview.js';

const transcript: Turn[] = [
  { who: 'bot', text: 'Почему сейчас рассматриваете предложения о работе?' },
  { who: 'me', text: 'Не хватает масштаба.' },
];

describe('buildInterviewMessages', () => {
  beforeEach(() => {
    setApiKey('sk-test-key');
  });

  afterEach(() => {
    setApiKey(null);
  });

  it('резюме и факты идут в system, вопрос и транскрипт — в user', () => {
    const m = buildInterviewMessages({
      resume: 'РЕЗЮМЕ-ТЕКСТ',
      facts: 'ФАКТЫ-ТЕКСТ',
      transcript,
      question: 'Какой у вас опыт с Kafka?',
    });
    expect(m).toHaveLength(2);
    expect(m[0]!.role).toBe('system');
    expect(m[0]!.content).toContain('РЕЗЮМЕ-ТЕКСТ');
    expect(m[0]!.content).toContain('ФАКТЫ-ТЕКСТ');
    expect(m[1]!.role).toBe('user');
    expect(m[1]!.content).toContain('Какой у вас опыт с Kafka?');
    expect(m[1]!.content).toContain('Не хватает масштаба.');
  });

  it('система содержит явное предостережение о запрещённых умениях', () => {
    const m = buildInterviewMessages({
      resume: 'тест',
      facts: 'тест',
      transcript: [],
      question: 'Пример вопроса',
    });
    const systemContent = m[0]!.content;
    expect(systemContent).toContain('JOIN');
    expect(systemContent).toContain('хранимые процедуры');
  });

  it('система велит писать суммы так же, как в резюме и фактах (I3)', () => {
    const m = buildInterviewMessages({ resume: 'р', facts: 'ф', transcript: [], question: 'в' });
    expect(m[0]!.content).toContain(
      'Суммы и числа пиши так же, как в резюме и фактах: например, 280–360 тысяч, а не 280 000.',
    );
  });
});

describe('generateAnswer', () => {
  beforeEach(() => {
    setApiKey('sk-test-key');
  });

  afterEach(() => {
    setApiKey(null);
  });

  const input = {
    resume: 'Сократил время с 32 до 4 часов',
    facts: 'Вилка 280–360',
    transcript: [] as Turn[],
    question: 'На сколько сократили время инвентаризации?',
  };

  it('годный ответ возвращается как есть', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'С 32 до 4 часов.' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const r = await generateAnswer(input, { models: ['m1'], fetchImpl, attemptsPerModel: 1 });
    expect(r).toEqual({ ok: true, text: 'С 32 до 4 часов.' });
  });

  it('ответ с выдуманным числом отбраковывается, и берётся следующая модель', async () => {
    const bodies = ['Примерно на 90%.', 'С 32 до 4 часов.'];
    let i = 0;
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: bodies[i++] ?? '' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const r = await generateAnswer(input, { models: ['m1', 'm2'], fetchImpl, attemptsPerModel: 1 });
    expect(r).toEqual({ ok: true, text: 'С 32 до 4 часов.' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('правдивые «от 280 000 до 360 000 рублей» и «коды 200, 400 и 500» проходят с первой модели (I3)', async () => {
    for (const text of ['Ожидаю от 280 000 до 360 000 рублей.', 'Проверял коды ответов 200, 400 и 500.']) {
      const fetchImpl = vi.fn(async () => new Response(
        JSON.stringify({ choices: [{ message: { content: text } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
      const r = await generateAnswer(input, { models: ['m1'], fetchImpl, attemptsPerModel: 1 });
      expect(r).toEqual({ ok: true, text });
    }
  });

  it('все модели дали брак — ok:false, наружу ничего не отдаётся', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'Примерно на 90%.' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const r = await generateAnswer(input, { models: ['m1', 'm2'], fetchImpl, attemptsPerModel: 1 });
    expect(r.ok).toBe(false);
  });
});
