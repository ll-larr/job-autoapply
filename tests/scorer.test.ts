import { describe, it, expect } from 'vitest';
import { scoreVacancy } from '../src/core/scorer.js';
import { BA_SKILLS } from '../src/core/specialty-defaults.js';
import type { Skill } from '../src/core/specialty.js';
import { normalizeVacancy } from '../src/core/vacancy.js';

function v(description: string, title = 'Бизнес-аналитик') {
  return normalizeVacancy({
    source: 'hh', sourceId: 'x', title, company: 'C',
    url: 'u', description, geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
  });
}

describe('scoreVacancy', () => {
  it('пустое описание даёт ноль, пустой список совпадений и не проходит core-гейт', () => {
    const r = scoreVacancy(v('Ищем человека.'));
    expect(r.score).toBe(0);
    expect(r.matched).toEqual([]);
    expect(r.hasCoreMatch).toBe(false);
  });

  it('процессный дизайн — новое ядро, весит больше, чем AI/LLM', () => {
    const process = scoreVacancy(v('Проводим gap-анализ AS-IS/TO-BE и пишем регламенты'));
    const ai = scoreVacancy(v('Требуется опыт с LLM и AI-агентами'));
    expect(process.score).toBeGreaterThan(ai.score);
  });

  it('требования и документация весят больше, чем AI/LLM', () => {
    const reqs = scoreVacancy(v('Пишем BRD, FSD и ведём постановку задач разработчикам'));
    const ai = scoreVacancy(v('Требуется опыт с LLM и AI-агентами'));
    expect(reqs.score).toBeGreaterThan(ai.score);
  });

  it('SQL уронен ниже UML — это уже не то, что тащит скор вверх', () => {
    const sql = scoreVacancy(v('Требуется SQL'));
    const uml = scoreVacancy(v('Требуется UML'));
    expect(sql.score).toBeLessThanOrEqual(uml.score);
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
    // По одному настоящему ключевику на каждую из девяти групп: сырая сумма
    // весов 113 (см. комментарий в scorer.ts), поэтому тест действительно
    // проходит через Math.min(100, total), а не просто совпадает с ним.
    const everyGroup = 'BPMN BRD LLM ROI Kafka UML REST SQL DWH';
    const r = scoreVacancy(v(everyGroup));
    expect(r.matched).toHaveLength(BA_SKILLS.length);
    expect(r.score).toBe(100);
  });

  it('возвращает совпавшие ключевики — они идут в письмо', () => {
    const r = scoreVacancy(v('Нужен SQL, Kafka и BPMN'));
    expect(r.matched.sort()).toEqual(['kafka', 'process-design', 'sql']);
  });

  describe('hasCoreMatch', () => {
    it('false, если совпали только некритичные группы (SQL, DWH, Kafka, UML, интеграции, продукт, AI/LLM)', () => {
      const r = scoreVacancy(v(
        'Нужен SQL, DWH, ClickHouse, Kafka, UML, REST, Postman, CJM, ROI, LLM и RAG',
      ));
      expect(r.hasCoreMatch).toBe(false);
      expect(r.matched).not.toContain('process-design');
      expect(r.matched).not.toContain('requirements-docs');
    });

    it('true при совпадении process-design (например, регламент бизнес-процесса)', () => {
      const r = scoreVacancy(v('Описываем регламент бизнес-процесса'));
      expect(r.hasCoreMatch).toBe(true);
      expect(r.matched).toContain('process-design');
    });

    it('true при совпадении requirements-docs (например, сбор бизнес-требований)', () => {
      const r = scoreVacancy(v('Собираем бизнес-требования и пишем ТЗ'));
      expect(r.hasCoreMatch).toBe(true);
      expect(r.matched).toContain('requirements-docs');
    });
  });

  describe('русскоязычные паттерны process-design и requirements-docs', () => {
    it('AS-IS/TO-BE и gap-анализ', () => {
      expect(scoreVacancy(v('Строим модель AS-IS, предлагаем TO-BE')).matched)
        .toContain('process-design');
      expect(scoreVacancy(v('Проводим гэп-анализ текущих процессов')).matched)
        .toContain('process-design');
    });

    it('процессная модель и оптимизация процессов', () => {
      expect(scoreVacancy(v('Строим процессную модель компании')).matched)
        .toContain('process-design');
      expect(scoreVacancy(v('Занимаемся оптимизацией процессов подразделения')).matched)
        .toContain('process-design');
    });

    it('ТЗ распознаётся как аббревиатура, а не подстрока', () => {
      expect(scoreVacancy(v('Пишем ТЗ для разработки')).matched)
        .toContain('requirements-docs');
      // "тз" строчными — не аббревиатура, ложных срабатываний внутри
      // случайных слов быть не должно.
      expect(scoreVacancy(v('метатзисы это не аббревиатура')).matched)
        .not.toContain('requirements-docs');
    });

    it('постановка задач и Definition of Ready', () => {
      expect(scoreVacancy(v('Отвечает за постановку задач команде разработки')).matched)
        .toContain('requirements-docs');
      expect(scoreVacancy(v('Работаем по Definition of Ready')).matched)
        .toContain('requirements-docs');
    });
  });
});

describe('scoreVacancy — любой профиль', () => {
  const skills: Skill[] = [
    { id: 'roadmap', name: 'Роадмап', synonyms: ['роадмап', 'roadmap'], weight: 30, core: true },
    { id: 'metrics', name: 'Метрики', synonyms: ['метрик', 'retention'], weight: 10, core: false },
  ];

  it('скор нормируется на сумму весов профиля', () => {
    // 30 из 40 → 30 × 113 / 40 = 84.75 → 85
    expect(scoreVacancy(v('Ведём роадмап продукта'), skills).score).toBe(85);
    expect(scoreVacancy(v('Роадмап, метрики, retention'), skills).score).toBe(100);
  });

  it('вес 0 выключает навык целиком — и из суммы, и из гейта ядра', () => {
    const off: Skill[] = [{ ...skills[0]!, weight: 0 }, skills[1]!];
    const r = scoreVacancy(v('Ведём роадмап и метрики'), off);
    expect(r.matched).toEqual(['metrics']);
    expect(r.score).toBe(100); // 10 из 10 → 113 → потолок
    expect(r.hasCoreMatch).toBe(true); // ядер с весом > 0 не осталось — требовать нечего
  });

  it('сумма весов 0 — скор 0', () => {
    expect(scoreVacancy(v('роадмап'), []).score).toBe(0);
  });

  it('ядро есть, но не совпало — hasCoreMatch false', () => {
    expect(scoreVacancy(v('Считаем метрики'), skills).hasCoreMatch).toBe(false);
  });
});
