import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * panel.html — единственный файл интерфейса, чистый HTML+JS без сборки
 * (см. src/ui/server.ts: он читается и отдаётся как есть, readFileSync).
 * Юнит-тестов на встроенный <script> в проекте раньше не было; вместо того
 * чтобы поднимать headless-браузер ради двух чистых функций форматирования,
 * извлекаем исходник конкретной функции по имени и выполняем его через
 * `new Function` — сама функция самодостаточна (никаких обращений к DOM),
 * так что это настоящее исполнение реального кода страницы, а не его копия.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractFunction(html: string, name: string): any {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  if (start === -1) throw new Error(`функция ${name} не найдена в panel.html`);
  const braceStart = html.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  const source = html.slice(start, i);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function(`${source}\nreturn ${name};`)();
}

const html = readFileSync('src/ui/panel.html', 'utf8');

describe('panel.html — buildSendResultText (задача task-review-fixes, находка 6)', () => {
  const buildSendResultText = extractFunction(html, 'buildSendResultText');

  it('упоминает пропущенные источники и причину, когда unthrottledSources непусто', () => {
    // src/core/sender.ts документирует unthrottledSources как: "The caller is
    // responsible for surfacing this — a skip that nobody looks at is as bad
    // as no protection at all." Раньше строка результата собиралась только
    // из sent/failed/halted, и площадка без записи в config.throttle
    // отправляла молча ноль заявок, а панель писала "Отправлено 0, не удалось
    // 0" — неотличимо от пустой очереди.
    const text = buildSendResultText({ sent: 2, failed: 0, halted: null, unthrottledSources: ['hrge'] });
    expect(text).toMatch(/hrge/);
    expect(text).toMatch(/throttle|пропущ/i);
  });

  it('молчит про пропуски, когда unthrottledSources пуст', () => {
    const text = buildSendResultText({ sent: 3, failed: 1, halted: null, unthrottledSources: [] });
    expect(text).not.toMatch(/пропущ/i);
    expect(text).toContain('Отправлено 3');
    expect(text).toContain('не удалось 1');
  });

  it('упоминает и остановку, и пропущенные источники одновременно, если есть оба', () => {
    const text = buildSendResultText({
      sent: 1, failed: 0,
      halted: { source: 'hh', reason: 'captcha' },
      unthrottledSources: ['hrge'],
    });
    expect(text).toMatch(/captcha/);
    expect(text).toMatch(/hrge/);
  });
});

describe('panel.html — formatElapsed (задача task-review-fixes, находка 9)', () => {
  const formatElapsed = extractFunction(html, 'formatElapsed');

  it('показывает прошедшее время в секундах, когда startedAt задан', () => {
    // startedAt писался в SendState/SearchState (src/ui/server.ts) и не
    // читался ни одной ручкой статуса — для операции, идущей минутами, "уже
    // прошло N секунд" не декоративная мелочь.
    expect(formatElapsed(1000, 4500)).toBe(' (4 c)'); // (4500-1000)/1000=3.5 -> round 4
  });

  it('пустая строка, когда startedAt отсутствует (операция ещё не запускалась)', () => {
    expect(formatElapsed(null, Date.now())).toBe('');
    expect(formatElapsed(undefined, Date.now())).toBe('');
  });

  it('не уходит в отрицательное время при небольшом рассинхроне часов', () => {
    expect(formatElapsed(5000, 4999)).toBe(' (0 c)');
  });
});

describe('panel.html — buildSendResultText, Telegram', () => {
  const buildSendResultText = extractFunction(html, 'buildSendResultText');

  it('называет отложенные контакты и предупреждения', () => {
    const text = buildSendResultText({
      sent: 1, failed: 0, halted: null, unthrottledSources: [],
      deferredContacts: [{ contact: 'hr_a', until: 0, title: 'БА' }],
      warnings: ['БА: резюме не приложилось'],
    });
    expect(text).toContain('отложено 1');
    expect(text).toContain('резюме не приложилось');
  });

  it('молчит, когда откладывать и предупреждать нечего', () => {
    const text = buildSendResultText({ sent: 2, failed: 0, halted: null, unthrottledSources: [] });
    expect(text).toBe('Отправлено 2, не удалось 0.');
  });
});

describe('panel.html — выбор модели для писем (2026-09-20)', () => {
  it('в списке есть DeepSeek, Sonnet и GLM', () => {
    for (const id of ['deepseek/deepseek-v4-flash', 'anthropic/claude-sonnet-5', 'z-ai/glm-5.3']) {
      expect(html).toContain(id);
    }
  });

  it('поле ключа скрыто по умолчанию и не уходит в автозаполнение браузера', () => {
    expect(html).toMatch(/id="llmKey"[^>]*type="password"|type="password"[^>]*id="llmKey"/);
    expect(html).toMatch(/id="llmKey"[^>]*autocomplete="off"/);
  });

  it('chosenModel: пустой выбор и пустая «другая» — null, иначе id модели', () => {
    // chosenModel читает MODEL_OTHER из области страницы; в new Function её
    // нет, поэтому кладём ту же константу в глобальную область теста.
    (globalThis as unknown as Record<string, string>)['MODEL_OTHER'] = '__other__';
    const chosenModel = extractFunction(html, 'chosenModel');
    expect(chosenModel('', '')).toBeNull();
    expect(chosenModel('z-ai/glm-5.3', '')).toBe('z-ai/glm-5.3');
    expect(chosenModel('__other__', '  ')).toBeNull();
    expect(chosenModel('__other__', ' mistral/x ')).toBe('mistral/x');
  });
});

describe('panel.html — фильтр вакансий во вкладке «Настройки» (2026-11-19)', () => {
  it('experienceBucket: годы → градация hh.ru (0 → 0, 1–2 → 2, 3–5 → 4, 6+ → 6)', () => {
    const experienceBucket = extractFunction(html, 'experienceBucket');
    expect([0, 1, 2, 3, 5, 6, 12].map(experienceBucket)).toEqual([0, 2, 2, 4, 4, 6, 6]);
    // Мусор и отрицательное — «нет опыта», а не NaN в выпадающем списке.
    expect(experienceBucket(undefined)).toBe(0);
    expect(experienceBucket(-3)).toBe(0);
  });

  it('specFilters: без filters — умолчания, ровно прежнее поведение поиска', () => {
    const specFilters = extractFunction(html, 'specFilters');
    const empty = {
      salaryFrom: null, salaryTo: null, includeNoSalary: true,
      employment: [], contract: [], schedule: [], workingHours: null, workFormat: [],
    };
    expect(specFilters({ name: 'старая специальность' })).toEqual(empty);
    expect(specFilters(null)).toEqual(empty);
    expect(specFilters({ filters: { salaryFrom: 100000, includeNoSalary: false, employment: ['FULL', 7], workingHours: '' } }))
      .toEqual({ ...empty, salaryFrom: 100000, includeNoSalary: false, employment: ['FULL'] });
  });

  it('parseSalary / fmtSalary: пробелы-разряды туда и обратно, пусто — null', () => {
    const parseSalary = extractFunction(html, 'parseSalary');
    const fmtSalary = extractFunction(html, 'fmtSalary');
    expect(parseSalary('')).toBeNull();
    expect(parseSalary('  ')).toBeNull();
    expect(parseSalary('150 000')).toBe(150000);
    expect(fmtSalary(1500000)).toBe('1 500 000');
    expect(fmtSalary(null)).toBe('');
    expect(parseSalary(fmtSalary(250000))).toBe(250000);
  });

  it('разметка: все id, на которые завязаны JS, тесты и тур, на месте', () => {
    for (const id of [
      'settingsSave', 'settingsReset', 'settingsNote', 'settingsDirty', 'addSpec', 'specList', 'specPills', 'settingsNav',
      'profileBlock', 'hhLoginBlock', 'careeristLoginBlock', 'careeristLoginBtn', 'llmBlock', 'captchaBlock', 'stopBlock', 'stopWords', 'tgBlock', 'autoBlock',
      'secretaryBlock', 'calendarBlock', 'followupsBlock', 'hhInboxBlock',
    ]) expect(html, id).toContain(`id="${id}"`);
    for (const sec of ['filters', 'accounts', 'telegram', 'auto', 'chat']) expect(html).toContain(`data-sec="${sec}"`);
  });

  it('стили вкладки скоуплены под #pane-settings и не трогают остальные вкладки', () => {
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    const start = css.indexOf('Вкладка «Настройки» (редизайн');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(css.indexOf('*/', start) + 2, css.indexOf('[hidden]', start));
    // Каждый селектор (вне @keyframes) начинается с #pane-settings.
    const selectors = block.replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
      .replace(/@media[^{]+\{/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
      .split('}').map((r) => r.split('{')[0]!.trim()).filter(Boolean);
    expect(selectors.length).toBeGreaterThan(50);
    for (const sel of selectors) {
      for (const part of sel.split(',')) expect(part.trim(), sel).toMatch(/^#pane-settings\b/);
    }
  });
});

describe('panel.html — единый дизайн всей панели (2026-11-20)', () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;

  it('дизайн-токены настроек живут на :root — ими пользуются все вкладки', () => {
    const root = /:root\s*\{([^}]*)\}/.exec(css)![1]!;
    for (const tok of ['--acc:', '--acc-soft:', '--acc-ink:', '--line:', '--mute:', '--card-shadow:']) expect(root, tok).toContain(tok);
    // Старых серо-синих кнопок вне настроек больше нет.
    expect(css).not.toMatch(/#2f5d8a/);
  });

  it('строки вакансии не попадают в шаблоны без esc()', () => {
    // Название, компания, город и ссылка — чужой текст с площадок и из Telegram.
    expect(html).not.toMatch(/\$\{r\.vacancy\.(title|company|geo|url)\}/);
    expect(html).not.toMatch(/\$\{r\.(source|score)\}/);
  });

  it('scoreBadge: цвет по уровню — ≥70 зелёный, 40–69 лавандовый, ниже — серый', () => {
    (globalThis as unknown as Record<string, unknown>)['esc'] = extractFunction(html, 'esc');
    const scoreBadge = extractFunction(html, 'scoreBadge');
    expect(scoreBadge(70)).toContain('score-badge hi');
    expect(scoreBadge(69)).toContain('score-badge mid');
    expect(scoreBadge(40)).toContain('score-badge mid');
    expect(scoreBadge(39)).toContain('score-badge lo');
  });

  it('safeHref: кликается только http(s), кавычки экранируются', () => {
    (globalThis as unknown as Record<string, unknown>)['esc'] = extractFunction(html, 'esc');
    const safeHref = extractFunction(html, 'safeHref');
    expect(safeHref('https://hh.ru/vacancy/1')).toBe('https://hh.ru/vacancy/1');
    expect(safeHref('javascript:alert(1)')).toBe('#');
    expect(safeHref(null)).toBe('#');
    expect(safeHref('https://x.ru/"onmouseover="a')).not.toContain('"');
  });

  it('тур: шаги с целью, которой может не быть, знают, что показать вместо неё', () => {
    expect(html).toContain("const TOUR_KEY = 'jobAutoapply.onboardingDone.v2'");
    // Карточка резюме и карточка вакансии у новичка отсутствуют — у таких шагов есть запасная цель или текст «без цели».
    const steps = html.slice(html.indexOf('const TOUR_STEPS'), html.indexOf('let tourIdx'));
    for (const block of steps.split(/\n  \{\n/).slice(1)) {
      if (/target: `\$\{TOUR_SPEC\}/.test(block)) expect(block, block.slice(0, 80)).toMatch(/textNoTarget:|fallback:/);
      if (/target: '#list \.card'/.test(block)) expect(block).toMatch(/fallback:/);
    }
  });
});

describe('panel.html — buildSendResultText, причины остановки и отказов', () => {
  const buildSendResultText = extractFunction(html, 'buildSendResultText');
  const base = { sent: 17, failed: 3, unthrottledSources: [], skippedEmptyLetter: [], deferredContacts: [], warnings: [] };

  it('предохранитель называется по-человечески, а не too_many_failures', () => {
    const text = buildSendResultText({
      ...base,
      halted: { source: 'hh', reason: 'too_many_failures' },
      haltedSources: [{ source: 'hh', reason: 'too_many_failures' }],
      failures: [],
    });
    expect(text).toMatch(/hh/);
    expect(text).toMatch(/отказов подряд/);
    expect(text).not.toMatch(/too_many_failures/);
  });

  it('причины отказов в итоге: текст, сколько раз встретился, без дублей', () => {
    const reason = 'клик по кнопке отклика не привёл к подтверждению подачи для вакансии 1 — на странице: «Слишком много откликов»';
    const text = buildSendResultText({
      ...base, halted: null, haltedSources: [],
      failures: [
        { title: 'А', reason }, { title: 'Б', reason: reason.replace('вакансии 1', 'вакансии 2') },
        { title: 'В', reason: 'на странице вакансии 3 кнопки отклика нет' },
      ],
    });
    expect(text).toContain('Слишком много откликов');
    expect(text).toContain('кнопки отклика нет');
    // Две одинаковые по сути причины (отличаются номером вакансии) — одна строка с «×2».
    expect(text.match(/Слишком много откликов/g)).toHaveLength(1);
    expect(text).toMatch(/×2/);
  });

  it('без failures (старый отчёт) текст прежний и не падает', () => {
    const text = buildSendResultText({ ...base, halted: null, haltedSources: [] });
    expect(text).toContain('Отправлено 17');
    expect(text).not.toMatch(/Причины/);
  });
});
