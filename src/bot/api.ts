import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createProxiedFetch } from '../core/proxy.js';
import { BUTTONS } from './texts.js';
import type { TgBotUpdate } from './types.js';

/**
 * Клиент Bot API на несколько методов. Библиотеку ради них не берём: прокси
 * уже даёт core/proxy.ts, а подмена fetchImpl — то, на чём стоят тесты всего
 * проекта (см. adapters/hrge.ts, core/openrouter.ts).
 *
 * Здесь же проходит граница «транспорт»: переезд на VPS или на вебхук меняет
 * этот файл и bot/run.ts, а логика (bot/handlers.ts) остаётся нетронутой.
 */

export interface ApiFailure {
  kind: 'auth' | 'conflict' | 'flood' | 'network' | 'http';
  message: string;
  /** Только для flood: сколько Telegram просит подождать. */
  retryAfterMs?: number;
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; failure: ApiFailure };

const DEFAULT_TIMEOUT_MS = 45_000;

export class BotApi {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(token: string, opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.token = token;
    this.fetchImpl = opts.fetchImpl ?? createProxiedFetch();
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  private failureOf(status: number, description: string, retryAfter: number | undefined): ApiFailure {
    if (status === 401) return { kind: 'auth', message: description };
    if (status === 409) return { kind: 'conflict', message: description };
    if (status === 429) return { kind: 'flood', message: description, retryAfterMs: (retryAfter ?? 5) * 1000 };
    return { kind: 'http', message: description };
  }

  private async call<T>(method: string, payload: unknown, timeoutMs = this.timeoutMs): Promise<ApiResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(this.url(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await res.json() as {
        ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number };
      };
      if (res.ok && body.ok === true && body.result !== undefined) return { ok: true, value: body.result };
      const description = body.description ?? `HTTP ${res.status}`;
      return { ok: false, failure: this.failureOf(res.status, description, body.parameters?.retry_after) };
    } catch (e) {
      return { ok: false, failure: { kind: 'network', message: e instanceof Error ? e.message : String(e) } };
    } finally {
      clearTimeout(timer);
    }
  }

  /** timeoutS — long polling: Telegram держит запрос, пока нет апдейтов. */
  getUpdates(offset: number, timeoutS = 30): Promise<ApiResult<TgBotUpdate[]>> {
    return this.call<TgBotUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutS, allowed_updates: ['message'] },
      (timeoutS + 15) * 1000,
    );
  }

  async sendMessage(chatId: number, text: string, opts: { keyboard?: boolean } = {}): Promise<ApiResult<number>> {
    const payload: Record<string, unknown> = { chat_id: chatId, text, disable_web_page_preview: true };
    if (opts.keyboard === true) {
      payload['reply_markup'] = {
        keyboard: [[BUTTONS[0], BUTTONS[1]], [BUTTONS[2], BUTTONS[3]]],
        resize_keyboard: true,
      };
    }
    const r = await this.call<{ message_id: number }>('sendMessage', payload);
    return r.ok ? { ok: true, value: r.value.message_id } : r;
  }

  /** Возвращает file_id отправленного документа — его кешируем, чтобы не грузить PDF заново. */
  async sendDocumentByFileId(chatId: number, fileId: string, caption: string): Promise<ApiResult<string>> {
    const r = await this.call<{ document?: { file_id: string } }>(
      'sendDocument',
      { chat_id: chatId, document: fileId, caption },
    );
    return r.ok ? { ok: true, value: r.value.document?.file_id ?? fileId } : r;
  }

  async sendDocumentByPath(
    chatId: number, path: string, filename: string, caption: string,
  ): Promise<ApiResult<string>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const form = new FormData();
      form.set('chat_id', String(chatId));
      form.set('caption', caption);
      form.set('document', new Blob([readFileSync(path)]), filename);
      const res = await this.fetchImpl(this.url('sendDocument'), {
        method: 'POST', body: form, signal: controller.signal,
      });
      const body = await res.json() as {
        ok?: boolean; result?: { document?: { file_id: string } }; description?: string;
        parameters?: { retry_after?: number };
      };
      if (res.ok && body.ok === true) return { ok: true, value: body.result?.document?.file_id ?? '' };
      const description = body.description ?? `HTTP ${res.status}`;
      return { ok: false, failure: this.failureOf(res.status, description, body.parameters?.retry_after) };
    } catch (e) {
      return { ok: false, failure: { kind: 'network', message: e instanceof Error ? e.message : String(e) } };
    } finally {
      clearTimeout(timer);
    }
  }

  async getFile(fileId: string): Promise<ApiResult<{ filePath: string; size: number }>> {
    const r = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
    if (!r.ok) return r;
    const filePath = r.value.file_path;
    if (filePath === undefined) return { ok: false, failure: { kind: 'http', message: 'getFile без file_path' } };
    return { ok: true, value: { filePath, size: r.value.file_size ?? 0 } };
  }

  /**
   * Качает файл в dest. maxBytes проверяется по фактически прочитанному телу,
   * а не по заявленному размеру: заявить можно что угодно.
   */
  async download(filePath: string, dest: string, maxBytes: number): Promise<ApiResult<number>> {
    try {
      const res = await this.fetchImpl(`https://api.telegram.org/file/bot${this.token}/${filePath}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > maxBytes) {
        return { ok: false, failure: { kind: 'http', message: `файл больше ${maxBytes} байт` } };
      }
      writeFileSync(dest, buf);
      return { ok: true, value: buf.byteLength };
    } catch (e) {
      try {
        unlinkSync(dest);
      } catch {
        // файла может и не быть — это не ошибка
      }
      return { ok: false, failure: { kind: 'network', message: e instanceof Error ? e.message : String(e) } };
    }
  }

  getWebhookInfo(): Promise<ApiResult<{ url: string }>> {
    return this.call<{ url: string }>('getWebhookInfo', {});
  }
}
