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

export interface PanelDeps {
  /** Нужны только для отправки. Без них кнопка «Отправить всё» недоступна. */
  adapters?: Adapter[];
  config?: Config;
}

export async function startPanel(
  queue: Queue, port: number, deps: PanelDeps = {},
): Promise<{ port: number; close(): Promise<void> }> {
  const send: SendState = { running: false, startedAt: null, report: null, error: null };
  const canSend = deps.adapters !== undefined && deps.config !== undefined;

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

      if (req.method === 'GET' && req.url === '/api/send/status') {
        return json(res, {
          running: send.running,
          canSend,
          report: send.report,
          error: send.error,
          approved: queue.listByStatus('approved').length,
        });
      }

      if (req.method === 'POST' && req.url === '/api/send/start') {
        if (!canSend) {
          return json(res, { error: 'Панель запущена без адаптеров — отправка недоступна.' }, 409);
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
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    port: actualPort,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
