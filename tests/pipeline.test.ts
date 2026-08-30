import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSearch } from '../src/pipeline.js';
import { Queue } from '../src/core/queue.js';
import { normalizeVacancy } from '../src/core/vacancy.js';
import type { Adapter } from '../src/adapters/types.js';

const CONFIG = { minScore: 40, letterFullThreshold: 75, letterModels: ['m:free'], throttle: {} };

function mkAdapter(descs: string[], name = 'hh'): Adapter {
  return {
    name,
    async search() {
      return descs.map((d, i) => normalizeVacancy({
        source: name, sourceId: String(i), title: 'БА', company: 'C',
        url: `https://${name}/vacancy/${i}`, description: d, geo: 'Москва',
        postedAt: '2026-08-20T00:00:00Z',
      }));
    },
    async apply() { return { status: 'sent' }; },
  };
}

// Набирает > minScore(40) целиком из НЕ-core групп: SQL(6) + DWH/ClickHouse(5)
// + REST(6) + Kafka(8) + UML(6) + CJM/ROI, т.е. product(8) + LLM, т.е. ai-llm(22)
// = 61. Ни одного слова про процессный дизайн или требования/документацию —
// ровно тот случай, который раньше проходил в очередь по чистой SQL-выборке.
const SQL_EXCEL_NO_CORE =
  'Извлекаем данные через SQL и Excel, работаем с DWH и ClickHouse, ' +
  'интеграции через REST, читаем топики Kafka, рисуем диаграммы UML, ' +
  'считаем CJM и ROI, промптим LLM.';

// Набирает score выше minScore за счёт process-design (28) и
// requirements-docs (24) — ровно то, что гейт обязан пропускать.
const PROCESS_LANGUAGE =
  'Проводим gap-анализ AS-IS/TO-BE, пишем регламенты бизнес-процессов, ' +
  'готовим BRD и FSD, отвечаем за постановку задач.';

let q: Queue;
beforeEach(() => {
  q = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-p-')), 'test.db'));
});
afterEach(() => q.close());

describe('runSearch', () => {
  it('отбрасывает вакансии ниже minScore до генерации письма', async () => {
    let letterCalls = 0;
    const rep = await runSearch({
      queue: q, config: CONFIG, filters: { query: 'аналитик' },
      adapters: [mkAdapter(['ничего интересного', PROCESS_LANGUAGE])],
      generate: async () => { letterCalls++; return { letter: 'письмо', mode: 'hybrid' }; },
    });
    expect(rep.found).toBe(2);
    expect(rep.queued).toBe(1);
    expect(letterCalls).toBe(1); // на мусор токены не потрачены
  });

  it('повторный прогон не создаёт дублей', async () => {
    const opts = {
      queue: q, config: CONFIG, filters: { query: 'аналитик' },
      adapters: [mkAdapter([PROCESS_LANGUAGE])],
      generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
    };
    await runSearch(opts);
    const second = await runSearch(opts);
    expect(second.queued).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(q.listByStatus('pending')).toHaveLength(1);
  });

  it('падение одного адаптера не роняет остальные', async () => {
    const broken: Adapter = {
      name: 'broken',
      async search() { throw new Error('сеть легла'); },
      async apply() { return { status: 'sent' }; },
    };
    const rep = await runSearch({
      queue: q, config: CONFIG, filters: { query: 'аналитик' },
      adapters: [broken, mkAdapter([PROCESS_LANGUAGE])],
      generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
    });
    expect(rep.queued).toBe(1);
    expect(rep.adapterErrors).toHaveLength(1);
  });

  describe('гейт core-релевантности', () => {
    it('отклоняет вакансию без процессного/требований языка, даже если скор выше minScore', async () => {
      let letterCalls = 0;
      const rep = await runSearch({
        queue: q, config: CONFIG, filters: { query: 'аналитик' },
        adapters: [mkAdapter([SQL_EXCEL_NO_CORE])],
        generate: async () => { letterCalls++; return { letter: 'письмо', mode: 'hybrid' as const }; },
      });
      expect(rep.queued).toBe(0);
      expect(rep.noCoreMatch).toBe(1);
      expect(letterCalls).toBe(0); // гейт стоит до генерации письма
      expect(q.listByStatus('pending')).toHaveLength(0);
    });

    it('пропускает вакансию с процессным/требований языком', async () => {
      const rep = await runSearch({
        queue: q, config: CONFIG, filters: { query: 'аналитик' },
        adapters: [mkAdapter([PROCESS_LANGUAGE])],
        generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
      });
      expect(rep.queued).toBe(1);
      expect(rep.noCoreMatch).toBe(0);
      expect(q.listByStatus('pending')).toHaveLength(1);
    });
  });

  describe('жёсткие screening-фильтры (опыт/грейд/1С)', () => {
    function mkAdapterOf(
      v: Omit<Parameters<typeof normalizeVacancy>[0], 'source'>, name = 'hh',
    ): Adapter {
      return {
        name,
        async search() { return [normalizeVacancy({ source: name, ...v })]; },
        async apply() { return { status: 'sent' }; },
      };
    }

    it('отклоняет по опыту (структурный маркер) до генерации письма и до скоринга', async () => {
      let letterCalls = 0;
      const rep = await runSearch({
        queue: q, config: CONFIG, filters: { query: 'аналитик' },
        adapters: [mkAdapterOf({
          sourceId: '1', title: 'Бизнес-аналитик', company: 'C', url: 'u',
          description: PROCESS_LANGUAGE, geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
          experience: 'moreThan6',
        })],
        generate: async () => { letterCalls++; return { letter: 'письмо', mode: 'hybrid' as const }; },
      });
      expect(rep.queued).toBe(0);
      expect(rep.rejectedExperience).toBe(1);
      expect(rep.rejectedGrade).toBe(0);
      expect(rep.rejected1c).toBe(0);
      expect(rep.belowThreshold).toBe(0);
      expect(rep.noCoreMatch).toBe(0);
      expect(letterCalls).toBe(0);
    });

    it('отклоняет по грейду заголовка до генерации письма', async () => {
      let letterCalls = 0;
      const rep = await runSearch({
        queue: q, config: CONFIG, filters: { query: 'аналитик' },
        adapters: [mkAdapterOf({
          sourceId: '1', title: 'Ведущий бизнес-аналитик', company: 'C', url: 'u',
          description: PROCESS_LANGUAGE, geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
        })],
        generate: async () => { letterCalls++; return { letter: 'письмо', mode: 'hybrid' as const }; },
      });
      expect(rep.queued).toBe(0);
      expect(rep.rejectedGrade).toBe(1);
      expect(letterCalls).toBe(0);
    });

    it('отклоняет 1С-центричную вакансию до генерации письма', async () => {
      let letterCalls = 0;
      const rep = await runSearch({
        queue: q, config: CONFIG, filters: { query: 'аналитик' },
        adapters: [mkAdapterOf({
          sourceId: '1', title: 'Аналитик 1С', company: 'C', url: 'u',
          description: PROCESS_LANGUAGE, geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
        })],
        generate: async () => { letterCalls++; return { letter: 'письмо', mode: 'hybrid' as const }; },
      });
      expect(rep.queued).toBe(0);
      expect(rep.rejected1c).toBe(1);
      expect(letterCalls).toBe(0);
    });

    it('вакансия, где 1С — одна из систем среди прочих, проходит screening и доходит до очереди', async () => {
      const rep = await runSearch({
        queue: q, config: CONFIG, filters: { query: 'аналитик' },
        adapters: [mkAdapterOf({
          sourceId: '1', title: 'Бизнес-аналитик', company: 'C', url: 'u',
          description: `${PROCESS_LANGUAGE} Работаем со стеком: SAP, 1С, Oracle.`,
          geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
        })],
        generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
      });
      expect(rep.rejected1c).toBe(0);
      expect(rep.queued).toBe(1);
    });

    it('обычная junior/middle вакансия без нарушений доходит до очереди', async () => {
      const rep = await runSearch({
        queue: q, config: CONFIG, filters: { query: 'аналитик' },
        adapters: [mkAdapterOf({
          sourceId: '1', title: 'Бизнес-аналитик', company: 'C', url: 'u',
          description: PROCESS_LANGUAGE, geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
          experience: 'between1And3',
        })],
        generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
      });
      expect(rep.rejectedExperience).toBe(0);
      expect(rep.rejectedGrade).toBe(0);
      expect(rep.rejected1c).toBe(0);
      expect(rep.queued).toBe(1);
    });
  });
});
