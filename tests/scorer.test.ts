import { describe, it, expect } from 'vitest';
import { scoreVacancy, DEFAULT_WEIGHTS } from '../src/core/scorer.js';
import { normalizeVacancy } from '../src/core/vacancy.js';

function v(description: string, title = 'Бизнес-аналитик') {
  return normalizeVacancy({
    source: 'hh', sourceId: 'x', title, company: 'C',
    url: 'u', description, geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
  });
}

describe('scoreVacancy', () => {
  it('пустое описание даёт ноль и пустой список совпадений', () => {
    const r = scoreVacancy(v('Ищем человека.'));
    expect(r.score).toBe(0);
    expect(r.matched).toEqual([]);
  });

  it('AI/LLM весит больше, чем BPMN — это дифференциатор, а не гигиена', () => {
    const ai = scoreVacancy(v('Требуется опыт с LLM и AI-агентами'));
    const bpmn = scoreVacancy(v('Требуется BPMN'));
    expect(ai.score).toBeGreaterThan(bpmn.score);
  });

  it('совпадение в заголовке считается так же, как в описании', () => {
    const inTitle = scoreVacancy(v('текст без ключевиков', 'SQL-аналитик'));
    expect(inTitle.matched).toContain('sql');
  });

  it('ключевик засчитывается один раз, сколько бы ни повторялся', () => {
    const once = scoreVacancy(v('SQL'));
    const many = scoreVacancy(v('SQL SQL SQL SQL SQL'));
    expect(many.score).toBe(once.score);
  });

  it('скор ограничен сверху сотней', () => {
    // По одному настоящему ключевику на каждую группу: сырая сумма весов 102,
    // поэтому тест действительно проходит через Math.min(100, total).
    const everyGroup = 'LLM SQL DWH REST BRD ROI BPMN UML Kafka';
    const r = scoreVacancy(v(everyGroup));
    expect(r.matched).toHaveLength(Object.keys(DEFAULT_WEIGHTS).length);
    expect(r.score).toBe(100);
  });

  it('возвращает совпавшие ключевики — они идут в письмо', () => {
    const r = scoreVacancy(v('Нужен SQL, Kafka и BPMN'));
    expect(r.matched.sort()).toEqual(['bpmn', 'kafka', 'sql']);
  });
});
