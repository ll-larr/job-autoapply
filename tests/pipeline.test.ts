import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSearch } from '../src/pipeline.js';
import { Queue } from '../src/core/queue.js';
import { normalizeVacancy } from '../src/core/vacancy.js';
import type { Vacancy } from '../src/core/vacancy.js';
import type { Adapter, SearchFilters } from '../src/adapters/types.js';

const CONFIG = {
  minScore: 40, letterFullThreshold: 75, letterModels: ['m:free'],
  searchQueries: [{ query: 'аналитик' }], throttle: {},
};

function mkAdapter(descs: string[], name = 'hh'): Adapter {
  return {
    name,
    async search() {
      return descs.map((d, i) => normalizeVacancy({
        source: name, sourceId: String(i), title: 'Бизнес-аналитик', company: 'C',
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
      expect(rep.rejectedPlatform).toBe(0);
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
      expect(rep.rejectedPlatform).toBe(1);
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
      expect(rep.rejectedPlatform).toBe(0);
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
      expect(rep.rejectedPlatform).toBe(0);
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

      it('noExperience под juniorOnly проходит гейт опыта', async () => {
        const rep = await runSearch({
          queue: q, config: CONFIG,
          queries: [{ query: 'системный аналитик', constraints: { juniorOnly: true } }],
          adapters: [mkQueryAwareAdapter(() => [
            mkExperienceVacancy('1', 'noExperience', 'Системный аналитик'),
          ])],
          generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
        });
        expect(rep.rejectedJuniorOnly).toBe(0);
        expect(rep.queued).toBe(1);
      });

      it('но стажировка отсекается — она не по профилю', async () => {
        // Прежде тест утверждал обратное. Владелец 2026-09-01 отменил
        // «Аналитик внедрения-стажер» словами «стажерская вакансия не по
        // профилю», и это отменяет прежнее правило письма про junior+/middle:
        // откликаться на стажировки больше не будем вовсе.
        const rep = await runSearch({
          queue: q, config: CONFIG,
          queries: [{ query: 'системный аналитик', constraints: { juniorOnly: true } }],
          adapters: [mkQueryAwareAdapter(() => [
            mkExperienceVacancy('1', 'noExperience', 'Стажёр — системный аналитик'),
          ])],
          generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
        });
        expect(rep.queued).toBe(0);
        expect(rep.rejectedInternship).toBe(1);
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

  // ==========================================================================
  // AdapterSearchStats (утиная типизация lastSearchStats) — задача
  // task-review-fixes, находки 4 и 7. src/adapters/hh.ts отсеивает часть
  // карточек по опыту/грейду ДО открытия страницы вакансии, поэтому
  // возвращённый vacancies.length — лишь часть реально прочитанного.
  // Раньше report.found считался по vacancies.length: --limit не ограничивал
  // настоящую работу (адаптер честно уважал remaining как СВОЙ бюджет
  // карточек, но pipeline не уменьшал remaining на то, что было реально
  // прочитано — только на то, что вернулось), а rejectedExperience/
  // rejectedGrade оставались 0 для hh.ru, потому что отсеянные карточки
  // никогда не доходили до screenVacancy в этом же файле.
  // ==========================================================================
  describe('AdapterSearchStats — бюджет и отчёт считаются по реально прочитанному адаптером', () => {
    type Stats = { read: number; rejectedExperience: number; rejectedGrade: number; duplicatesSkipped?: number };

    /**
     * Симулирует hh.ru: "читает" `stats.read` карточек, но возвращает только
     * пригоршню полноценных Vacancy — ровно так же, как реальный HhAdapter,
     * отсеивающий по опыту/грейду до открытия страницы вакансии.
     */
    function mkPrescreeningAdapter(
      stats: Stats,
      returned: readonly Vacancy[],
      name = 'hh',
    ): Adapter & { lastSearchStats?: Stats; calls: Array<{ maxResults: number | undefined }> } {
      const calls: Array<{ maxResults: number | undefined }> = [];
      const adapter = {
        name,
        calls,
        lastSearchStats: undefined as Stats | undefined,
        async search(filters: SearchFilters) {
          calls.push({ maxResults: filters.maxResults });
          adapter.lastSearchStats = stats;
          return [...returned];
        },
        async apply() { return { status: 'sent' as const }; },
      };
      return adapter;
    }

    it('report.found считает read адаптера, а не длину возвращённого массива', async () => {
      const returned = [normalizeVacancy({
        source: 'hh', sourceId: '1', title: 'Бизнес-аналитик', company: 'C', url: 'u',
        description: PROCESS_LANGUAGE, geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
      })];
      const adapter = mkPrescreeningAdapter(
        { read: 50, rejectedExperience: 30, rejectedGrade: 6, duplicatesSkipped: 0 },
        returned,
      );
      const rep = await runSearch({
        queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
        adapters: [adapter],
        generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
      });
      expect(rep.found).toBe(50); // не 1 (returned.length)
    });

    it('складывает предфильтр адаптера в rejectedExperience/rejectedGrade суммарного отчёта', async () => {
      const adapter = mkPrescreeningAdapter(
        { read: 50, rejectedExperience: 30, rejectedGrade: 6, duplicatesSkipped: 0 },
        [],
      );
      const rep = await runSearch({
        queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
        adapters: [adapter],
        generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
      });
      expect(rep.rejectedExperience).toBe(30);
      expect(rep.rejectedGrade).toBe(6);
    });

    it('--limit реально ограничивает СЫРЫЕ карточки: вторая формулировка получает остаток от read, а не от returned.length', async () => {
      const adapter = mkPrescreeningAdapter(
        { read: 500, rejectedExperience: 495, rejectedGrade: 0, duplicatesSkipped: 0 },
        [],
      );
      await runSearch({
        queue: q, config: CONFIG,
        queries: [{ query: 'q1' }, { query: 'q2' }],
        maxResults: 500,
        adapters: [adapter],
        generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
      });
      // Первый вызов уже "прочитал" 500 сырых карточек (весь бюджет), хотя
      // вернул только 5 годных вакансий — второй вызов обязан получить
      // remaining=0 и не открывать вообще ни одной страницы, а не 495
      // (500 - 5 вернувшихся).
      expect(adapter.calls).toEqual([{ maxResults: 500 }]); // q2 не звался вовсе
    });

    it('без lastSearchStats (адаптер вроде hr.ge, ничего не отсеивает сам) — поведение как раньше, по vacancies.length', async () => {
      const rep = await runSearch({
        queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
        adapters: [mkAdapter([PROCESS_LANGUAGE, PROCESS_LANGUAGE])],
        generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
      });
      expect(rep.found).toBe(2);
      expect(rep.rejectedExperience).toBe(0);
      expect(rep.rejectedGrade).toBe(0);
    });

    it('duplicatesSkipped адаптера добавляется в report.duplicates', async () => {
      const adapter = mkPrescreeningAdapter(
        { read: 10, rejectedExperience: 0, rejectedGrade: 0, duplicatesSkipped: 4 },
        [],
      );
      const rep = await runSearch({
        queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
        adapters: [adapter],
        generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
      });
      expect(rep.duplicates).toBe(4);
    });
  });

  // ==========================================================================
  // seenThisRun передаётся адаптеру (задача task-review-fixes, находка 5) —
  // адаптер, который умеет читать SearchFilters.seenThisRun, может сам
  // пропустить дочитку уже виденной в этом прогоне вакансии, вместо того
  // чтобы читать её и тут же выбрасывать как дубль.
  // ==========================================================================
  describe('SearchFilters.seenThisRun — накопленный набор передаётся в каждый следующий search()', () => {
    function mkSeenCapturingAdapter(
      byQuery: Record<string, Vacancy[]>,
      name = 'hh',
    ): Adapter & { seenPerCall: string[][] } {
      // Снимок массивом в момент вызова, а не сама ссылка на Set: pipeline
      // передаёт один и тот же изменяемый Set во все вызовы этого прогона и
      // продолжает дописывать в него после возврата search() — сохранение
      // ссылки показало бы во ВСЕХ записях его финальное состояние.
      const seenPerCall: string[][] = [];
      return {
        name,
        seenPerCall,
        async search(filters) {
          seenPerCall.push([...(filters.seenThisRun ?? [])]);
          return byQuery[filters.query] ?? [];
        },
        async apply() { return { status: 'sent' as const }; },
      };
    }

    it('первый вызов видит пустой seenThisRun, второй — уже содержащий ключ вакансии из первого', async () => {
      const vacancyA = normalizeVacancy({
        source: 'hh', sourceId: '1', title: 'Бизнес-аналитик', company: 'C', url: 'u',
        description: PROCESS_LANGUAGE, geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
      });
      const adapter = mkSeenCapturingAdapter({ q1: [vacancyA], q2: [] });

      await runSearch({
        queue: q, config: CONFIG,
        queries: [{ query: 'q1' }, { query: 'q2' }],
        adapters: [adapter],
        generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
      });

      expect(adapter.seenPerCall).toHaveLength(2);
      expect(adapter.seenPerCall[0]).toEqual([]);
      expect(adapter.seenPerCall[1]).toEqual(['hh:1']);
    });
  });
});

/**
 * Адаптер с постраничной выдачей: у каждой формулировки свой конечный пул
 * вакансий, а search() честно отдаёт срез [skip, skip+maxResults) и перестаёт
 * отдавать что-либо, когда пул кончился. Ровно то поведение, на которое
 * опирается цель-по-доставленным: конвейер ходит порциями, пока не наберёт
 * заказанное или пока выдача не иссякнет.
 *
 * Записывает вызовы — по ним проверяется и продвижение skip, и равномерность
 * между формулировками.
 */
function mkPagedAdapter(
  pools: Record<string, string[]>,
  name = 'hh',
): Adapter & { calls: Array<{ query: string; skip: number; maxResults?: number }> } {
  const calls: Array<{ query: string; skip: number; maxResults?: number }> = [];
  return {
    name,
    calls,
    async search(filters: SearchFilters) {
      const skip = filters.skip ?? 0;
      calls.push({ query: filters.query, skip, maxResults: filters.maxResults });
      const chunk = pools[filters.query] ?? [];
      const slice = filters.maxResults === undefined
        ? chunk.slice(skip)
        : chunk.slice(skip, skip + filters.maxResults);
      return slice.map((d, i) => normalizeVacancy({
        source: name, sourceId: filters.query + '-' + String(skip + i), title: 'Бизнес-аналитик', company: 'C',
        url: 'https://' + name + '/vacancy/' + String(skip + i),
        description: d, geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
      }));
    },
    async apply() { return { status: 'sent' }; },
  };
}

/** Пул: каждая every-я вакансия проходит фильтры, остальные — мусор ниже minScore. */
function mkPool(size: number, every: number): string[] {
  return Array.from({ length: size }, (_, i) =>
    (i % every === 0 ? PROCESS_LANGUAGE : 'ничего интересного'));
}

describe('runSearch — заказ считается по ДОСТАВЛЕННЫМ вакансиям (target)', () => {
  it('набирает ровно заказанное число, сколько бы выдачи для этого ни пришлось прочитать', async () => {
    // Каждая десятая годная: чтобы доставить 3, надо прочитать больше 20
    // карточек. Прежняя семантика (число = потолок просмотра) при тех же 3
    // отдала бы одну вакансию из трёх прочитанных.
    const a = mkPagedAdapter({ 'аналитик': mkPool(200, 10) });
    const rep = await runSearch({
      queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
      target: 3, batchSize: 10, adapters: [a],
      generate: async () => ({ letter: 'письмо', mode: 'hybrid' }),
    });
    expect(rep.queued).toBe(3);
    expect(rep.stoppedBecause).toBe('target');
    expect(rep.found).toBeGreaterThan(3);
  });

  it('не перебирает заказ: лишние вакансии из последней порции в очередь не попадают', async () => {
    // Пул сплошь годный, порция 10, заказано 4 — в первой же порции годных
    // десять. В очередь обязаны лечь четыре.
    const a = mkPagedAdapter({ 'аналитик': mkPool(100, 1) });
    const rep = await runSearch({
      queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
      target: 4, batchSize: 10, adapters: [a],
      generate: async () => ({ letter: 'письмо', mode: 'hybrid' }),
    });
    expect(rep.queued).toBe(4);
    expect(q.listByStatus('pending')).toHaveLength(4);
  });

  it('следующая порция продолжает с того места, где кончилась прошлая', async () => {
    const a = mkPagedAdapter({ 'аналитик': mkPool(200, 10) });
    await runSearch({
      queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
      target: 3, batchSize: 10, adapters: [a],
      generate: async () => ({ letter: 'письмо', mode: 'hybrid' }),
    });
    const skips = a.calls.map((c) => c.skip);
    expect(skips.length).toBeGreaterThan(1);
    expect(skips[0]).toBe(0);
    // Строго возрастает: ни одна порция не перечитывает уже прочитанное.
    expect(skips).toEqual([...skips].sort((x, y) => x - y));
    expect(new Set(skips).size).toBe(skips.length);
  });

  it('делит заказ поровну между формулировками', async () => {
    const a = mkPagedAdapter({ 'первый': mkPool(100, 1), 'второй': mkPool(100, 1) });
    const rep = await runSearch({
      queue: q, config: CONFIG, queries: [{ query: 'первый' }, { query: 'второй' }],
      target: 4, batchSize: 1, adapters: [a],
      generate: async () => ({ letter: 'письмо', mode: 'hybrid' }),
    });
    expect(rep.queued).toBe(4);
    const rows = q.listByStatus('pending');
    const first = rows.filter((r) => r.vacancy.sourceId.startsWith('первый')).length;
    expect(first).toBe(2);
    expect(rows.length - first).toBe(2);
  });

  it('добирает остальными формулировками долю той, чья выдача кончилась', async () => {
    // У первой формулировки всего одна годная вакансия — её четверть заказа
    // некому выбрать, кроме второй формулировки.
    const a = mkPagedAdapter({ 'скудный': [PROCESS_LANGUAGE], 'богатый': mkPool(100, 1) });
    const rep = await runSearch({
      queue: q, config: CONFIG, queries: [{ query: 'скудный' }, { query: 'богатый' }],
      target: 4, batchSize: 1, adapters: [a],
      generate: async () => ({ letter: 'письмо', mode: 'hybrid' }),
    });
    expect(rep.queued).toBe(4);
    expect(rep.stoppedBecause).toBe('target');
    const rows = q.listByStatus('pending');
    expect(rows.filter((r) => r.vacancy.sourceId.startsWith('скудный'))).toHaveLength(1);
    expect(rows.filter((r) => r.vacancy.sourceId.startsWith('богатый'))).toHaveLength(3);
  });

  it('выдача кончилась раньше заказа — отдаёт что есть и называет причину', async () => {
    const a = mkPagedAdapter({ 'аналитик': [PROCESS_LANGUAGE, 'ничего интересного'] });
    const rep = await runSearch({
      queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
      target: 10, batchSize: 5, adapters: [a],
      generate: async () => ({ letter: 'письмо', mode: 'hybrid' }),
    });
    expect(rep.queued).toBe(1);
    expect(rep.stoppedBecause).toBe('exhausted');
  });

  it('потолок просмотра останавливает прогон, в котором подходящего не попадается', async () => {
    // Длинный пул сплошного мусора: без потолка цикл листал бы его до конца.
    // Предохранитель обязан остановить прогон и назваться в отчёте.
    const a = mkPagedAdapter({
      'аналитик': Array.from({ length: 5000 }, () => 'ничего интересного'),
    });
    const rep = await runSearch({
      queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
      target: 5, maxResults: 40, batchSize: 10, adapters: [a],
      generate: async () => ({ letter: 'письмо', mode: 'hybrid' }),
    });
    expect(rep.queued).toBe(0);
    expect(rep.found).toBe(40);
    expect(rep.stoppedBecause).toBe('scan_cap');
  });

  it('потолок есть и когда его не задали явно — прогон конечен', async () => {
    const a = mkPagedAdapter({
      'аналитик': Array.from({ length: 100000 }, () => 'ничего интересного'),
    });
    const rep = await runSearch({
      queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
      target: 1, batchSize: 50, adapters: [a],
      generate: async () => ({ letter: 'письмо', mode: 'hybrid' }),
    });
    expect(rep.stoppedBecause).toBe('scan_cap');
    expect(rep.found).toBeLessThanOrEqual(250);
  });

  it('упавший адаптер выбывает, а не крутится в цикле', async () => {
    let calls = 0;
    const broken: Adapter = {
      name: 'hh',
      async search() { calls++; throw new Error('выдача недоступна'); },
      async apply() { return { status: 'sent' }; },
    };
    const rep = await runSearch({
      queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
      target: 5, batchSize: 10, adapters: [broken],
      generate: async () => ({ letter: 'письмо', mode: 'hybrid' }),
    });
    expect(calls).toBe(1);
    expect(rep.adapterErrors).toHaveLength(1);
    expect(rep.stoppedBecause).toBe('exhausted');
  });

  it('без заказа поведение прежнее: каждая пара опрашивается ровно один раз', async () => {
    const a = mkPagedAdapter({ 'аналитик': mkPool(100, 10) });
    await runSearch({
      queue: q, config: CONFIG, queries: [{ query: 'аналитик' }],
      maxResults: 20, adapters: [a],
      generate: async () => ({ letter: 'письмо', mode: 'hybrid' }),
    });
    expect(a.calls).toHaveLength(1);
    expect(a.calls[0]!.maxResults).toBe(20);
  });
});
