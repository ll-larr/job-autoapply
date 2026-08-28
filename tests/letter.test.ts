import { describe, it, expect } from 'vitest';
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

describe('buildPrompt — порядок для кэша', () => {
  it('стабильный блок идёт первым и помечен cache_control', () => {
    const p = buildPrompt({
      vacancy: mk(), matched: ['sql'], mode: 'hybrid', resume: RESUME, template: 'x',
    });
    expect(p.system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(p.system[0]!.text).toContain(RESUME);
  });

  it('текст вакансии идёт в messages, а не в system — он волатилен', () => {
    const p = buildPrompt({
      vacancy: mk({ description: 'УНИКАЛЬНЫЙ ТЕКСТ' }), matched: ['sql'],
      mode: 'hybrid', resume: RESUME, template: 'x',
    });
    expect(JSON.stringify(p.system)).not.toContain('УНИКАЛЬНЫЙ ТЕКСТ');
    expect(JSON.stringify(p.messages)).toContain('УНИКАЛЬНЫЙ ТЕКСТ');
  });

  it('режим full не подмешивает скелет', () => {
    const p = buildPrompt({
      vacancy: mk(), matched: [], mode: 'full', resume: RESUME, template: 'СКЕЛЕТ',
    });
    expect(JSON.stringify(p)).not.toContain('СКЕЛЕТ');
  });
});

describe('generateLetter', () => {
  it('возвращает текст модели и выбранный режим', async () => {
    const fake = {
      messages: {
        create: async () => ({ content: [{ type: 'text', text: 'ГОТОВОЕ ПИСЬМО' }] }),
      },
    };
    const r = await generateLetter(
      { vacancy: mk(), matched: [], mode: 'hybrid', resume: RESUME, template: 't' },
      fake as never,
    );
    expect(r.letter).toBe('ГОТОВОЕ ПИСЬМО');
    expect(r.mode).toBe('hybrid');
  });

  it('на ошибке модели возвращает пустое письмо и режим none — человек напишет руками', async () => {
    const fake = {
      messages: { create: async () => { throw new Error('rate limit'); } },
    };
    const r = await generateLetter(
      { vacancy: mk(), matched: [], mode: 'hybrid', resume: RESUME, template: 't' },
      fake as never,
    );
    expect(r.letter).toBe('');
    expect(r.mode).toBe('none');
  });
});
