import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Queue } from '../core/queue.js';

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

export async function startPanel(
  queue: Queue, port: number,
): Promise<{ close(): Promise<void> }> {
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
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));

  return {
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
