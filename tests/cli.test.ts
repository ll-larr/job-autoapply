import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatProxyReport,
  resolveLimit,
  buildSearchQueries,
  formatQueryLabel,
  groupBySource,
  formatSearchReport,
  formatPanelStartup,
  formatSendPreflight,
  formatSendResult,
  formatStatusReport,
  buildAdapters,
  buildAdapterMap,
  runSearchCommand,
  specialtyOf,
} from '../src/cli.js';
import { Queue, type Status } from '../src/core/queue.js';
import { normalizeVacancy } from '../src/core/vacancy.js';
import type { Adapter } from '../src/adapters/types.js';
import type { SearchReport } from '../src/pipeline.js';
import type { SendReport } from '../src/core/sender.js';
import { seedSettings } from '../src/core/settings.js';
import { DEFAULT_SPECIALTY } from '../src/core/specialty-defaults.js';

const CONFIG = { minScore: 40, letterFullThreshold: 75, letterModels: ['m:free'], searchQueries: [], throttle: {} };

/** Для прогонов без Telegram: сообщение рекрутёру здесь не должно понадобиться. */
const NO_DM = async (): Promise<never> => { throw new Error('generateDm не должен вызываться для не-Telegram вакансий'); };

describe('buildSearchQueries', () => {
  const settings = seedSettings([
    { query: 'бизнес-аналитик' },
    { query: 'системный аналитик', constraints: { juniorOnly: true } },
  ], null);

  it('без аргументов — фразы всех включённых специальностей, каждая со своей специальностью', () => {
    const qs = buildSearchQueries(settings, []);
    expect(qs.map((q) => `${q.specialty!.id}:${q.query}`)).toEqual([
      'business-analyst:бизнес-аналитик', 'system-analyst:системный аналитик',
    ]);
  });

  it('выключенная специальность не ищет', () => {
    const s = structuredClone(settings);
    s.specialties[1]!.enabled = false;
    expect(buildSearchQueries(s, []).map((q) => q.query)).toEqual(['бизнес-аналитик']);
  });

  it('явная фраза — от первой включённой специальности', () => {
    const [q] = buildSearchQueries(settings, ['аналитик', 'данных']);
    expect(q).toMatchObject({ query: 'аналитик данных' });
    expect(q!.specialty!.id).toBe('business-analyst');
  });

  it('--specialty выбирает специальность по названию без учёта регистра', () => {
    const [q] = buildSearchQueries(settings, ['sa', '--specialty', 'системный АНАЛИТИК']);
    expect(q!.query).toBe('sa');
    expect(q!.specialty!.id).toBe('system-analyst');
  });

  it('неизвестная специальность и «нет включённых» — ошибки с объяснением', () => {
    expect(() => buildSearchQueries(settings, ['x', '--specialty', 'повар'])).toThrow(/повар/);
    const off = structuredClone(settings);
    for (const s of off.specialties) s.enabled = false;
    expect(() => buildSearchQueries(off, [])).toThrow(/включ/);
  });
});

describe('formatQueryLabel', () => {
  it('перечисляет формулировки для заголовка отчёта', () => {
    expect(formatQueryLabel([{ query: 'а' }, { query: 'б' }])).toBe('а | б');
  });
});

describe('groupBySource', () => {
  it('считает строки по source', () => {
    const counts = groupBySource([{ source: 'hh' }, { source: 'hh' }, { source: 'hrge' }]);
    expect(counts.get('hh')).toBe(2);
    expect(counts.get('hrge')).toBe(1);
  });

  it('пустой список — пустая карта', () => {
    expect(groupBySource([]).size).toBe(0);
  });
});

describe('formatSearchReport', () => {
  const BASE_REPORT: SearchReport = {
    found: 10, queued: 4, duplicates: 2, belowThreshold: 3, noCoreMatch: 1,
    rejectedExperience: 0, rejectedGrade: 0, rejectedStopword: 0, stopwordHits: {},
    rejectedTitle: 0, rejectedInternship: 0,
    tgNotVacancy: 0, tgNoContact: 0, tgSkippedChats: [], textDuplicates: 0,
    adapterErrors: [], stoppedBecause: 'target',
  };

  it('содержит все пункты отчёта, требуемые заданием', () => {
    const lines = formatSearchReport('бизнес-аналитик', BASE_REPORT, 0, true).join('\n');
    expect(lines).toContain('Просмотрено:             10');
    expect(lines).toContain('Поставлено в очередь:    4');
    expect(lines).toContain('Дубли:                   2');
    expect(lines).toContain('Отсеяно (ниже minScore): 3');
    expect(lines).toContain('Отсеяно (core-гейт):     1');
  });

  it('показывает каждый screening-фильтр поимённо', () => {
    // Поимённо и по отдельности: ссыпать их в одну строку значило бы врать —
    // «отсеяно по 1С: 9» при девяти вакансиях, где 1С никто не упоминал.
    const report: SearchReport = {
      ...BASE_REPORT, rejectedExperience: 5, rejectedGrade: 2,
      rejectedStopword: 2, stopwordHits: { '1С': 1, 'Битрикс': 1 },
      rejectedTitle: 4, rejectedInternship: 3,
    };
    const lines = formatSearchReport('q', report, 0, true).join('\n');
    expect(lines).toContain('Отсеяно (опыт):          5');
    expect(lines).toContain('Отсеяно (грейд):         2');
    expect(lines).toContain('Отсеяно (стоп-слова):   2 (1С: 1, Битрикс: 1)');
    expect(lines).toContain('Отсеяно (заголовок):    4');
    expect(lines).toContain('Отсеяно (стажировка):    3');
  });

  it('Telegram: счётчики и пропущенные чаты — только когда есть что сказать', () => {
    expect(formatSearchReport('q', BASE_REPORT, 0, true).join('\n')).not.toContain('Telegram');
    const lines = formatSearchReport('q', {
      ...BASE_REPORT, tgNotVacancy: 7, tgNoContact: 3, textDuplicates: 2,
      tgSkippedChats: [{ title: 'Работа в ИТ', why: 'чат недоступен' }],
    }, 0, true).join('\n');
    expect(lines).toContain('Telegram: не вакансия 7, без контакта 3, репостов 2');
    expect(lines).toContain('«Работа в ИТ» пропущен: чат недоступен');
  });

  it('видно, найден ли OPENROUTER_API_KEY', () => {
    expect(formatSearchReport('q', BASE_REPORT, 0, false).join('\n')).toContain('НЕ найден');
    expect(formatSearchReport('q', BASE_REPORT, 0, true).join('\n')).toContain('найден');
  });

  it('пустые письма видны и посчитаны относительно queued', () => {
    const lines = formatSearchReport('q', BASE_REPORT, 2, true).join('\n');
    expect(lines).toContain('Письма пустые:           2 из 4 поставленных в очередь — допиши вручную в панели');
  });

  it('без пустых писем не подсказывает дописывать вручную', () => {
    const lines = formatSearchReport('q', BASE_REPORT, 0, true).join('\n');
    expect(lines).not.toContain('допиши вручную');
  });

  it('перечисляет ошибки адаптеров поимённо', () => {
    const report: SearchReport = { ...BASE_REPORT, adapterErrors: [{ adapter: 'hh', message: 'сеть легла' }] };
    const lines = formatSearchReport('q', report, 0, true).join('\n');
    expect(lines).toContain('Ошибки адаптеров:        1');
    expect(lines).toContain('- hh: сеть легла');
  });

  it('без ошибок явно печатает "0", а не молчит', () => {
    const lines = formatSearchReport('q', BASE_REPORT, 0, true).join('\n');
    expect(lines).toContain('Ошибки адаптеров:        0');
  });
});

describe('formatPanelStartup', () => {
  it('сообщает число застрявших approved из прошлого прогона', () => {
    expect(formatPanelStartup(3, 4321).join('\n')).toContain('3 заявок остались в approved');
  });

  it('явно говорит, что застрявших нет, а не молчит про ноль', () => {
    expect(formatPanelStartup(0, 4321).join('\n')).toContain('Заявок, застрявших в approved с прошлого прогона, нет.');
  });

  it('печатает URL панели', () => {
    expect(formatPanelStartup(0, 4321).join('\n')).toContain('http://127.0.0.1:4321');
  });
});

describe('formatSendPreflight', () => {
  it('пустая очередь approved — явно "отправлять нечего", ни слова про сайты', () => {
    const lines = formatSendPreflight([]);
    expect(lines.join('\n')).toContain('Отправлять нечего');
  });

  it('группирует по источнику и называет число ДО отправки', () => {
    const lines = formatSendPreflight([{ source: 'hh' }, { source: 'hh' }, { source: 'hrge' }]).join('\n');
    expect(lines).toContain('Сейчас будет отправлено 3 заявок: hh: 2, hrge: 1.');
  });

  it('предупреждает, что hh — настоящий отклик через живую сессию', () => {
    const lines = formatSendPreflight([{ source: 'hh' }]).join('\n');
    expect(lines).toContain('hh — это настоящий отклик через залогиненный браузерный профиль пользователя');
  });
});

describe('formatSendResult', () => {
  const OK: SendReport = { sent: 3, failed: 0, halted: null, unthrottledSources: [], haltedSources: [], skippedEmptyLetter: [] };

  it('без halted — exitCode 0, никакого "ОСТАНОВЛЕНО"', () => {
    const { lines, exitCode } = formatSendResult(OK);
    expect(exitCode).toBe(0);
    expect(lines.join('\n')).not.toContain('ОСТАНОВЛЕНО');
    expect(lines.join('\n')).toContain('Отправлено: 3');
  });

  it.each([
    ['captcha', /капч/i],
    ['auth_required', /разлогинена/],
    ['killed', /вручную флагом stop/],
    ['too_many_failures', /отказов подряд/],
  ] as const)('halted reason=%s — exitCode 1 и понятное объяснение', (reason, pattern) => {
    const report: SendReport = {
      sent: 0, failed: 0, unthrottledSources: [],
      halted: { source: 'hh', reason }, haltedSources: [{ source: 'hh', reason }], skippedEmptyLetter: [],
    };
    const { lines, exitCode } = formatSendResult(report);
    expect(exitCode).toBe(1);
    expect(lines.join('\n')).toContain('ОСТАНОВЛЕНО');
    expect(lines.join('\n')).toMatch(pattern);
  });

  it('пустые письма названы громко: «Отправлено 0» иначе выглядит поломкой', () => {
    const report: SendReport = { ...OK, skippedEmptyLetter: ['Системный аналитик'] };
    const { lines } = formatSendResult(report);
    expect(lines.join('\n')).toContain('ВНИМАНИЕ');
    expect(lines.join('\n')).toContain('пустого письма');
    expect(lines.join('\n')).toContain('Системный аналитик');
    expect(lines.join('\n')).toContain('npm run letters');
  });

  it('unthrottledSources выводится громко, даже когда halted нет', () => {
    const report: SendReport = { ...OK, unthrottledSources: ['hrge'], haltedSources: [], skippedEmptyLetter: [] };
    const { lines, exitCode } = formatSendResult(report);
    expect(exitCode).toBe(0); // не halted — просто пропущенный источник, не остановка всей очереди
    expect(lines.join('\n')).toContain('ВНИМАНИЕ');
    expect(lines.join('\n')).toContain('hrge');
  });

  it('unthrottledSources выводится и вместе с halted одновременно', () => {
    const report: SendReport = {
      sent: 1, failed: 0, unthrottledSources: ['hrge'],
      halted: { source: 'hh', reason: 'captcha' },
      haltedSources: [{ source: 'hh', reason: 'captcha' }], skippedEmptyLetter: [],
    };
    const { lines } = formatSendResult(report);
    expect(lines.join('\n')).toContain('ОСТАНОВЛЕНО');
    expect(lines.join('\n')).toContain('ВНИМАНИЕ');
  });
});

describe('formatStatusReport', () => {
  const COUNTS: Record<Status, number> = { pending: 1, approved: 2, sent: 3, failed: 4, skipped: 5 };

  it('печатает все статусы в постоянном порядке', () => {
    const lines = formatStatusReport(COUNTS, false);
    expect(lines).toEqual(['pending: 1', 'approved: 2', 'sent: 3', 'failed: 4', 'skipped: 5']);
  });

  it('предупреждает про поднятый флаг остановки', () => {
    const lines = formatStatusReport(COUNTS, true);
    expect(lines.join('\n')).toContain('ВНИМАНИЕ: поднят флаг остановки');
  });

  it('без флага остановки — ни слова про него', () => {
    const lines = formatStatusReport(COUNTS, false);
    expect(lines.join('\n')).not.toContain('ВНИМАНИЕ');
  });
});

describe('buildAdapters / buildAdapterMap — сборка адаптеров без обращения к сети', () => {
  it('buildAdapters даёт все площадки с ожидаемыми именами', () => {
    const adapters = buildAdapters();
    expect(adapters.map((a) => a.name).sort()).toEqual(['careerist', 'hh', 'hrge']);
  });

  it('у каждой собранной площадки есть запись в config.throttle', () => {
    // Sender намеренно fail-closed: площадка с адаптером, но без записи о
    // паузах, пропускается целиком и не отправляет ничего (см. core/sender.ts).
    // Новый адаптер, забытый в config.json, выглядел бы как «отправка молча
    // не работает», поэтому связь проверяется здесь, а не в бою.
    const config = JSON.parse(readFileSync('config.json', 'utf8')) as { throttle: Record<string, unknown> };
    for (const a of buildAdapters()) {
      expect(config.throttle[a.name], `нет config.throttle["${a.name}"]`).toBeDefined();
    }
  });

  it('buildAdapterMap индексирует по имени', () => {
    const fake: Adapter = { name: 'x', async search() { return []; }, async apply() { return { status: 'sent' }; } };
    const map = buildAdapterMap([fake]);
    expect(map.get('x')).toBe(fake);
    expect(map.size).toBe(1);
  });
});

describe('runSearchCommand — связка pipeline + генерация письма + счётчик пустых писем', () => {
  let q: Queue;
  beforeEach(() => {
    q = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-cli-')), 'test.db'));
  });
  afterEach(() => q.close());

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

  const PROCESS_LANGUAGE =
    'Проводим gap-анализ AS-IS/TO-BE, пишем регламенты бизнес-процессов, ' +
    'готовим BRD и FSD, отвечаем за постановку задач.';

  it('новая специальность: её резюме и роль, письмо целиком, без скелета', async () => {
    const PM = {
      ...DEFAULT_SPECIALTY, id: 'pm', name: 'Менеджер продукта', legacyLetters: false,
      titleWords: ['аналитик'],
    };
    const seen: Array<{ resume: string; template: string; mode: string; role?: string }> = [];
    await runSearchCommand({
      queue: q, config: CONFIG, adapters: [mkAdapter([PROCESS_LANGUAGE])],
      queries: [{ query: 'pm', specialty: PM }], limit: 10,
      resumeFor: (s) => `РЕЗЮМЕ:${s.id}`,
      generateLetterFn: async (input) => {
        seen.push({ resume: input.resume, template: input.template, mode: input.mode, role: input.role });
        return { letter: 'п', mode: input.mode };
      },
      generateDmFn: NO_DM,
      pickTemplateFn: () => 'fullstack-analyst',
      readTemplate: (name) => `ШАБЛОН:${name}`,
    });
    expect(seen).toEqual([{ resume: 'РЕЗЮМЕ:pm', template: '', mode: 'full', role: 'Менеджер продукта' }]);
  });

  it('пост Telegram — сообщение рекрутёру (generateDm), не письмо; резюме и роль специальности', async () => {
    const tg: Adapter = {
      name: 'tg', queryless: true,
      async search(f) {
        if ((f.skip ?? 0) > 0) return [];
        return [normalizeVacancy({
          source: 'tg', sourceId: '-1001:7', title: 'Бизнес-аналитик', company: '', url: 'https://t.me/x/7',
          description: `Бизнес-аналитик. ${PROCESS_LANGUAGE}`, geo: '', postedAt: '2026-09-19T00:00:00Z',
          contact: 'hr', contentHash: 'h7', channel: 'Работа в ИТ',
        })];
      },
      async apply() { return { status: 'sent' }; },
    };
    const dm: Array<{ resume: string; role: string; url: string }> = [];
    await runSearchCommand({
      queue: q, config: CONFIG, adapters: [tg], queries: [{ query: 'x' }], limit: 10,
      resumeFor: (s) => `РЕЗЮМЕ:${s.id}`,
      generateLetterFn: async () => { throw new Error('письмо для поста Telegram писаться не должно'); },
      generateDmFn: async (input) => {
        dm.push({ resume: input.resume, role: input.role, url: input.vacancy.url });
        return { letter: 'Здравствуйте! https://t.me/x/7', mode: 'dm' };
      },
      pickTemplateFn: () => 'fullstack-analyst',
      readTemplate: () => 'СКЕЛЕТ',
    });
    expect(dm).toEqual([{ resume: 'РЕЗЮМЕ:business-analyst', role: 'Бизнес-аналитик', url: 'https://t.me/x/7' }]);
    expect(q.listByStatus('pending')[0]!.letterMode).toBe('dm');
  });

  it('specialtyOf: удалённая специальность — бизнес-аналитик', () => {
    const settings = seedSettings(undefined, null);
    expect(specialtyOf(settings, 'system-analyst').name).toBe('Системный аналитик');
    expect(specialtyOf(settings, 'нет-такой').id).toBe('business-analyst');
  });

  it('вызывает generateLetterFn с резюме/скелетом из инъецированных зависимостей, не трогая диск и сеть', async () => {
    let receivedResume: string | undefined;
    let receivedTemplate: string | undefined;
    let receivedModels: string[] | undefined;

    const { report, emptyLetters } = await runSearchCommand({
      queue: q, config: CONFIG, adapters: [mkAdapter([PROCESS_LANGUAGE])],
      queries: [{ query: 'бизнес-аналитик' }], limit: 10, resumeFor: () => 'ФЕЙКОВОЕ РЕЗЮМЕ',
      generateLetterFn: async (input, options) => {
        receivedResume = input.resume;
        receivedTemplate = input.template;
        receivedModels = options.models;
        return { letter: 'готовое письмо', mode: input.mode };
      },
      generateDmFn: NO_DM,
      pickTemplateFn: () => 'fullstack-analyst',
      readTemplate: (name) => `ШАБЛОН:${name}`,
    });

    expect(report.queued).toBe(1);
    expect(emptyLetters).toBe(0);
    expect(receivedResume).toBe('ФЕЙКОВОЕ РЕЗЮМЕ');
    expect(receivedTemplate).toBe('ШАБЛОН:fullstack-analyst');
    expect(receivedModels).toEqual(CONFIG.letterModels);
    expect(q.listByStatus('pending')).toHaveLength(1);
    expect(q.listByStatus('pending')[0]!.letter).toBe('готовое письмо');
  });

  it('считает пустые письма (mode "none"), но не прерывает поиск и не роняет queued', async () => {
    const { report, emptyLetters } = await runSearchCommand({
      queue: q, config: CONFIG, adapters: [mkAdapter([PROCESS_LANGUAGE])],
      queries: [{ query: 'q' }], limit: 10, resumeFor: () => 'r',
      generateLetterFn: async () => ({ letter: '', mode: 'none' }),
      generateDmFn: NO_DM,
      pickTemplateFn: () => 'fullstack-analyst',
      readTemplate: () => 't',
    });

    expect(report.queued).toBe(1); // пустое письмо не мешает вакансии попасть в очередь
    expect(emptyLetters).toBe(1);
    expect(q.listByStatus('pending')[0]!.letter).toBe('');
    expect(q.listByStatus('pending')[0]!.letterMode).toBe('none');
  });

  it('не вызывает generateLetterFn для вакансий, отсеянных до генерации письма', async () => {
    let calls = 0;
    const { report } = await runSearchCommand({
      queue: q, config: CONFIG, adapters: [mkAdapter(['мусор без релевантных слов'])],
      queries: [{ query: 'q' }], limit: 10, resumeFor: () => 'r',
      generateLetterFn: async () => { calls++; return { letter: 'x', mode: 'hybrid' }; },
      generateDmFn: NO_DM,
      pickTemplateFn: () => 'fullstack-analyst',
      readTemplate: () => 't',
    });
    expect(report.queued).toBe(0);
    expect(calls).toBe(0);
  });
});

describe('resolveLimit', () => {
  it('по умолчанию ограничивает прогон, а не берёт всё подряд', () => {
    // Без предела search берёт всё, что прошло гейт, и зовёт модель на каждую.
    // Живой замер 2026-08-30: одно письмо доходило до 371 секунды.
    expect(resolveLimit(['бизнес-аналитик'])).toBe(500);
  });

  it('читает --limit', () => {
    expect(resolveLimit(['бизнес-аналитик', '--limit', '3'])).toBe(3);
  });

  it('бросает на мусорном значении, а не молча берёт всё', () => {
    expect(() => resolveLimit(['--limit', '0'])).toThrow('--limit');
    expect(() => resolveLimit(['--limit', 'много'])).toThrow('--limit');
    expect(() => resolveLimit(['--limit'])).toThrow('--limit');
  });
});


describe('formatProxyReport — что сказать в консоли про прокси', () => {
  it('нашёлся — называет адрес и откуда он взялся', () => {
    const text = formatProxyReport({
      found: { host: '127.0.0.1', port: 10809, source: 'windows' }, checked: ['127.0.0.1:10809'],
    }).join(' ');
    expect(text).toMatch(/127\.0\.0\.1:10809/);
    expect(text).toMatch(/настроек Windows/);
  });

  it('нашёлся по процессу VPN-клиента — так и говорит', () => {
    const text = formatProxyReport({
      found: { host: '127.0.0.1', port: 10808, source: 'vpn-process' }, checked: ['127.0.0.1:10808'],
    }).join(' ');
    expect(text).toMatch(/VPN-клиент/);
  });

  it('не нашёлся — предупреждает, называет проверенное и НЕ гонит перезапускать', () => {
    // Прокси ищется на каждое письмо заново: включил VPN — следующее письмо
    // пойдёт через него. Совет перезапустить был бы лишним шагом.
    const text = formatProxyReport({ found: null, checked: ['127.0.0.1:10809', '127.0.0.1:10801'] }).join(' ');
    expect(text).toMatch(/ВНИМАНИЕ/);
    expect(text).toMatch(/включи VPN/i);
    expect(text).toMatch(/127\.0\.0\.1:10809, 127\.0\.0\.1:10801/);
    expect(text).not.toMatch(/перезапус|Ctrl\+C|use-env-proxy/i);
  });
});
