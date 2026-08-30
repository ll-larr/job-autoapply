import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSearch } from '../src/pipeline.js';
import { Queue } from '../src/core/queue.js';
import { normalizeVacancy } from '../src/core/vacancy.js';
import type { Vacancy } from '../src/core/vacancy.js';
import type { Adapter } from '../src/adapters/types.js';

const CONFIG = {
  minScore: 40, letterFullThreshold: 75, letterModels: ['m:free'],
  searchQueries: [{ query: 'аналитик' }], throttle: {},
};

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
      queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
      adapters: [mkAdapter(['ничего интересного', PROCESS_LANGUAGE])],
      generate: async () => { letterCalls++; return { letter: 'письмо', mode: 'hybrid' }; },
    });
    expect(rep.found).toBe(2);
    expect(rep.queued).toBe(1);
    expect(letterCalls).toBe(1); // на мусор токены не потрачены
  });

  it('повторный прогон не создаёт дублей', async () => {
    const opts = {
      queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
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
      queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
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
        queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
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
        queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
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
        queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
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
        queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
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
        queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
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
        queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
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
        queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
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

  // ==========================================================================
  // Несколько формулировок запроса (config.json#searchQueries) — задача
  // task-multiquery: разные фразы находят одну и ту же вакансию несколько
  // раз, обрабатывать (screening/scoring/письмо) её нужно ровно один раз.
  // ==========================================================================
  describe('несколько формулировок запроса', () => {
    /** Адаптер, который помнит вызовы (query, maxResults) и сам их отвечает. */
    function mkQueryAwareAdapter(
      responder: (query: string, maxResults: number | undefined) => Vacancy[],
      name = 'hh',
    ): Adapter & { calls: Array<{ query: string; maxResults: number | undefined }> } {
      const calls: Array<{ query: string; maxResults: number | undefined }> = [];
      return {
        name,
        calls,
        async search(filters) {
          calls.push({ query: filters.query, maxResults: filters.maxResults });
          return responder(filters.query, filters.maxResults);
        },
        async apply() { return { status: 'sent' }; },
      };
    }

    it('одна и та же вакансия под двумя формулировками — письмо генерируется один раз, а не дважды', async () => {
      let letterCalls = 0;
      const sameVacancy = normalizeVacancy({
        source: 'hh', sourceId: '1', title: 'Бизнес-аналитик', company: 'C', url: 'u',
        description: PROCESS_LANGUAGE, geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
      });
      const adapter = mkQueryAwareAdapter(() => [sameVacancy]);

      const rep = await runSearch({
        queue: q, config: CONFIG,
        queries: [{ query: 'бизнес-аналитик' }, { query: 'бизнес аналитик' }],
        adapters: [adapter],
        generate: async () => { letterCalls++; return { letter: 'письмо', mode: 'hybrid' as const }; },
      });

      expect(letterCalls).toBe(1); // не дважды за одну и ту же вакансию
      expect(rep.queued).toBe(1);
      expect(rep.duplicates).toBe(1); // второе появление той же вакансии
      expect(q.listByStatus('pending')).toHaveLength(1);
    });

    it('maxResults — общий бюджет на весь прогон, а не на каждую формулировку по отдельности', async () => {
      // Первая формулировка сама отдаёт ровно maxResults штук (адаптеры и так
      // уважают maxResults, см. src/adapters/hh.ts) — раз бюджет исчерпан
      // первым же запросом, до второй формулировки дело вообще не доходит.
      const adapter = mkQueryAwareAdapter((query, maxResults) => {
        const items = ['a', 'b', 'c', 'd', 'e'].map((suffix) => normalizeVacancy({
          source: 'hh', sourceId: `${query}-${suffix}`, title: 'Бизнес-аналитик', company: 'C',
          url: 'u', description: PROCESS_LANGUAGE, geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
        }));
        return maxResults === undefined ? items : items.slice(0, maxResults);
      });

      const rep = await runSearch({
        queue: q, config: CONFIG,
        queries: [{ query: 'q1' }, { query: 'q2' }],
        maxResults: 3,
        adapters: [adapter],
        generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
      });

      expect(adapter.calls).toEqual([{ query: 'q1', maxResults: 3 }]); // q2 не звался вовсе
      expect(rep.found).toBe(3);
      expect(rep.queued).toBe(3);
    });

    it('бюджет уменьшается остатком: вторая формулировка получает то, что не забрала первая', async () => {
      const adapter = mkQueryAwareAdapter((query, maxResults) => {
        // 'q1' сама возвращает только 2 штуки, сколько бы ни попросили —
        // естественное исчерпание выдачи, а не срабатывание её собственного лимита.
        const pool = query === 'q1' ? ['a', 'b'] : ['a', 'b', 'c', 'd', 'e'];
        const items = pool.map((suffix) => normalizeVacancy({
          source: 'hh', sourceId: `${query}-${suffix}`, title: 'Бизнес-аналитик', company: 'C',
          url: 'u', description: PROCESS_LANGUAGE, geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
        }));
        return maxResults === undefined ? items : items.slice(0, maxResults);
      });

      const rep = await runSearch({
        queue: q, config: CONFIG,
        queries: [{ query: 'q1' }, { query: 'q2' }],
        maxResults: 5,
        adapters: [adapter],
        generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
      });

      expect(adapter.calls).toEqual([
        { query: 'q1', maxResults: 5 },
        { query: 'q2', maxResults: 3 }, // 5 - 2 уже прочитанных
      ]);
      expect(rep.found).toBe(5); // 2 + 3, не 2 + 5
      expect(rep.queued).toBe(5);
    });

    describe('per-query ограничение juniorOnly (config.json#searchQueries[].constraints)', () => {
      function mkExperienceVacancy(sourceId: string, experience: Vacancy['experience'], title = 'Системный аналитик') {
        return normalizeVacancy({
          source: 'hh', sourceId, title, company: 'C', url: 'u',
          description: PROCESS_LANGUAGE, geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
          experience,
        });
      }

      it('отклоняет between1And3 под juniorOnly, хотя это проходит общий гейт опыта', async () => {
        const rep = await runSearch({
          queue: q, config: CONFIG,
          queries: [{ query: 'системный аналитик', constraints: { juniorOnly: true } }],
          adapters: [mkQueryAwareAdapter(() => [mkExperienceVacancy('1', 'between1And3')])],
          generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
        });
        expect(rep.rejectedJuniorOnly).toBe(1);
        expect(rep.queued).toBe(0);
        // Гейт срабатывает ДО дорогих проверок — ни одна из них не должна была
        // успеть отклонить/пропустить вакансию первой.
        expect(rep.rejectedExperience).toBe(0);
      });

      it('пропускает noExperience под juniorOnly — включая стажировки', async () => {
        const rep = await runSearch({
          queue: q, config: CONFIG,
          queries: [{ query: 'системный аналитик', constraints: { juniorOnly: true } }],
          adapters: [mkQueryAwareAdapter(() => [
            mkExperienceVacancy('1', 'noExperience', 'Стажёр — системный аналитик'),
          ])],
          generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
        });
        expect(rep.rejectedJuniorOnly).toBe(0);
        expect(rep.queued).toBe(1);
      });

      it('без constraints тот же between1And3 проходит как обычно', async () => {
        const rep = await runSearch({
          queue: q, config: CONFIG,
          queries: [{ query: 'системный аналитик' }], // без juniorOnly
          adapters: [mkQueryAwareAdapter(() => [mkExperienceVacancy('1', 'between1And3')])],
          generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
        });
        expect(rep.rejectedJuniorOnly).toBe(0);
        expect(rep.queued).toBe(1);
      });

      it('juniorOnly — свойство конкретной формулировки: другая формулировка без constraints её не наследует', async () => {
        // Та же вакансия (between1And3), но найдена ДРУГОЙ, нестеснённой
        // формулировкой раньше в списке — juniorOnly к ней не применяется,
        // потому что дедуп в пределах прогона видит её впервые под этой,
        // первой формулировкой (см. отчёт задачи, "конкурирующие constraints").
        const shared = mkExperienceVacancy('1', 'between1And3', 'Бизнес-аналитик');
        const rep = await runSearch({
          queue: q, config: CONFIG,
          queries: [
            { query: 'бизнес аналитик' }, // без constraints, идёт первой
            { query: 'системный аналитик', constraints: { juniorOnly: true } },
          ],
          adapters: [mkQueryAwareAdapter(() => [shared])],
          generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
        });
        expect(rep.rejectedJuniorOnly).toBe(0);
        expect(rep.duplicates).toBe(1); // второе появление под 'системный аналитик'
        expect(rep.queued).toBe(1);
      });
    });
  });
});
