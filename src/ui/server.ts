import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Queue } from '../core/queue.js';
import type { Config } from '../core/config.js';
import type { Adapter } from '../adapters/types.js';
import { Sender, clearStop, type SendReport } from '../core/sender.js';

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
  result: { report: unknown; emptyLetters: number } | null;
  error: string | null;
}

/** Состояние дозаполнения писем. Та же схема, что у поиска и отправки, и по той же причине: это минуты. */
interface LettersState {
  running: boolean;
  startedAt: number | null;
  result: { found: number; filled: number; failure?: string } | null;
  error: string | null;
}

export interface PanelDeps {
  /** Нужны только для отправки. Без них кнопка «Отправить всё» недоступна. */
  adapters?: Adapter[];
  config?: Config;
  /**
   * Запуск поиска. Передаётся готовой функцией, а не собирается здесь из
   * кусков: панель — это http-слой, ей незачем знать про резюме, скелеты
   * писем и выбор модели. Вся эта проводка уже есть в cli.ts, и дублировать
   * её означало бы получить две расходящиеся версии одного и того же.
   *
   * Без неё кнопка поиска в панели недоступна.
   */
  startSearch?: (limit: number) => Promise<{ report: unknown; emptyLetters: number }>;
  /**
   * Дозаполнение пустых писем. Без неё кнопка «Дописать письма» недоступна.
   *
   * Нужна именно в панели, а не только командой: письмо может не
   * сгенерироваться (429, кончились деньги на OpenRouter), и человек видит
   * это в панели — там же должна быть и кнопка, а не отсылка в терминал.
   */
  fillLetters?: () => Promise<{ found: number; filled: number; failure?: string }>;
  /**
   * Ходит ли fetch этого процесса через прокси. Если нет и провайдер
   * блокирует прямые запросы, поиск и генерация писем внешне работают, но все
   * письма выходят пустыми — 2026-09-01 это стоило прогона на 22 вакансии.
   * Панель обязана сказать об этом сама, а не надеяться на консоль.
   */
  proxyEnabled?: boolean;
}

export async function startPanel(
  queue: Queue, port: number, deps: PanelDeps = {},
): Promise<{ port: number; close(): Promise<void> }> {
  const send: SendState = { running: false, startedAt: null, report: null, error: null };
  const canSend = deps.adapters !== undefined && deps.config !== undefined;
  const search: SearchState = { running: false, startedAt: null, result: null, error: null };
  const canSearch = deps.startSearch !== undefined;
  const letters: LettersState = { running: false, startedAt: null, result: null, error: null };
  const canFillLetters = deps.fillLetters !== undefined;

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/api/pending') {
        return json(res, queue.listByStatus('pending'));
      }
      if (req.method === 'GET' && req.url === '/api/approved') {
        return json(res, queue.listByStatus('approved'));
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
        });
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

        // Не ждём: ответ уходит сразу, панель опрашивает статус.
        void (async () => {
          try {
            search.result = await deps.startSearch!(limit);
          } catch (e) {
            search.error = e instanceof Error ? e.message : String(e);
          } finally {
            search.running = false;
          }
        })();

        return json(res, { started: true }, 202);
      }

      if (req.method === 'GET' && req.url === '/api/letters/status') {
        return json(res, {
          running: letters.running,
          canFillLetters,
          // undefined означает «панель поднята не из cli и не знает» — тогда
          // полосу не показываем, чтобы не пугать зря (так её поднимают тесты).
          proxyEnabled: deps.proxyEnabled,
          result: letters.result,
          error: letters.error,
          startedAt: letters.startedAt,
        });
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

        void (async () => {
          try {
            letters.result = await deps.fillLetters!();
          } catch (e) {
            letters.error = e instanceof Error ? e.message : String(e);
          } finally {
            letters.running = false;
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
        });
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

        send.running = true;
        send.startedAt = Date.now();
        send.report = null;
        send.error = null;

        // Намеренно не ждём: ответ уходит сразу, панель опрашивает статус.
        void (async () => {
          try {
            clearStop();
            const sender = new Sender(
              queue,
              new Map((deps.adapters ?? []).map((a) => [a.name, a])),
              deps.config!,
            );
            send.report = await sender.run();
          } catch (e) {
            send.error = e instanceof Error ? e.message : String(e);
          } finally {
            send.running = false;
          }
        })();

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
