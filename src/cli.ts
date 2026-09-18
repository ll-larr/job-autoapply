/**
 * Точка входа. Пять команд: search, panel, send, stop, status — см. main().
 *
 * === Прокси ===
 *
 * Провайдер блокирует прямые запросы к OpenRouter: ответ выглядит как
 * `403 "Access denied by security policy"`, это страница блокировки, а не
 * ошибка API. Поэтому письма идут через VPN-прокси, а всё остальное напрямую:
 * площадкам прокси, наоборот, ломает связь.
 *
 * Прокси не задаётся снаружи, а ищется в момент запроса (src/core/proxy.ts).
 * Раньше его задавал лаунчер через HTTP_PROXY и `--use-env-proxy`, один раз и
 * с зашитым портом. 2026-09-18 VPN-клиент сменил порт, и письма встали.
 * Здесь, при старте команды, только печатается, что нашлось.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue, type Status } from './core/queue.js';
import { loadConfig, type Config, type SearchQueryConfig } from './core/config.js';
import { runSearch, type SearchReport } from './pipeline.js';
import { Sender, requestStop, clearStop, isStopRequested } from './core/sender.js';
import type { SendReport } from './core/sender.js';
import { startPanel } from './ui/server.js';
import { HhAdapter } from './adapters/hh.js';
import { HrGeAdapter } from './adapters/hrge.js';
import { CareeristAdapter } from './adapters/careerist.js';
import { generateLetter, pickTemplate, pickMode } from './core/letter.js';
import { proxyResolver, type ProxyDiscovery, type ProxySource } from './core/proxy.js';
import type { Adapter } from './adapters/types.js';

// 500 — число, которое пользователь выбрал 2026-08-30 сам, разобрав первую
// живую очередь. С 2026-08-30 оно означает ЦЕЛЬ, а не потолок просмотра:
// «набери 500 вакансий в очередь», сколько бы выдачи для этого ни пришлось
// прочитать (см. RunSearchOptions.target). До цели такого размера прогон
// почти наверняка не дойдёт — раньше кончится выдача, — и это нормальный,
// названный в отчёте исход ('exhausted'). Основной вход теперь панель, где
// число вводится руками; --limit остался ради отладочных прогонов с меньшим
// числом.

/**
 * Ключ OpenRouter из файла `.env`, если он есть.
 *
 * Зачем файл, когда есть переменная окружения. Переменная, выставленная через
 * `SetEnvironmentVariable(..., "User")`, попадает только в процессы, запущенные
 * ПОСЛЕ этого. Терминал, открытый раньше, несёт старое окружение и ключа не
 * видит — а выглядит это как «ключ пропал»: прогон проходит, вакансии
 * попадают в очередь, но все письма пустые, и причина не названа нигде.
 * Ровно так и случилось 2026-08-30: семь вакансий с пустыми письмами при
 * живом ключе, лежавшем в User-области.
 *
 * `.env` от состояния оболочки не зависит вообще. Файл в .gitignore, в
 * репозиторий не попадёт.
 *
 * Уже выставленная переменная окружения имеет приоритет: файл только
 * заполняет пробел, а не переопределяет то, что человек задал явно.
 */
function loadDotEnv(): void {
  if (process.env['OPENROUTER_API_KEY']) return;
  try {
    // Путь относительный, как у config.json и templates/: весь CLI
    // рассчитан на запуск из корня проекта (так его зовут npm-скрипты).
    process.loadEnvFile('.env');
  } catch {
    // Файла нет — это нормально, ключ может приходить из окружения.
  }
}

const DEFAULT_LIMIT = 500;
const DB_PATH = 'data/queue.db';
// Единственный постоянный источник резюме — файл в корне репозитория,
// который пользователь положил и поддерживает сам (см. задание к этой
// задаче и scripts/try-letter.ts, откуда взята эта же строка). Не рабочий
// стол, не DOCX, не _generator/.
const RESUME_PATH = 'CV кандидат Бизнес-аналитик.md';
const PANEL_PORT = 4321;

const STATUS_ORDER: readonly Status[] = ['pending', 'approved', 'sent', 'failed', 'skipped'];

// ============================================================================
// Чистые функции — разбор аргументов и форматирование отчётов. Ничего здесь
// не трогает сеть, БД или файловую систему, поэтому легко тестируется без
// живого окружения (см. tests/cli.test.ts).
// ============================================================================

/**
 * Явный аргумент командной строки — это одна формулировка запроса, которая
 * целиком перекрывает список из config.json#searchQueries (удобно для
 * быстрой проверки одной фразы без per-query ограничений вроде juniorOnly —
 * см. задание к этой задаче). Без аргумента — настроенный пользователем
 * список формулировок как есть, constraints каждой формулировки сохраняются.
 */
export function resolveSearchQueries(
  args: readonly string[],
  configured: readonly SearchQueryConfig[],
): SearchQueryConfig[] {
  const q = args.join(' ').trim();
  return q === '' ? [...configured] : [{ query: q }];
}

/** Человекочитаемая метка списка запросов для заголовка отчёта — не про логику поиска. */
export function formatQueryLabel(queries: readonly SearchQueryConfig[]): string {
  return queries.map((q) => q.query).join(' | ');
}

export function groupBySource(rows: ReadonlyArray<{ source: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.source, (counts.get(r.source) ?? 0) + 1);
  return counts;
}

function formatSourceCounts(counts: Map<string, number>): string {
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, n]) => `${source}: ${n}`)
    .join(', ');
}

export function formatSearchReport(
  query: string,
  report: SearchReport,
  emptyLetters: number,
  hasApiKey: boolean,
  letterFailure?: string,
): string[] {
  const lines: string[] = [];
  lines.push(`=== Поиск: "${query}" ===`);
  lines.push(
    `OPENROUTER_API_KEY: ${
      hasApiKey
        ? 'найден'
        : 'НЕ найден — письма будут пустыми, вакансии всё равно попадут в очередь'
    }`,
  );
  lines.push('');
  lines.push(`Просмотрено:             ${report.found}`);
  lines.push(
    `Поставлено в очередь:    ${report.queued}` +
      (report.stoppedBecause === 'exhausted'
        ? ' (выдача кончилась — больше подходящего на площадках нет)'
        : report.stoppedBecause === 'scan_cap'
          ? ' (упёрлись в потолок просмотра — подходящего почти не попадается)'
          : ''),
  );
  lines.push(`Дубли:                   ${report.duplicates}`);
  lines.push(`Отсеяно (ниже minScore): ${report.belowThreshold}`);
  lines.push(`Отсеяно (core-гейт):     ${report.noCoreMatch}`);
  lines.push(`Отсеяно (опыт):          ${report.rejectedExperience}`);
  lines.push(`Отсеяно (грейд):         ${report.rejectedGrade}`);
  lines.push(`Отсеяно (платформа):     ${report.rejectedPlatform}`);
  lines.push(`Отсеяно (не аналитик):   ${report.rejectedNotAnalyst}`);
  lines.push(`Отсеяно (стажировка):    ${report.rejectedInternship}`);
  if (emptyLetters > 0 && letterFailure !== undefined) {
    lines.push(`Почему письма пустые:    ${letterFailure}`);
  }
  lines.push(
    `Письма пустые:           ${emptyLetters}` +
      (report.queued > 0 ? ` из ${report.queued} поставленных в очередь` : '') +
      (emptyLetters > 0 ? ' — допиши вручную в панели' : ''),
  );
  if (report.adapterErrors.length > 0) {
    lines.push(`Ошибки адаптеров:        ${report.adapterErrors.length}`);
    for (const e of report.adapterErrors) lines.push(`  - ${e.adapter}: ${e.message}`);
  } else {
    lines.push('Ошибки адаптеров:        0');
  }
  return lines;
}

export function formatPanelStartup(stuck: number, port: number): string[] {
  return [
    stuck > 0
      ? `${stuck} заявок остались в approved с прошлого прогона (не отправлены, не помечены failed) — следующий send подхватит их сам.`
      : 'Заявок, застрявших в approved с прошлого прогона, нет.',
    `Панель одобрения: http://127.0.0.1:${port}`,
  ];
}

/** Печатается ДО clearStop()/Sender.run() — send не должен молчать о том, что сейчас сделает. */
export function formatSendPreflight(approvedRows: ReadonlyArray<{ source: string }>): string[] {
  if (approvedRows.length === 0) {
    return ['Отправлять нечего: в очереди нет ни одной заявки в статусе approved.'];
  }
  const counts = groupBySource(approvedRows);
  return [
    `Сейчас будет отправлено ${approvedRows.length} заявок: ${formatSourceCounts(counts)}.`,
    'hh — это настоящий отклик через залогиненный браузерный профиль пользователя. Отменить подачу после клика нельзя.',
  ];
}

function explainHalt(halted: NonNullable<SendReport['halted']>): string {
  switch (halted.reason) {
    case 'killed':
      return 'остановлено вручную флагом stop. Неотправленное осталось approved — запусти send снова, когда будешь готов.';
    case 'captcha':
      return `площадка ${halted.source} показала капчу. Обход капчи не реализуется — пройди её руками в браузере, потом запусти send снова.`;
    case 'auth_required':
      return `сессия на площадке ${halted.source} разлогинена. Залогинься заново (npx tsx scripts/login.ts), потом запусти send снова.`;
    case 'too_many_failures':
      return `площадка ${halted.source}: несколько отказов подряд — похоже, что-то сломалось (капча, изменившаяся вёрстка, ограничение аккаунта). Разберись вручную перед повтором.`;
    default: {
      const exhaustive: never = halted.reason;
      return `остановлено (${String(exhaustive)}) на площадке ${halted.source}.`;
    }
  }
}

export function formatSendResult(report: SendReport): { lines: string[]; exitCode: number } {
  const lines: string[] = [`Отправлено: ${report.sent}`, `Отказов:    ${report.failed}`];
  let exitCode = 0;

  if (report.halted !== null) {
    exitCode = 1;
    lines.push(`ОСТАНОВЛЕНО: ${explainHalt(report.halted)}`);
  }

  // Остановка теперь поштучная по площадкам, и первая из них — не вся правда:
  // прогон мог продолжиться, споткнуться ещё об одну и всё равно что-то
  // отправить. Называем каждую, кроме уже названной выше.
  for (const h of report.haltedSources.slice(1)) {
    lines.push(`ОСТАНОВЛЕНО: ${explainHalt(h)}`);
  }

  if (report.skippedEmptyLetter.length > 0) {
    lines.push(
      `ВНИМАНИЕ: пропущено без отправки из-за пустого письма: ${report.skippedEmptyLetter.length}. ` +
        'Заявки остались approved. Дозаполни письма командой `npm run letters` и запусти send снова.',
    );
    for (const title of report.skippedEmptyLetter) lines.push(`   - ${title}`);
  }

  if (report.unthrottledSources.length > 0) {
    lines.push(
      `ВНИМАНИЕ: в config.throttle нет записи для: ${report.unthrottledSources.join(', ')} — ` +
        'эти заявки пропущены целиком и остались approved, ни одна не подана. ' +
        'Добавь запись в config.json и запусти send снова.',
    );
  }

  return { lines, exitCode };
}

export function formatStatusReport(
  counts: Readonly<Record<Status, number>>,
  stopRequested: boolean,
): string[] {
  const lines = STATUS_ORDER.map((s) => `${s}: ${counts[s]}`);
  if (stopRequested) {
    lines.push(
      'ВНИМАНИЕ: поднят флаг остановки (data/STOP). send сам снимает его при запуске; ' +
        'до этого новый send не отправит ничего.',
    );
  }
  return lines;
}

// ============================================================================
// Сборка адаптеров и связка с pipeline — то, что реально исполняет команды.
// Вынесено из main() отдельными функциями ради тестируемости: main() сам не
// тестируется (он читает process.argv и трогает реальную БД/сеть), а эти
// функции — чистая логика поверх переданных зависимостей.
// ============================================================================

export function buildAdapters(): Adapter[] {
  // careerist.ru пока умеет только искать: отклик там требует регистрации, и
  // её adapter.apply честно объявляет `auth_required` (см. adapters/careerist.ts).
  // В очередь вакансии попадают наравне с остальными, а отправка обходит их
  // стороной, не задевая hh.ru — Sender останавливает площадку, а не прогон.
  return [new HhAdapter(), new HrGeAdapter(), new CareeristAdapter()];
}

export function buildAdapterMap(adapters: readonly Adapter[]): Map<string, Adapter> {
  return new Map(adapters.map((a) => [a.name, a] as const));
}


export interface FillLettersDeps {
  queue: Queue;
  config: Config;
  resume: string;
  generateLetterFn: typeof generateLetter;
  pickTemplateFn: typeof pickTemplate;
  readTemplate: (name: string) => string;
  /** Куда сообщать о ходе. Команда пишет в консоль, панель — никуда. */
  log?: (line: string) => void;
}

export interface FillLettersResult {
  /** Сколько строк с пустым письмом нашлось. */
  found: number;
  /** Сколько удалось заполнить. */
  filled: number;
  /** Почему не получилось у остальных. */
  failure?: string;
}

/**
 * Дозаполнение писем у строк, которые уже в очереди, но остались с пустым
 * письмом: генерация могла не удаться из-за отсутствующего ключа, 429 у
 * бесплатной модели или кончившихся денег. Повторный поиск такие строки не
 * чинит — их отсекает дедупликация по (source, source_id) ещё до генерации.
 *
 * Берёт и `pending`, и `approved`: одобрение как раз и выводило строку
 * из-под досягаемости этой операции, хотя именно одобренные и мешают
 * отправке (см. Sender — заявку с пустым письмом он пропускает).
 */
export async function fillEmptyLetters(deps: FillLettersDeps): Promise<FillLettersResult> {
  const log = deps.log ?? (() => {});
  const empty = [...deps.queue.listByStatus('pending'), ...deps.queue.listByStatus('approved')]
    .filter((r) => r.letter.trim() === '');

  if (empty.length === 0) return { found: 0, filled: 0 };

  log(`Пустых писем: ${empty.length}. Генерирую.`);
  let filled = 0;
  let failure: string | undefined;

  for (const row of empty) {
    const mode = pickMode(row.score, deps.config.letterFullThreshold);
    const templateName = deps.pickTemplateFn(row.vacancy, row.matched);
    const result = await deps.generateLetterFn(
      {
        vacancy: row.vacancy,
        matched: row.matched,
        mode,
        resume: deps.resume,
        template: deps.readTemplate(templateName),
      },
      { models: deps.config.letterModels },
    );
    if (result.letter.trim() === '') {
      failure = result.failure ?? failure;
      log(`  #${row.id} не удалось: ${row.vacancy.title.slice(0, 45)}`);
      continue;
    }
    deps.queue.setLetter(row.id, result.letter, result.mode);
    filled++;
    log(`  #${row.id} готово (${result.letter.length} симв.): ${row.vacancy.title.slice(0, 45)}`);
  }

  return { found: empty.length, filled, failure };
}

export interface SearchCommandDeps {
  queue: Queue;
  config: Config;
  adapters: Adapter[];
  /** Формулировки запроса. Разные фразы находят разные вакансии. */
  queries: SearchQueryConfig[];
  /**
   * Сколько вакансий должно ЛЕЧЬ В ОЧЕРЕДЬ за прогон — цель, а не потолок
   * просмотра: прогон сам решает, сколько для этого прочитать (см.
   * RunSearchOptions.target). См. resolveLimit.
   */
  limit: number;
  resume: string;
  generateLetterFn: typeof generateLetter;
  pickTemplateFn: typeof pickTemplate;
  readTemplate: (name: string) => string;
}

/**
 * Связывает runSearch с генерацией писем и считает, сколько писем вернулись
 * пустыми (mode 'none' — модель не ответила ни разу, см. core/letter.ts).
 * Пустое письмо НЕ прерывает поиск: как и raw runSearch, эта функция кладёт
 * вакансию в очередь с letter='' и продолжает — человек допишет письмо в
 * панели. Прерывать поиск из-за одной неотвеченной модели значило бы терять
 * вакансии, которые уже прошли скоринг и core-гейт, ради проблемы с letter.ts,
 * которая никак не отменяет то, что вакансия подходящая.
 */
export async function runSearchCommand(
  deps: SearchCommandDeps,
): Promise<{ report: SearchReport; emptyLetters: number; letterFailure?: string }> {
  let emptyLetters = 0;
  // Причина последнего провала генерации. Без неё пустые письма выглядят как
  // необъяснимое поведение системы: 2026-08-31 прогон вернул двадцать вакансий
  // с пустыми письмами, и чтобы узнать, что просто кончились деньги на
  // OpenRouter, пришлось лезть в код и стучаться в API руками.
  let letterFailure: string | undefined;
  const report = await runSearch({
    queue: deps.queue,
    config: deps.config,
    queries: deps.queries,
    target: deps.limit,
    adapters: deps.adapters,
    generate: async (v, matched, mode) => {
      const templateName = deps.pickTemplateFn(v, matched);
      const result = await deps.generateLetterFn(
        {
          vacancy: v,
          matched,
          mode,
          resume: deps.resume,
          template: deps.readTemplate(templateName),
        },
        { models: deps.config.letterModels },
      );
      if (result.mode === 'none') {
        emptyLetters++;
        letterFailure = result.failure ?? letterFailure;
      }
      return result;
    },
  });
  return { report, emptyLetters, letterFailure };
}

const PROXY_SOURCE_LABEL: Record<ProxySource, string> = {
  env: 'из HTTPS_PROXY/HTTP_PROXY',
  windows: 'из настроек Windows',
  'vpn-process': 'по порту процесса VPN-клиента',
  fallback: 'запасной порт',
};

/**
 * Что сказать в консоли про прокси для писем.
 *
 * Прокси ищется на каждое письмо заново (src/core/proxy.ts), поэтому здесь
 * только отчёт о том, что нашлось при старте, а не условие работы. Совет
 * перезапустить сюда не пишется нарочно: включил VPN — следующее письмо само
 * пойдёт через него.
 */
export function formatProxyReport(d: ProxyDiscovery): string[] {
  if (d.found !== null) {
    return [`Прокси для писем: ${d.found.host}:${d.found.port} (${PROXY_SOURCE_LABEL[d.found.source]}).`];
  }
  return [
    'ВНИМАНИЕ: прокси для писем не найден — похоже, VPN выключен. Пока его нет, письма писаться '
      + 'не будут: запросы к OpenRouter упрутся в блокировку провайдера ("403 Access denied by '
      + 'security policy"). Поиск, одобрение и отправка работают.',
    `Проверены: ${d.checked.join(', ')}. Включи VPN — прокси найдётся сам.`,
  ];
}

async function reportProxy(): Promise<void> {
  const d = await proxyResolver.get();
  const lines = formatProxyReport(d);
  for (const line of lines) (d.found === null ? console.error : console.log)(line);
}

// ============================================================================
// main — читает process.argv, трогает реальную БД/файлы/сеть. Не экспортится
// намеренно: тестировать здесь нечего сверх того, что уже покрыто чистыми
// функциями выше и обычными тестами core/*, adapters/*, pipeline.ts.
// ============================================================================

/**
 * Сколько вакансий обрабатывать за один прогон.
 *
 * Предел обязателен, а не удобство. Без него `search` берёт всё, что прошло
 * гейт (на живой выдаче hh.ru это под три десятка), открывает каждую страницу
 * ради описания и на каждую зовёт модель. Живой замер 2026-08-30: одно письмо
 * на бесплатной модели доходило до 371 секунды. Тридцать таких — это часы, за
 * которые прогон упрётся в лимиты и человек не увидит очередь вовсе.
 *
 * Лучше десять готовых писем сейчас, чем тридцать когда-нибудь.
 */
export function resolveLimit(args: string[]): number {
  const i = args.indexOf('--limit');
  if (i === -1) return DEFAULT_LIMIT;
  const raw = args[i + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--limit ждёт целое положительное число, получено: ${raw ?? '(ничего)'}`);
  }
  return n;
}

async function main(): Promise<void> {
  // Раньше всего: иначе команды прочитают ключ до того, как он появится.
  loadDotEnv();
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'stop') {
    // Kill switch не должен зависеть от того, цел ли config.json — это
    // единственная команда, которой конфиг вообще не нужен.
    requestStop();
    console.log('Флаг остановки поднят. Идущая отправка (если есть) остановится после текущей подачи.');
    return;
  }

  if (cmd === 'status') {
    // Тоже без config.json — диагностическая команда обязана работать, даже
    // если пользователь как раз чинит config.json после предыдущей ошибки.
    const queue = new Queue(DB_PATH);
    try {
      const counts: Record<Status, number> = {
        pending: queue.listByStatus('pending').length,
        approved: queue.listByStatus('approved').length,
        sent: queue.listByStatus('sent').length,
        failed: queue.listByStatus('failed').length,
        skipped: queue.listByStatus('skipped').length,
      };
      for (const line of formatStatusReport(counts, isStopRequested())) console.log(line);
    } finally {
      queue.close();
    }
    return;
  }

  if (cmd === 'panel') {
    // Панель — основной вход, и молчать здесь дороже всего: без прокси она
    // ищет и пишет письма ровно так же, только все письма выходят пустыми, а
    // причина не названа нигде.
    await reportProxy();
    // Конфиг нужен панели ради кнопки «Отправить всё»: отправка идёт через тот
    // же Sender, что и npm run send, с теми же лимитами и предохранителями.
    const config = loadConfig();
    const queue = new Queue(DB_PATH);
    const stuck = queue.countStuckApproved();
    // Собираются РОВНО ОДИН РАЗ и переиспользуются для каждого поиска и для
    // отправки. HhAdapter кеширует BrowserContext на persistent-профиле
    // browser-profile/ (см. src/browser.ts) — второй HhAdapter поверх того
    // же каталога профиля падает на launchPersistentContext, потому что
    // первый ещё держит его открытым. Раньше startSearch собирал buildAdapters()
    // заново на каждый клик «Найти», и второй поиск подряд в одной и той же
    // панели гарантированно падал; теперь один и тот же адаптер просто
    // переиспользует уже открытый браузер (см. HhAdapter.getContext).
    const adapters = buildAdapters();
    try {
      await startPanel(queue, PANEL_PORT, {
        adapters,
        config,
        // Панель показывает это полосой наверху: консоль, в которую она
        // пишет предупреждение, человек не смотрит.
        proxyStatus: () => proxyResolver.get(),
        // Та же проводка, что у команды search: панель не собирает конвейер
        // заново, а зовёт ровно то, что вызывает npm run search.
        fillLetters: () => fillEmptyLetters({
          queue,
          config,
          resume: readFileSync(RESUME_PATH, 'utf8'),
          generateLetterFn: generateLetter,
          pickTemplateFn: pickTemplate,
          readTemplate: (name) => readFileSync(`templates/${name}.md`, 'utf8'),
        }),
        startSearch: (limit) => runSearchCommand({
          queue,
          config,
          adapters,
          queries: config.searchQueries,
          limit,
          resume: readFileSync(RESUME_PATH, 'utf8'),
          generateLetterFn: generateLetter,
          pickTemplateFn: pickTemplate,
          readTemplate: (name) => readFileSync(`templates/${name}.md`, 'utf8'),
        }),
      });
    } catch (e) {
      // Занятый порт и подобное — обычная бытовая ситуация, а не сбой,
      // заслуживающий трассировки. Причина уже названа в тексте ошибки.
      queue.close();
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
      return;
    }
    for (const line of formatPanelStartup(stuck, PANEL_PORT)) console.log(line);
    // Намеренно НЕ queue.close(): панель держит процесс живым, пока слушает
    // http; закрыть БД здесь значило бы, что первый же запрос к /api/pending
    // обратится к уже закрытому sqlite-соединению.
    return;
  }

  if (cmd === 'letters') {
    await reportProxy();
    const config = loadConfig();
    const queue = new Queue(DB_PATH);
    try {
      if (!process.env['OPENROUTER_API_KEY']) {
        console.error('OPENROUTER_API_KEY не найден — генерировать нечем.');
        console.error('Положи ключ в файл .env рядом с package.json:');
        console.error('  OPENROUTER_API_KEY=sk-or-v1-...');
        process.exitCode = 1;
        return;
      }

      const res = await fillEmptyLetters({
        queue,
        config,
        resume: readFileSync(RESUME_PATH, 'utf8'),
        generateLetterFn: generateLetter,
        pickTemplateFn: pickTemplate,
        readTemplate: (name) => readFileSync(`templates/${name}.md`, 'utf8'),
        log: (line) => console.log(line),
      });

      if (res.found === 0) {
        console.log('Пустых писем нет — дозаполнять нечего.');
        return;
      }
      console.log(`\nЗаполнено ${res.filled} из ${res.found}.`);
      if (res.filled < res.found) {
        if (res.failure !== undefined) console.log(`Причина: ${res.failure}`);
        console.log('Оставшиеся можно повторить этой же командой.');
      }
    } finally {
      queue.close();
    }
    return;
  }

  if (cmd === 'search') {
    await reportProxy();
    const config = loadConfig();
    const queue = new Queue(DB_PATH);
    try {
      const limit = resolveLimit(rest);
      const queries = resolveSearchQueries(
        rest.filter((a, i) => a !== '--limit' && rest[i - 1] !== '--limit'),
        config.searchQueries,
      );
      const resume = readFileSync(RESUME_PATH, 'utf8');
      const hasApiKey = Boolean(process.env['OPENROUTER_API_KEY']);

      const { report, emptyLetters, letterFailure } = await runSearchCommand({
        queue,
        config,
        adapters: buildAdapters(),
        queries,
        limit,
        resume,
        generateLetterFn: generateLetter,
        pickTemplateFn: pickTemplate,
        readTemplate: (name) => readFileSync(`templates/${name}.md`, 'utf8'),
      });

      for (const line of formatSearchReport(formatQueryLabel(queries), report, emptyLetters, hasApiKey, letterFailure)) {
        console.log(line);
      }
    } finally {
      queue.close();
    }
    return;
  }

  if (cmd === 'send') {
    const config = loadConfig();
    const queue = new Queue(DB_PATH);
    try {
      // "До того, как что-либо сделать" — значит до clearStop() и до
      // Sender.run(), а не просто до подачи первой заявки.
      const approvedRows = queue.listByStatus('approved');
      for (const line of formatSendPreflight(approvedRows)) console.log(line);

      clearStop(); // прошлый kill switch не должен блокировать новый прогон
      const adapterMap = buildAdapterMap(buildAdapters());
      const report = await new Sender(queue, adapterMap, config).run();

      const { lines, exitCode } = formatSendResult(report);
      for (const line of lines) console.log(line);
      process.exitCode = exitCode;
    } finally {
      queue.close();
    }
    return;
  }

  console.error('Команды: search [запрос] | panel | send | stop | status');
  process.exitCode = 1;
}

/** true только когда файл запущен напрямую (а не импортирован тестами). */
function isDirectRun(): boolean {
  if (process.argv[1] === undefined) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isDirectRun()) {
  try {
    await main();
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
}
