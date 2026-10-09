import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Queue, QueueRow } from '../core/queue.js';
import type { TgChat } from '../telegram/types.js';
import type { ProxyDiscovery } from '../core/proxy.js';
import type { Config } from '../core/config.js';
import type { Adapter } from '../adapters/types.js';
import type { Settings } from '../core/settings.js';
import type { SpecialtySuggestion } from '../core/suggest.js';
import type { Vacancy } from '../core/vacancy.js';
import { Sender, clearStop, requestStop, type SendReport } from '../core/sender.js';
import type { DialogView, FunnelRow } from '../core/dialogs.js';
import type { FollowupView, FollowupRunReport } from '../core/followups.js';
import type { HhInboxReport, HhPanelStatus } from '../hh/inbox.js';

/** Сколько времени отменённая вакансия остаётся во вкладке «Отменённые». */
const SKIPPED_WINDOW_MS = 24 * 60 * 60 * 1000;

const PANEL_HTML = resolve('src/ui/panel.html');

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * Состояние отправки для панели.
 *
 * Отправка идёт минутами: у каждой площадки свой троттлинг со случайными
 * паузами, и семь заявок легко растягиваются на четверть часа. Держать на
 * это время открытым HTTP-запрос нельзя — браузер оборвёт его по таймауту,
 * и человек решит, что всё сломалось, хотя отправка продолжается. Поэтому
 * запуск отвечает сразу, а панель опрашивает состояние.
 */
interface SendState {
  running: boolean;
  startedAt: number | null;
  report: SendReport | null;
  error: string | null;
  /**
   * Кто запустил: человек кнопкой или автоотклик после поиска (спека 7.2).
   * Выключение тумблера останавливает только автоматическую отправку (7.3).
   */
  origin: 'human' | 'auto' | null;
  /** Человек нажал «Остановить отправку»: текущая подача доезжает, дальше — стоп. */
  stopping: boolean;
}

/**
 * Состояние поиска для панели. Та же схема, что у отправки, и по той же
 * причине: поиск открывает браузер, листает выдачу, дочитывает описания и
 * зовёт модель на каждое письмо — это минуты. Держать всё это время открытым
 * HTTP-запрос нельзя, браузер оборвёт его по таймауту.
 */
interface SearchState {
  running: boolean;
  startedAt: number | null;
  result: { report: unknown; emptyLetters: number; autoApproved?: number } | null;
  error: string | null;
  /** Человек нажал «Остановить поиск»: идёт дочитывание текущего шага. */
  stopping: boolean;
}

/** Состояние дозаполнения писем. Та же схема, что у поиска и отправки, и по той же причине: это минуты. */
interface LettersState {
  running: boolean;
  startedAt: number | null;
  result: { found: number; filled: number; failure?: string; stopped?: true } | null;
  error: string | null;
  /** Человек нажал «Остановить написание писем»: дописывается текущее письмо. */
  stopping: boolean;
}

/** Состояние работы с дожимами: подготовка текстов или отправка. Та же схема, что у поиска и отправки. */
interface FollowupState {
  running: boolean;
  kind: 'prepare' | 'send' | null;
  result: unknown;
  error: string | null;
  stopping: boolean;
}

/** Состояние проверки ящика откликов hh.ru: та же схема, что у поиска, — запуск отвечает сразу, панель опрашивает. */
interface HhState {
  running: boolean;
  startedAt: number | null;
  /** Кто запустил: человек кнопкой или плановый таймер. */
  origin: 'human' | 'timer' | null;
  error: string | null;
  stopping: boolean;
}

export interface PanelDeps {
  /** Нужны только для отправки. Без них кнопка «Отправить всё» недоступна. */
  adapters?: Adapter[];
  config?: Config;
  /**
   * Хук Sender после успешного отклика — тот же, что у `npm run send` и
   * автоотклика в `search` (cli.ts, gigarecruiterOnSent): отклик на Сбер из
   * панели тоже открывает окно автоответа ГигаРекрутёру (I2). Не задан —
   * отправка идёт без хука.
   */
  onSent?: (v: Vacancy) => void;
  /**
   * Запуск поиска. Передаётся готовой функцией, а не собирается здесь из
   * кусков: панель — это http-слой, ей незачем знать про резюме, скелеты
   * писем и выбор модели. Вся эта проводка уже есть в cli.ts, и дублировать
   * её означало бы получить две расходящиеся версии одного и того же.
   *
   * Без неё кнопка поиска в панели недоступна.
   *
   * signal — кнопка «Остановить поиск»: поиск обязан его слушать и вернуть то,
   * что успел (report.stoppedBecause = 'stopped').
   */
  startSearch?: (limit: number, signal: AbortSignal)
    => Promise<{ report: unknown; emptyLetters: number; autoApproved?: number }>;
  /**
   * Дозаполнение пустых писем. Без неё кнопка «Дописать письма» недоступна.
   *
   * Нужна именно в панели, а не только командой: письмо может не
   * сгенерироваться (429, кончились деньги на OpenRouter), и человек видит
   * это в панели — там же должна быть и кнопка, а не отсылка в терминал.
   */
  fillLetters?: (signal: AbortSignal) => Promise<{ found: number; filled: number; failure?: string; stopped?: true }>;
  /**
   * Где сейчас прокси для писем. Если его нет, поиск и генерация писем внешне
   * работают, но все письма выходят пустыми — 2026-09-01 это стоило прогона
   * на 22 вакансии. Панель обязана сказать об этом сама, а не надеяться на
   * консоль.
   *
   * Зовётся на каждый опрос /api/proxy/status: VPN включают и выключают, не
   * перезапуская панель. Без этой зависимости (панель поднята не из cli, так
   * её поднимают тесты) ручка отвечает «не знаю», и полосы нет.
   */
  proxyStatus?: () => Promise<ProxyDiscovery>;
  /**
   * Вкладка «Настройки» (спека 2026-09-18, 3.8): чтение, сохранение с
   * проверкой и «Предложить». Собирается в cli.ts: там знают путь файла,
   * резюме и модели — панели как http-слою это знать незачем. Без неё вкладка
   * отвечает «недоступно».
   */
  settings?: {
    get(): Settings;
    save(raw: unknown): Promise<{ ok: true; settings: Settings } | { ok: false; error: string }>;
    suggest(name: string, resumePdf: string | null)
      : Promise<{ ok: true; suggestion: SpecialtySuggestion } | { ok: false; error: string }>;
  };
  /**
   * Выбор чатов Telegram во вкладке «Настройки» (спека 4.4): «Выбрать из моих
   * чатов» и «Добавить по @имени». Только чтение — отправлять отсюда нечего.
   */
  telegram?: {
    dialogs(): Promise<{ ok: true; chats: TgChat[] } | { ok: false; error: string }>;
    resolve(ref: string): Promise<{ ok: true; chat: TgChat } | { ok: false; error: string }>;
  };
  /**
   * Вкладка «Диалоги» (спека 2026-10-09, 8.4): диалоги секретаря и воронка.
   * Только метаданные. Без зависимости ручка отвечает 409.
   */
  dialogs?: {
    snapshot(now: number): { dialogs: DialogView[]; funnel: FunnelRow[]; active: number };
  };
  /**
   * Дожимы (спека 2026-10-09, 6.9): список, подготовка текстов, отправка. Без
   * зависимости ручки отвечают 409. Отправка необратима и выключена тумблером
   * в настройках по умолчанию — это проверяет сама `send`, а панель лишь
   * передаёт её отказ человеку.
   */
  followups?: {
    enabled(): boolean;
    /** Сколько контактов ждут дожима, но текста у них ещё нет. */
    waiting(): number;
    list(): FollowupView[];
    prepare(): Promise<{ created: number; fromModel: number; fromTemplate: number }>;
    send(ids: number[] | 'all', stopRequested: () => boolean): Promise<FollowupRunReport>;
    setText(id: number, text: string): 'ok' | 'not_draft';
    cancel(id: number): boolean;
  };
  /**
   * Ящик откликов hh.ru (спека 2026-10-09, 6.10): проверка новых ответов и
   * приглашений. Без зависимости ручки отвечают 409. Плановую проверку
   * запускает таймер панели (раз в минуту смотрит `due`), ручную — кнопка.
   */
  hh?: {
    status(): HhPanelStatus;
    /** Пора ли запускать плановую проверку: тумблер включён и прошёл интервал. */
    due(now: number): boolean;
    check(stopRequested: () => boolean): Promise<HhInboxReport>;
  };
}

/**
 * Предупреждение карточки (спека 5.5): этому рекрутёру уже писали или он уже
 * в очереди по другой вакансии. Сама строка — тоже «строка с контактом», её
 * не считаем.
 */
function contactWarning(queue: Queue, row: QueueRow, now: number = Date.now()): string | null {
  if (row.contact === null) return null;
  const sent = queue.lastSentTo(row.contact);
  if (sent !== null) {
    const days = Math.floor((now - sent.at) / 86_400_000);
    const when = days === 0 ? 'сегодня' : `${days} дн. назад`;
    return `ты писал @${row.contact} ${when} по вакансии «${sent.title}»`;
  }
  const other = queue.listByStatus('pending').concat(queue.listByStatus('approved'))
    .find((r) => r.id !== row.id && r.contact === row.contact);
  return other === undefined ? null : `@${row.contact} уже в очереди по вакансии «${other.vacancy.title}»`;
}

function withContactWarnings(queue: Queue, rows: QueueRow[]): Array<QueueRow & { contactWarning: string | null }> {
  return rows.map((row) => ({ ...row, contactWarning: contactWarning(queue, row) }));
}

export async function startPanel(
  queue: Queue, port: number, deps: PanelDeps = {},
): Promise<{ port: number; close(): Promise<void> }> {
  const send: SendState = { running: false, startedAt: null, report: null, error: null, origin: null, stopping: false };
  const canSend = deps.adapters !== undefined && deps.config !== undefined;
  const search: SearchState = { running: false, startedAt: null, result: null, error: null, stopping: false };
  // Кнопка «Остановить поиск» / «Остановить написание писем» подаёт сигнал
  // тому, что сейчас работает. Отправка останавливается флагом data/STOP —
  // тем же, что `npm run stop`, — потому что её надо уметь остановить и снаружи.
  let searchAbort: AbortController | null = null;
  let lettersAbort: AbortController | null = null;
  const canSearch = deps.startSearch !== undefined;
  const letters: LettersState = { running: false, startedAt: null, result: null, error: null, stopping: false };
  const canFillLetters = deps.fillLetters !== undefined;
  const followups: FollowupState = { running: false, kind: null, result: null, error: null, stopping: false };
  const hh: HhState = { running: false, startedAt: null, origin: null, error: null, stopping: false };
  /** Дожимы и hh-ящик делят с отправкой и поиском сессию Telegram и браузерный профиль. */
  const busyWith = (): string | null => {
    if (search.running) return 'Идёт поиск — дождись его завершения.';
    if (send.running) return 'Идёт отправка — дождись её завершения.';
    if (followups.running) return 'Уже идёт работа с дожимами.';
    if (hh.running) return 'Идёт проверка откликов hh.ru — она держит тот же браузерный профиль.';
    return null;
  };

  // Отправка идёт минутами; запуск не ждёт её конца, панель опрашивает статус.
  // Одна точка и для кнопки «Отправить всё», и для автоотклика после поиска:
  // лимиты, паузы и остановки — те же самые.
  //
  // withoutLetters — человек подтвердил в панели, что заявки без письма уходят
  // без него. Автоотклик его не ставит никогда.
  const startSend = (origin: 'human' | 'auto', withoutLetters = false): void => {
    send.running = true;
    send.startedAt = Date.now();
    send.report = null;
    send.error = null;
    send.origin = origin;
    send.stopping = false;
    void (async () => {
      try {
        clearStop();
        const sender = new Sender(
          queue,
          new Map((deps.adapters ?? []).map((a) => [a.name, a])),
          deps.config!,
          { onSent: deps.onSent, allowEmptyLetter: withoutLetters },
        );
        send.report = await sender.run();
      } catch (e) {
        send.error = e instanceof Error ? e.message : String(e);
      } finally {
        // Флаг, поднятый кнопкой «Остановить отправку», своё отработал: не
        // оставляем его висеть до следующего запуска (`npm run status` иначе
        // предупреждал бы о нём, а send снимает его сам лишь при старте).
        if (send.stopping) clearStop();
        send.running = false;
        send.stopping = false;
      }
    })();
  };

  // Проверка ящика откликов hh.ru: минуты браузерной работы, поэтому запуск не ждёт конца.
  // Итог проверки пишет сама проверка (Dialogs.kvSet 'hh:lastReport'), панель читает его из status().
  const startHh = (origin: 'human' | 'timer'): void => {
    if (deps.hh === undefined) return;
    hh.running = true;
    hh.startedAt = Date.now();
    hh.origin = origin;
    hh.error = null;
    hh.stopping = false;
    void (async () => {
      try {
        await deps.hh!.check(() => hh.stopping);
      } catch (e) {
        hh.error = e instanceof Error ? e.message : String(e);
      } finally {
        hh.running = false;
        hh.stopping = false;
      }
    })();
  };
  // Плановая проверка: раз в минуту смотрим, не пора ли. Тумблер и интервал читает `due` из текущих настроек.
  const hhTimer = deps.hh === undefined
    ? null
    : setInterval(() => {
      if (busyWith() === null && deps.hh!.due(Date.now())) startHh('timer');
    }, 60_000);
  hhTimer?.unref();

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/api/pending') {
        return json(res, withContactWarnings(queue, queue.listByStatus('pending')));
      }
      if (req.method === 'GET' && req.url === '/api/approved') {
        return json(res, withContactWarnings(queue, queue.listByStatus('approved')));
      }

      if (req.url === '/api/telegram/dialogs' || req.url === '/api/telegram/resolve') {
        if (!deps.telegram) {
          return json(res, { error: 'Панель запущена без Telegram — открой её через npm run panel.' }, 409);
        }
        if (req.method === 'GET' && req.url === '/api/telegram/dialogs') {
          const r = await deps.telegram.dialogs();
          return r.ok ? json(res, { chats: r.chats }) : json(res, { error: r.error }, 502);
        }
        if (req.method === 'POST' && req.url === '/api/telegram/resolve') {
          const b = await readJson(req);
          const ref = typeof b['ref'] === 'string' ? b['ref'].trim() : '';
          if (ref === '') return json(res, { error: 'Впиши @имя канала или ссылку t.me.' }, 400);
          const r = await deps.telegram.resolve(ref);
          return r.ok ? json(res, { chat: r.chat }) : json(res, { error: r.error }, 502);
        }
      }
      if (req.method === 'POST' && req.url === '/api/approve') {
        const b = await readJson(req);
        try {
          queue.approve(Number(b['id']), typeof b['letter'] === 'string' ? b['letter'] : undefined);
        } catch (e) {
          return json(res, { error: e instanceof Error ? e.message : String(e) }, 409);
        }
        return json(res, { ok: true });
      }
      if (req.method === 'GET' && req.url === '/api/dialogs') {
        if (!deps.dialogs) {
          return json(res, { error: 'Панель запущена без диалогов — открой её через npm run panel.' }, 409);
        }
        return json(res, deps.dialogs.snapshot(Date.now()));
      }
      if (req.url !== undefined && req.url.startsWith('/api/hh/')) {
        const h = deps.hh;
        if (h === undefined) {
          return json(res, { error: 'Панель запущена без ящика откликов — открой её через npm run panel.' }, 409);
        }
        if (req.method === 'GET' && req.url === '/api/hh/status') {
          return json(res, {
            running: hh.running, startedAt: hh.startedAt, origin: hh.origin, error: hh.error, stopping: hh.stopping,
            ...h.status(),
          });
        }
        if (req.method === 'POST' && req.url === '/api/hh/stop') {
          if (!hh.running) return json(res, { error: 'Проверка сейчас не идёт — останавливать нечего.' }, 409);
          hh.stopping = true;
          return json(res, { ok: true });
        }
        if (req.method === 'POST' && req.url === '/api/hh/check') {
          const busy = busyWith();
          if (busy !== null) return json(res, { error: busy }, 409);
          startHh('human');
          return json(res, { started: true }, 202);
        }
      }
      if (req.url !== undefined && req.url.startsWith('/api/followups')) {
        const f = deps.followups;
        if (f === undefined) {
          return json(res, { error: 'Панель запущена без дожимов — открой её через npm run panel.' }, 409);
        }
        if (req.method === 'GET' && req.url === '/api/followups') {
          return json(res, { enabled: f.enabled(), waiting: f.waiting(), items: f.list() });
        }
        if (req.method === 'GET' && req.url === '/api/followups/status') {
          return json(res, {
            running: followups.running, kind: followups.kind, result: followups.result,
            error: followups.error, stopping: followups.stopping,
          });
        }
        if (req.method === 'POST' && req.url === '/api/followups/stop') {
          if (!followups.running || followups.kind !== 'send') return json(res, { error: 'Дожимы сейчас не отправляются — останавливать нечего.' }, 409);
          followups.stopping = true;
          return json(res, { stopping: true }, 202);
        }
        if (req.method === 'POST' && req.url === '/api/followups/prepare') {
          const busy = busyWith();
          if (busy !== null) return json(res, { error: busy }, 409);
          followups.running = true; followups.kind = 'prepare'; followups.result = null; followups.error = null; followups.stopping = false;
          void (async () => {
            try {
              followups.result = await f.prepare();
            } catch (e) {
              followups.error = e instanceof Error ? e.message : String(e);
            } finally {
              followups.running = false;
            }
          })();
          return json(res, { started: true }, 202);
        }
        if (req.method === 'POST' && req.url === '/api/followups/send') {
          if (!f.enabled()) {
            return json(res, { error: 'Дожимы выключены в настройках («Дожимы»): отправка невозможна.' }, 409);
          }
          const busy = busyWith();
          if (busy !== null) return json(res, { error: busy }, 409);
          const b = await readJson(req).catch(() => ({} as Record<string, unknown>));
          const ids = Array.isArray(b['ids']) && b['ids'].every((x) => Number.isInteger(x)) ? b['ids'] as number[] : 'all';
          followups.running = true; followups.kind = 'send'; followups.result = null; followups.error = null; followups.stopping = false;
          void (async () => {
            try {
              followups.result = await f.send(ids, () => followups.stopping);
            } catch (e) {
              followups.error = e instanceof Error ? e.message : String(e);
            } finally {
              followups.running = false;
              followups.stopping = false;
            }
          })();
          return json(res, { started: true }, 202);
        }
        if (req.method === 'POST' && req.url === '/api/followups/text') {
          const b = await readJson(req);
          const id = Number(b['id']);
          const text = typeof b['text'] === 'string' ? b['text'].trim() : '';
          if (!Number.isInteger(id)) return json(res, { error: 'нужен числовой id' }, 400);
          if (text.length < 1 || text.length > 400) return json(res, { error: 'Текст дожима — от 1 до 400 символов.' }, 400);
          return f.setText(id, text) === 'ok'
            ? json(res, { ok: true })
            : json(res, { error: 'Править можно только черновик.' }, 409);
        }
        if (req.method === 'POST' && req.url === '/api/followups/cancel') {
          const b = await readJson(req);
          return f.cancel(Number(b['id'])) ? json(res, { ok: true }) : json(res, { error: 'Отменить можно только черновик.' }, 409);
        }
      }

      if (req.method === 'GET' && req.url === '/api/sent') {
        // Вкладка «Отправлено» (спека 7.4): что ушло за 30 дней и кто одобрил.
        return json(res, queue.listSentSince(Date.now() - 30 * 86_400_000));
      }
      if (req.method === 'GET' && req.url === '/api/skipped') {
        // Только за последние сутки: вкладка нужна для отмены промаха,
        // а не как архив всего отклонённого. Сами строки не удаляются —
        // иначе дедуп забыл бы вакансию и поиск притащил бы её снова.
        return json(res, queue.listRecentSkipped(SKIPPED_WINDOW_MS));
      }

      if (req.method === 'GET' && req.url === '/api/search/status') {
        return json(res, {
          running: search.running,
          canSearch,
          result: search.result,
          error: search.error,
          startedAt: search.startedAt,
          stopping: search.stopping,
        });
      }

      if (req.method === 'POST' && req.url === '/api/search/stop') {
        if (!search.running || searchAbort === null) return json(res, { error: 'Поиск не идёт — останавливать нечего.' }, 409);
        search.stopping = true;
        searchAbort.abort();
        return json(res, { stopping: true });
      }

      if (req.method === 'POST' && req.url === '/api/search/start') {
        if (!canSearch) {
          return json(res, { error: 'Панель запущена без поиска — используй npm run search.' }, 409);
        }
        // Поиск и отправка держат один и тот же браузерный профиль
        // (browser-profile/, см. src/browser.ts) — обеим командам нужен один
        // и тот же Chromium с одной и той же залогиненной сессией. Запуск
        // отправки поверх идущего поиска (или наоборот) раньше падал на
        // первой же заявке/странице, и предохранитель maxConsecutiveFailures
        // в sender.ts останавливал очередь так, будто площадка сломалась —
        // хотя сломалась не площадка, а одновременный доступ к профилю.
        if (send.running) {
          return json(res, { error: 'Отправка уже идёт — дождись её завершения, прежде чем запускать поиск.' }, 409);
        }
        if (followups.running) {
          return json(res, { error: 'Идёт работа с дожимами — они делят с поиском сессию Telegram. Дождись их завершения.' }, 409);
        }
        if (hh.running) {
          return json(res, { error: 'Идёт проверка откликов hh.ru — она держит тот же браузерный профиль. Дождись её завершения.' }, 409);
        }
        if (search.running) {
          return json(res, { error: 'Поиск уже идёт.' }, 409);
        }

        const body = await readJson(req);
        const limit = Number(body['limit']);
        if (!Number.isInteger(limit) || limit <= 0) {
          return json(res, { error: 'Число вакансий должно быть целым положительным.' }, 400);
        }

        search.running = true;
        search.startedAt = Date.now();
        search.result = null;
        search.error = null;
        search.stopping = false;
        const abort = new AbortController();
        searchAbort = abort;

        // Не ждём: ответ уходит сразу, панель опрашивает статус.
        void (async () => {
          try {
            search.result = await deps.startSearch!(limit, abort.signal);
          } catch (e) {
            search.error = e instanceof Error ? e.message : String(e);
          } finally {
            search.running = false;
            search.stopping = false;
            searchAbort = null;
          }
          // Автоотклик (спека 7.2): поиск уже одобрил годное — отправка
          // стартует сама, тем же путём, что кнопка. Остановленный человеком
          // поиск её не запускает: он передумал, и отправлять за него то, что
          // успело набраться, значило бы сделать обратное.
          if (canSend && !abort.signal.aborted && (search.result?.autoApproved ?? 0) > 0 && !send.running) {
            startSend('auto');
          }
        })();

        return json(res, { started: true }, 202);
      }

      // Живое состояние прокси. Отдельной ручкой, а не полем в статусе
      // отправки: VPN включают и выключают по ходу работы, и панель должна
      // замечать это без перезапуска.
      if (req.method === 'GET' && req.url === '/api/proxy/status') {
        if (!deps.proxyStatus) return json(res, { usable: null });
        const { found, checked } = await deps.proxyStatus();
        return json(res, {
          usable: found !== null,
          address: found === null ? null : `${found.host}:${found.port}`,
          checked,
        });
      }

      if (req.method === 'GET' && req.url === '/api/letters/status') {
        return json(res, {
          running: letters.running,
          canFillLetters,
          result: letters.result,
          error: letters.error,
          startedAt: letters.startedAt,
          stopping: letters.stopping,
        });
      }

      if (req.method === 'POST' && req.url === '/api/letters/stop') {
        if (!letters.running || lettersAbort === null) {
          return json(res, { error: 'Письма сейчас не пишутся — останавливать нечего.' }, 409);
        }
        letters.stopping = true;
        lettersAbort.abort();
        return json(res, { stopping: true });
      }

      if (req.method === 'POST' && req.url === '/api/letters/start') {
        if (!canFillLetters) {
          return json(res, { error: 'Панель запущена без генерации писем — используй npm run letters.' }, 409);
        }
        if (letters.running) return json(res, { error: 'Дозаполнение уже идёт.' }, 409);
        // Поиск тоже зовёт модель; два потока генерации разом упрутся в лимит
        // быстрее, чем один, и разобрать, кто чей 429, будет невозможно.
        if (search.running) {
          return json(res, { error: 'Идёт поиск — он тоже пишет письма. Дождись его.' }, 409);
        }

        letters.running = true;
        letters.startedAt = Date.now();
        letters.result = null;
        letters.error = null;
        letters.stopping = false;
        const abort = new AbortController();
        lettersAbort = abort;

        void (async () => {
          try {
            letters.result = await deps.fillLetters!(abort.signal);
          } catch (e) {
            letters.error = e instanceof Error ? e.message : String(e);
          } finally {
            letters.running = false;
            letters.stopping = false;
            lettersAbort = null;
          }
        })();

        return json(res, { started: true }, 202);
      }

      // Письмо, вписанное руками. Отдельная ручка, а не /api/approve: approve
      // меняет статус и на уже одобренной строке бросает, а править надо
      // именно письмо. Queue.setLetter пускает сюда только пустое письмо
      // одобренной строки — непустое одобренное не перезаписывается ниоткуда.
      if (req.method === 'POST' && req.url === '/api/letter') {
        const body = await readJson(req);
        const id = Number(body['id']);
        const letter = String(body['letter'] ?? '');
        if (!Number.isInteger(id)) return json(res, { error: 'нужен числовой id' }, 400);
        if (letter.trim() === '') return json(res, { error: 'письмо пустое' }, 400);
        try {
          queue.setLetter(id, letter, 'manual');
          return json(res, { ok: true });
        } catch (e) {
          return json(res, { error: e instanceof Error ? e.message : String(e) }, 409);
        }
      }

      if (req.method === 'GET' && req.url === '/api/send/status') {
        return json(res, {
          running: send.running,
          canSend,
          report: send.report,
          error: send.error,
          approved: queue.listByStatus('approved').length,
          startedAt: send.startedAt,
          origin: send.origin,
          stopping: send.stopping,
        });
      }

      if (req.method === 'POST' && req.url === '/api/send/stop') {
        // Флаг поднимается только при идущей отправке. Клик впустую не должен
        // оставлять после себя флаг, а молча проглотить его значило бы обмануть
        // человека — поэтому явный 409.
        if (!send.running) return json(res, { error: 'Отправка не идёт — останавливать нечего.' }, 409);
        send.stopping = true;
        requestStop();
        return json(res, { stopping: true });
      }

      if (req.method === 'POST' && req.url === '/api/send/start') {
        if (!canSend) {
          return json(res, { error: 'Панель запущена без адаптеров — отправка недоступна.' }, 409);
        }
        // Тот же общий браузерный профиль, что и у поиска (см. комментарий в
        // /api/search/start) — отправка поверх идущего поиска падает на
        // первой же заявке, а не только вторая отправка поверх идущей.
        if (search.running) {
          return json(res, { error: 'Поиск уже идёт — дождись его завершения, прежде чем запускать отправку.' }, 409);
        }
        // Вторая отправка поверх идущей означала бы две попытки подать одну и
        // ту же заявку одновременно. Отказываем явно, а не молча.
        if (send.running) {
          return json(res, { error: 'Отправка уже идёт.' }, 409);
        }
        if (followups.running) {
          return json(res, { error: 'Идёт работа с дожимами — они делят с отправкой сессию Telegram. Дождись их завершения.' }, 409);
        }
        if (hh.running) {
          return json(res, { error: 'Идёт проверка откликов hh.ru — она держит тот же браузерный профиль. Дождись её завершения.' }, 409);
        }

        // «Отправить без письма» — только по явному true от панели, которая
        // предупредила человека. Тело может быть пустым (старые вызовы).
        const body = await readJson(req).catch(() => ({} as Record<string, unknown>));
        startSend('human', body['withoutLetters'] === true);
        return json(res, { started: true }, 202);
      }

      if (req.method === 'POST' && req.url === '/api/skipped/clear') {
        // Чистит вкладку, а не базу. Строки остаются, иначе дедуп забыл бы
        // отклонённые вакансии и следующий поиск вернул бы их в очередь.
        const cleared = queue.archiveSkipped();
        return json(res, { ok: true, cleared });
      }

      if (req.method === 'POST' && req.url === '/api/unskip') {
        // Возврат отменённой строки на рассмотрение. «Пропустить» — один клик
        // с необратимым эффектом: строка исчезает из панели, а повторный поиск
        // её не находит из-за дедупа. Без этой кнопки промах мышью стоил бы
        // вакансии навсегда.
        const b = await readJson(req);
        try {
          queue.unskip(Number(b['id']));
        } catch (e) {
          return json(res, { error: e instanceof Error ? e.message : String(e) }, 409);
        }
        return json(res, { ok: true });
      }

      if (req.method === 'POST' && req.url === '/api/skip') {
        const b = await readJson(req);
        try {
          queue.skip(Number(b['id']));
        } catch (e) {
          return json(res, { error: e instanceof Error ? e.message : String(e) }, 409);
        }
        return json(res, { ok: true });
      }
      if (req.url === '/api/settings' || req.url === '/api/settings/suggest') {
        if (!deps.settings) {
          return json(res, { error: 'Панель запущена без настроек — открой её через npm run panel.' }, 409);
        }
        if (req.method === 'GET' && req.url === '/api/settings') {
          return json(res, deps.settings.get());
        }
        if (req.method === 'POST' && req.url === '/api/settings') {
          const wasAuto = deps.settings.get().autoApply.enabled;
          // Проверку делает save (core/settings.ts#validateSettings и PDF в
          // cli.ts); её причина уходит в панель как есть — это текст для
          // человека, а не код ошибки.
          const r = await deps.settings.save(await readJson(req));
          // Тумблер выключили посреди автоматической отправки — она
          // останавливается так же, как по npm run stop (спека 7.3). Ручную,
          // запущенную кнопкой, тумблер не трогает.
          if (r.ok && wasAuto && !r.settings.autoApply.enabled && send.running && send.origin === 'auto') {
            requestStop();
          }
          return r.ok ? json(res, { ok: true, settings: r.settings }) : json(res, { error: r.error }, 400);
        }
        if (req.method === 'POST' && req.url === '/api/settings/suggest') {
          const b = await readJson(req);
          const name = typeof b['name'] === 'string' ? b['name'].trim() : '';
          if (name === '') return json(res, { error: 'Сначала впиши название специальности.' }, 400);
          const pdf = typeof b['resumePdf'] === 'string' && b['resumePdf'].trim() !== '' ? b['resumePdf'].trim() : null;
          const r = await deps.settings.suggest(name, pdf);
          // 502: сама панель исправна, не ответила модель за ней.
          return r.ok ? json(res, { suggestion: r.suggestion }) : json(res, { error: r.error }, 502);
        }
      }

      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(readFileSync(PANEL_HTML, 'utf8'));
      }
      json(res, { error: 'not found' }, 404);
    } catch (e) {
      // Всё, что не является ожидаемым нелегальным переходом статуса (см.
      // catch-и вокруг queue.approve/queue.skip выше) — например, битый
      // JSON в теле запроса или ошибка чтения panel.html — остаётся
      // настоящей 500-кой: это сбой сервера, а не то, что пользователь мог
      // спровоцировать двойным кликом по кнопке в интерфейсе.
      json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // Слушаем только на loopback: панель раскрывает поиск вакансий и черновики
  // писем пользователя, она не должна быть видна из сети.
  // Порт 0 просит систему выдать свободный. Возвращаем фактический, чтобы
  // вызывающий не гадал: в тестах это снимает гонку за фиксированный порт
  // между перезапусками панели.
  //
  // Ошибку listen ловим явно. Без обработчика 'error' Node роняет процесс
  // необработанным событием, и человек, дважды открывший панель, получает
  // вместо объяснения дамп стека на двадцать строк — при том что причина
  // ровно одна и она безобидная: панель уже запущена в другом окне.
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      rejectListen(
        e.code === 'EADDRINUSE'
          ? new Error(
            `Порт ${port} занят — скорее всего, панель уже запущена в другом окне. `
            + `Открой http://127.0.0.1:${port} или закрой то окно (Ctrl+C) и повтори.`,
          )
          : e,
      );
    });
    server.listen(port, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    port: actualPort,
    close: async () => {
      if (hhTimer !== null) clearInterval(hhTimer);
      await new Promise<void>((r) => server.close(() => r()));
      // Отпускаем браузерные контексты адаптеров, у кого они есть (сейчас —
      // только HhAdapter.close(), см. src/adapters/hh.ts). Не часть Adapter
      // (types.ts осознанно остаётся с двумя методами) — вызывается по
      // утиной типизации, необязательно: адаптер без close() просто
      // пропускается, HrGeAdapter не держит ничего, что нужно закрывать.
      for (const a of deps.adapters ?? []) {
        const maybeClose = (a as { close?: () => Promise<void> }).close;
        if (typeof maybeClose === 'function') await maybeClose.call(a).catch(() => {});
      }
    },
  };
}
