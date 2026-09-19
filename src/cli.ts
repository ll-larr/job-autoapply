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

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Queue, type Status } from './core/queue.js';
import { loadConfig, type Config } from './core/config.js';
import { runSearch, type SearchReport, type SearchQuery } from './pipeline.js';
import {
  loadSettings, seedSettings, saveSettings, validateSettings, enabledSpecialties, SETTINGS_PATH, type Settings,
} from './core/settings.js';
import type { Specialty } from './core/specialty.js';
import { DEFAULT_SPECIALTY } from './core/specialty-defaults.js';
import { Sender, requestStop, clearStop, isStopRequested } from './core/sender.js';
import type { SendReport } from './core/sender.js';
import { startPanel } from './ui/server.js';
import { HhAdapter } from './adapters/hh.js';
import { HrGeAdapter } from './adapters/hrge.js';
import { CareeristAdapter } from './adapters/careerist.js';
import { generateLetter, pickTemplate, pickMode } from './core/letter.js';
import { generateDm } from './core/dm.js';
import { proxyResolver, type ProxyDiscovery, type ProxySource } from './core/proxy.js';
import type { Adapter } from './adapters/types.js';
import { extractPdfText, refreshResumeCache, resumeTextFor, LEGACY_RESUME_MD } from './core/resume.js';
import { suggestSpecialty } from './core/suggest.js';
import { TelegramAdapter } from './adapters/telegram.js';
import { openTelegram, type OpenResult } from './telegram/gramjs.js';
import { classifyTgError, describeTgFailure } from './telegram/errors.js';
import type { TgReader, TgSender } from './telegram/types.js';

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
  try {
    // Путь относительный, как у config.json и templates/: весь CLI
    // рассчитан на запуск из корня проекта (так его зовут npm-скрипты).
    //
    // Файл читается всегда, а не только когда нет OPENROUTER_API_KEY: в нём
    // же лежат TG_API_ID/TG_API_HASH (Telegram). loadEnvFile не перезаписывает
    // уже заданные переменные (проверено на Node 24), так что явно
    // выставленное человеком по-прежнему главнее файла.
    process.loadEnvFile('.env');
  } catch {
    // Файла нет — это нормально, ключи могут приходить из окружения.
  }
}

const DEFAULT_LIMIT = 500;
const DB_PATH = 'data/queue.db';
const PANEL_PORT = 4321;

/**
 * Обновляет кеш текста резюме у включённых специальностей перед поиском (см.
 * core/resume.ts). Не извлёкся — письма этой специальности пойдут по резюме
 * БА, и об этом надо сказать, а не молчать.
 */
async function refreshResumes(settings: Settings, log: (line: string) => void): Promise<void> {
  for (const s of enabledSpecialties(settings)) {
    const r = await refreshResumeCache(s);
    if (!r.ok) log(`Резюме «${s.name}» не извлеклось (${r.error}) — письма пойдут по резюме БА.`);
  }
}

/**
 * PDF резюме БА для засева настроек (спека 2026-09-18, 3.7). Путь владельца;
 * если файла нет — null, и в панели поле останется пустым.
 */
function defaultBaResumePdf(): string | null {
  const p = join(homedir(), 'OneDrive', 'Рабочий стол', 'Резюме', 'CV_кандидат_Бизнес-аналитик.pdf');
  return existsSync(p) ? p : null;
}

/**
 * Настройки поиска на момент вызова (снимок на старте прогона, спека 3.1).
 * Первый вызов засевает data/settings.json из config.json.
 */
function currentSettings(config: Config): Settings {
  return loadSettings(SETTINGS_PATH, () => seedSettings(config.searchQueries, defaultBaResumePdf()));
}

/**
 * Специальность строки очереди. Удалённая из настроек — бизнес-аналитик:
 * письмо всё равно нужно дописать, а других сведений о ней не осталось.
 */
export function specialtyOf(settings: Settings, id: string): Specialty {
  return settings.specialties.find((s) => s.id === id) ?? DEFAULT_SPECIALTY;
}

const STATUS_ORDER: readonly Status[] = ['pending', 'approved', 'sent', 'failed', 'skipped'];

// ============================================================================
// Чистые функции — разбор аргументов и форматирование отчётов. Ничего здесь
// не трогает сеть, БД или файловую систему, поэтому легко тестируется без
// живого окружения (см. tests/cli.test.ts).
// ============================================================================

/**
 * Фразы поиска из настроек (спека 2026-09-18, раздел 3.2). Без аргументов —
 * фразы всех включённых специальностей, каждая со своей специальностью. С
 * аргументами — одна фраза для быстрой проверки; от чьего имени она ищет,
 * задаёт `--specialty "<название>"`, иначе первая включённая.
 */
export function buildSearchQueries(settings: Settings, args: readonly string[]): SearchQuery[] {
  const enabled = enabledSpecialties(settings);
  if (enabled.length === 0) {
    throw new Error('Нет включённых специальностей — включи хотя бы одну во вкладке «Настройки».');
  }

  const i = args.indexOf('--specialty');
  const wanted = i === -1 ? undefined : args[i + 1];
  const words = args.filter((_, j) => i === -1 || (j !== i && j !== i + 1));
  const text = words.join(' ').trim();

  let specialty: Specialty = enabled[0]!;
  if (wanted !== undefined) {
    const found = settings.specialties.find((s) => s.name.toLowerCase() === wanted.trim().toLowerCase());
    if (found === undefined) {
      throw new Error(`Специальность «${wanted}» не найдена. Есть: ${settings.specialties.map((s) => s.name).join(', ')}`);
    }
    specialty = found;
  }

  if (text === '') {
    const from = wanted === undefined ? enabled : [specialty];
    return from.flatMap((s) => s.queries.map((query) => ({ query, specialty: s })));
  }
  return [{ query: text, specialty }];
}

/** Человекочитаемая метка списка запросов для заголовка отчёта — не про логику поиска. */
export function formatQueryLabel(queries: readonly SearchQuery[]): string {
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
  const hits = Object.entries(report.stopwordHits).map(([w, n]) => `${w}: ${n}`).join(', ');
  lines.push(`Отсеяно (стоп-слова):   ${report.rejectedStopword}${hits === '' ? '' : ` (${hits})`}`);
  lines.push(`Отсеяно (заголовок):    ${report.rejectedTitle}`);
  lines.push(`Отсеяно (стажировка):    ${report.rejectedInternship}`);
  if (report.tgNotVacancy + report.tgNoContact + report.textDuplicates > 0) {
    lines.push(
      `Telegram: не вакансия ${report.tgNotVacancy}, без контакта ${report.tgNoContact}, репостов ${report.textDuplicates}`,
    );
  }
  for (const c of report.tgSkippedChats) lines.push(`  Telegram, «${c.title}» пропущен: ${c.why}`);
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
      return halted.source === 'tg'
        ? 'Telegram не подключён или сессия протухла. Войди заново (npm run tg:login), потом запусти send снова.'
        : `сессия на площадке ${halted.source} разлогинена. Залогинься заново (npx tsx scripts/login.ts), потом запусти send снова.`;
    case 'account_limited':
      return `площадка ${halted.source}: аккаунт ограничен (Telegram: PEER_FLOOD или долгий FloodWait) — первые сообщения незнакомым сейчас не проходят. Подожди сутки; заявки остались approved.`;
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

  for (const d of report.deferredContacts) {
    const until = new Date(d.until).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    lines.push(`Отложено до ${until}: @${d.contact} — ${d.title} (этому контакту писали меньше 7 дней назад)`);
  }
  for (const w of report.warnings) lines.push(`ВНИМАНИЕ: ${w}`);

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

/** Telegram для команд: чтение и отправка через одну сессию на процесс. */
export interface TelegramSession {
  reader(): Promise<TgReader | { error: string }>;
  sender(): Promise<TgSender | { error: string }>;
  close(): Promise<void>;
}

/**
 * Сессия Telegram поднимается только по первому обращению: поиск без чатов
 * в настройках и отправка без Telegram-строк её не трогают вовсе. Неудача
 * (VPN выключен, сессия протухла) не запоминается — следующее обращение
 * пробует снова: VPN включают, не перезапуская панель.
 */
export function lazyTelegram(open: () => Promise<OpenResult> = () => openTelegram()): TelegramSession {
  let pending: Promise<OpenResult> | null = null;
  const get = (): Promise<OpenResult> => {
    pending ??= open().then((r) => {
      if (!r.ok) pending = null;
      return r;
    });
    return pending;
  };
  return {
    async reader() { const r = await get(); return r.ok ? r.reader : { error: r.message }; },
    async sender() { const r = await get(); return r.ok ? r.sender : { error: r.message }; },
    async close() {
      const p = pending;
      pending = null;
      if (p === null) return;
      const r = await p;
      if (r.ok) await r.close();
    },
  };
}

/** Что нужно адаптеру Telegram от команды: очередь (курсоры чатов), настройки, сессия. */
export interface TelegramWiring {
  queue: Queue;
  settings: () => Settings;
  session: TelegramSession;
}

export function buildAdapters(tg?: TelegramWiring): Adapter[] {
  // careerist.ru пока умеет только искать: отклик там требует регистрации, и
  // её adapter.apply честно объявляет `auth_required` (см. adapters/careerist.ts).
  // В очередь вакансии попадают наравне с остальными, а отправка обходит их
  // стороной, не задевая hh.ru — Sender останавливает площадку, а не прогон.
  const adapters: Adapter[] = [new HhAdapter(), new HrGeAdapter(), new CareeristAdapter()];
  if (tg !== undefined) {
    // Настройки читаются на каждое обращение: выбор чатов в панели действует
    // со следующего поиска без перезапуска.
    adapters.push(new TelegramAdapter({
      reader: () => tg.session.reader(),
      sender: () => tg.session.sender(),
      close: () => tg.session.close(),
      queue: tg.queue,
      chats: () => tg.settings().telegram.chats,
      firstReadDays: () => tg.settings().telegram.firstReadDays,
      titleWords: () => enabledSpecialties(tg.settings()).flatMap((s) => s.titleWords),
      resumePdf: (id) => specialtyOf(tg.settings(), id).resumePdf,
    }));
  }
  return adapters;
}

export function buildAdapterMap(adapters: readonly Adapter[]): Map<string, Adapter> {
  return new Map(adapters.map((a) => [a.name, a] as const));
}


export interface FillLettersDeps {
  queue: Queue;
  config: Config;
  /** Текст резюме, по которому пишет письма специальность (core/resume.ts). */
  resumeFor: (specialty: Specialty) => string;
  /**
   * Специальность строки очереди по её id. Удалённая из настроек — как БА:
   * письмо всё равно нужно дописать, а других сведений о ней не осталось.
   */
  specialtyById: (id: string) => Specialty;
  generateLetterFn: typeof generateLetter;
  /** Личное сообщение рекрутёру для постов Telegram (core/dm.ts). */
  generateDmFn: typeof generateDm;
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
    // Та же развилка, что при поиске (pipeline.ts): скелеты и hybrid/full —
    // только у засеянных специальностей, остальные пишут письмо целиком.
    const specialty = deps.specialtyById(row.specialty);
    const result = row.source === 'tg'
      // Пост Telegram: не письмо, а личное сообщение рекрутёру (core/dm.ts).
      ? await deps.generateDmFn(
        { vacancy: row.vacancy, resume: deps.resumeFor(specialty), role: specialty.name },
        { models: deps.config.letterModels },
      )
      : await deps.generateLetterFn(
        {
          vacancy: row.vacancy,
          matched: row.matched,
          mode: specialty.legacyLetters ? pickMode(row.score, deps.config.letterFullThreshold) : 'full',
          template: specialty.legacyLetters
            ? deps.readTemplate(deps.pickTemplateFn(row.vacancy, row.matched))
            : '',
          resume: deps.resumeFor(specialty),
          role: specialty.legacyLetters ? undefined : specialty.name,
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
  /** Формулировки запроса, каждая со своей специальностью (см. buildSearchQueries). */
  queries: SearchQuery[];
  /** Стоп-слова из настроек. undefined — прежние 1С и Битрикс. */
  stopWords?: readonly string[];
  /** Включённые специальности — ими оцениваются посты Telegram (pipeline.ts). */
  specialties?: Specialty[];
  /**
   * Сколько вакансий должно ЛЕЧЬ В ОЧЕРЕДЬ за прогон — цель, а не потолок
   * просмотра: прогон сам решает, сколько для этого прочитать (см.
   * RunSearchOptions.target). См. resolveLimit.
   */
  limit: number;
  /** Текст резюме, по которому пишет письма специальность (core/resume.ts). */
  resumeFor: (specialty: Specialty) => string;
  generateLetterFn: typeof generateLetter;
  /** Личное сообщение рекрутёру для постов Telegram (core/dm.ts). */
  generateDmFn: typeof generateDm;
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
    stopWords: deps.stopWords,
    specialties: deps.specialties,
    target: deps.limit,
    adapters: deps.adapters,
    generate: async (v, matched, mode, specialty) => {
      // Пост Telegram: не письмо, а короткое личное сообщение рекрутёру со
      // ссылкой на пост (core/dm.ts, спека 5.1).
      // Остальное — письмо. Скелеты — только у засеянных специальностей
      // (legacyLetters); остальным конвейер уже выставил mode 'full', и скелет
      // модели не показывается.
      const result = v.source === 'tg'
        ? await deps.generateDmFn(
          { vacancy: v, resume: deps.resumeFor(specialty), role: specialty.name },
          { models: deps.config.letterModels },
        )
        : await deps.generateLetterFn(
          {
            vacancy: v,
            matched,
            mode,
            template: specialty.legacyLetters ? deps.readTemplate(deps.pickTemplateFn(v, matched)) : '',
            resume: deps.resumeFor(specialty),
            role: specialty.legacyLetters ? undefined : specialty.name,
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
    // Telegram — одна сессия на всю жизнь панели, поднимается по первому
    // обращению (поиск с чатами, выбор чатов, отправка Telegram-строк).
    const tg = lazyTelegram();
    const adapters = buildAdapters({ queue, settings: () => currentSettings(config), session: tg });
    try {
      await startPanel(queue, PANEL_PORT, {
        adapters,
        config,
        telegram: {
          dialogs: async () => {
            const reader = await tg.reader();
            if ('error' in reader) return { ok: false, error: reader.error };
            try {
              return { ok: true, chats: await reader.dialogs() };
            } catch (e) {
              return { ok: false, error: describeTgFailure(classifyTgError(e)) };
            }
          },
          resolve: async (ref) => {
            const reader = await tg.reader();
            if ('error' in reader) return { ok: false, error: reader.error };
            try {
              return { ok: true, chat: await reader.resolveChat(ref) };
            } catch (e) {
              return { ok: false, error: describeTgFailure(classifyTgError(e)) };
            }
          },
        },
        // Панель показывает это полосой наверху: консоль, в которую она
        // пишет предупреждение, человек не смотрит.
        proxyStatus: () => proxyResolver.get(),
        settings: {
          get: () => currentSettings(config),
          save: async (raw) => {
            const checked = validateSettings(raw);
            if (!checked.ok) return checked;
            // PDF проверяется до записи: сохранённая специальность с битым
            // резюме молча писала бы письма по резюме БА (спека 3.8).
            for (const s of checked.settings.specialties) {
              const r = await refreshResumeCache(s);
              if (!r.ok) return { ok: false, error: `«${s.name}»: резюме не читается — ${r.error}` };
            }
            try {
              return { ok: true, settings: saveSettings(SETTINGS_PATH, checked.settings) };
            } catch (e) {
              return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
          },
          suggest: async (name, resumePdf) => {
            let resume: string;
            try {
              resume = resumePdf === null ? readFileSync(LEGACY_RESUME_MD, 'utf8') : await extractPdfText(resumePdf);
            } catch (e) {
              return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
            return suggestSpecialty(name, resume, { models: config.letterModels });
          },
        },
        // Та же проводка, что у команды search: панель не собирает конвейер
        // заново, а зовёт ровно то, что вызывает npm run search.
        fillLetters: () => fillEmptyLetters({
          queue,
          config,
          resumeFor: (s) => resumeTextFor(s),
          specialtyById: (id) => specialtyOf(currentSettings(config), id),
          generateLetterFn: generateLetter,
          generateDmFn: generateDm,
          pickTemplateFn: pickTemplate,
          readTemplate: (name) => readFileSync(`templates/${name}.md`, 'utf8'),
        }),
        // Настройки читаются на каждый запуск: правка во вкладке «Настройки»
        // действует со следующего поиска без перезапуска панели.
        startSearch: async (limit) => {
          const settings = currentSettings(config);
          await refreshResumes(settings, (line) => console.error(line));
          return runSearchCommand({
            queue,
            config,
            adapters,
            queries: buildSearchQueries(settings, []),
            stopWords: settings.stopWords,
            specialties: enabledSpecialties(settings),
            limit,
            resumeFor: (s) => resumeTextFor(s),
            generateLetterFn: generateLetter,
            generateDmFn: generateDm,
            pickTemplateFn: pickTemplate,
            readTemplate: (name) => readFileSync(`templates/${name}.md`, 'utf8'),
          });
        },
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
        resumeFor: (s) => resumeTextFor(s),
        specialtyById: (id) => specialtyOf(currentSettings(config), id),
        generateLetterFn: generateLetter,
        generateDmFn: generateDm,
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
    const tg = lazyTelegram();
    try {
      const limit = resolveLimit(rest);
      const settings = currentSettings(config);
      const queries = buildSearchQueries(
        settings,
        rest.filter((a, i) => a !== '--limit' && rest[i - 1] !== '--limit'),
      );
      await refreshResumes(settings, (line) => console.error(line));
      const hasApiKey = Boolean(process.env['OPENROUTER_API_KEY']);

      const { report, emptyLetters, letterFailure } = await runSearchCommand({
        queue,
        config,
        adapters: buildAdapters({ queue, settings: () => settings, session: tg }),
        queries,
        stopWords: settings.stopWords,
        specialties: enabledSpecialties(settings),
        limit,
        resumeFor: (s) => resumeTextFor(s),
        generateLetterFn: generateLetter,
        generateDmFn: generateDm,
        pickTemplateFn: pickTemplate,
        readTemplate: (name) => readFileSync(`templates/${name}.md`, 'utf8'),
      });

      for (const line of formatSearchReport(formatQueryLabel(queries), report, emptyLetters, hasApiKey, letterFailure)) {
        console.log(line);
      }
    } finally {
      // Без закрытия GramJS держит процесс живым своими соединениями.
      await tg.close();
      queue.close();
    }
    return;
  }

  if (cmd === 'send') {
    const config = loadConfig();
    const queue = new Queue(DB_PATH);
    const tg = lazyTelegram();
    try {
      // "До того, как что-либо сделать" — значит до clearStop() и до
      // Sender.run(), а не просто до подачи первой заявки.
      const approvedRows = queue.listByStatus('approved');
      for (const line of formatSendPreflight(approvedRows)) console.log(line);

      clearStop(); // прошлый kill switch не должен блокировать новый прогон
      const adapterMap = buildAdapterMap(buildAdapters({ queue, settings: () => currentSettings(config), session: tg }));
      const report = await new Sender(queue, adapterMap, config).run();

      const { lines, exitCode } = formatSendResult(report);
      for (const line of lines) console.log(line);
      process.exitCode = exitCode;
    } finally {
      await tg.close();
      queue.close();
    }
    return;
  }

  console.error('Команды: search [запрос] [--specialty "название"] | panel | send | stop | status');
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
