import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { normalizeVacancy } from '../src/core/vacancy.js';
import {
  answerQuestions,
  buildQuestionsPrompt,
  parseAnswers,
  type TestQuestion,
} from '../src/core/questions.js';

const YES_NO: TestQuestion = {
  name: 'task_1',
  text: 'Опыт BPMN?',
  kind: 'single',
  options: [
    { value: '11', label: 'да' },
    { value: '12', label: 'нет' },
    { value: 'open', label: 'Own variant' },
  ],
  textName: 'task_1_text',
};
const SALARY: TestQuestion = { name: 'task_2_text', text: 'Финансовые ожидания?', kind: 'text', options: [], textName: 'task_2_text' };
const QUESTIONS = [YES_NO, SALARY];

const VACANCY = normalizeVacancy({
  source: 'hh', sourceId: '1', title: 'Бизнес-аналитик', company: 'Банк', url: 'https://hh.ru/vacancy/1',
  description: 'описание', geo: 'Москва', postedAt: new Date().toISOString(),
});

describe('parseAnswers', () => {
  it('принимает ответ на каждый вопрос, в том числе обёрнутый в markdown', () => {
    const raw = '```json\n[{"name":"task_1","values":["11"],"text":""},{"name":"task_2_text","values":[],"text":"Готов обсудить"}]\n```';
    expect(parseAnswers(raw, QUESTIONS)).toEqual([
      { name: 'task_1', values: ['11'], text: '' },
      { name: 'task_2_text', values: [], text: 'Готов обсудить' },
    ]);
  });

  it('пропущенный вопрос — анкета негодна целиком', () => {
    expect(parseAnswers('[{"name":"task_1","values":["11"],"text":""}]', QUESTIONS)).toBeNull();
  });

  it('значение, которого нет среди вариантов, — негодно', () => {
    expect(parseAnswers('[{"name":"task_1","values":["99"]},{"name":"task_2_text","text":"x"}]', QUESTIONS)).toBeNull();
  });

  it('два значения на single — негодно', () => {
    expect(parseAnswers('[{"name":"task_1","values":["11","12"]},{"name":"task_2_text","text":"x"}]', QUESTIONS)).toBeNull();
  });

  it('«свой вариант» без текста — негодно, с текстом — принимается', () => {
    expect(parseAnswers('[{"name":"task_1","values":["open"],"text":""},{"name":"task_2_text","text":"x"}]', QUESTIONS)).toBeNull();
    expect(parseAnswers('[{"name":"task_1","values":["open"],"text":"Озон Банк, 1.5 года"},{"name":"task_2_text","text":"x"}]', QUESTIONS))
      .toEqual([
        { name: 'task_1', values: ['open'], text: 'Озон Банк, 1.5 года' },
        { name: 'task_2_text', values: [], text: 'x' },
      ]);
  });

  it('пустой текст на текстовый вопрос — негодно', () => {
    expect(parseAnswers('[{"name":"task_1","values":["11"]},{"name":"task_2_text","text":"  "}]', QUESTIONS)).toBeNull();
  });

  it('не JSON — null, а не исключение', () => {
    expect(parseAnswers('не могу ответить', QUESTIONS)).toBeNull();
  });
});

describe('buildQuestionsPrompt', () => {
  it('несёт резюме, вакансию, вопросы и заданные зарплатные ожидания', () => {
    const [system, user] = buildQuestionsPrompt(QUESTIONS, { vacancy: VACANCY, resume: 'РЕЗЮМЕ-ТЕКСТ', salaryExpectation: 'от 150 000 ₽' });
    expect(system!.content).toContain('РЕЗЮМЕ-ТЕКСТ');
    expect(system!.content).toContain('от 150 000 ₽');
    expect(user!.content).toContain('task_1');
    expect(user!.content).toContain('Бизнес-аналитик');
  });
});

describe('answerQuestions', () => {
  const saved = process.env['OPENROUTER_API_KEY'];
  beforeEach(() => { process.env['OPENROUTER_API_KEY'] = 'test-key'; });
  afterEach(() => {
    if (saved === undefined) delete process.env['OPENROUTER_API_KEY'];
    else process.env['OPENROUTER_API_KEY'] = saved;
  });

  const reply = (content: string): Response =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

  it('негодный ответ первой модели — берётся следующая', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const model = JSON.parse(String(init.body)).model as string;
      calls.push(model);
      return model === 'bad'
        ? reply('[]')
        : reply('[{"name":"task_1","values":["12"]},{"name":"task_2_text","text":"Готов обсудить"}]');
    }) as unknown as typeof fetch;

    const r = await answerQuestions(QUESTIONS, { vacancy: VACANCY, resume: 'r' }, { models: ['bad', 'good'], attemptsPerModel: 1, fetchImpl });
    expect(calls).toEqual(['bad', 'good']);
    expect(r.answers?.[0]).toEqual({ name: 'task_1', values: ['12'], text: '' });
  });

  it('никто не ответил — answers null и причина названа', async () => {
    const fetchImpl = (async () => new Response('x', { status: 429 })) as unknown as typeof fetch;
    const r = await answerQuestions(QUESTIONS, { vacancy: VACANCY, resume: 'r' }, { models: ['m'], attemptsPerModel: 1, fetchImpl });
    expect(r.answers).toBeNull();
    expect(r.failure).toContain('429');
  });

  it('без ключа — сразу null, без запросов', async () => {
    delete process.env['OPENROUTER_API_KEY'];
    let called = false;
    const fetchImpl = (async () => { called = true; return reply('[]'); }) as unknown as typeof fetch;
    const r = await answerQuestions(QUESTIONS, { vacancy: VACANCY, resume: 'r' }, { models: ['m'], fetchImpl });
    expect(r.answers).toBeNull();
    expect(called).toBe(false);
  });
});
