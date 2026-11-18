import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createProxiedFetch } from '../core/proxy.js';
import { BUTTONS } from './texts.js';
import type { TgBotUpdate, TgBotUser, TgBusinessConnection } from './types.js';

/**
 * Клиент Bot API на несколько методов. Библиотеку ради них не берём: прокси
 * уже даёт core/proxy.ts, а подмена fetchImpl — то, на чём стоят тесты всего
 * проекта (см. adapters/hrge.ts, core/openrouter.ts).
 *
 * Здесь же проходит граница «транспорт»: переезд на VPS или на вебхук меняет
 * этот файл и bot/run.ts, а логика (bot/handlers.ts) остаётся нетронутой.
 */

export interface ApiFailure {
  /**
   * 'business' — 400/403 на вызове с business_connection_id: окно 24 часа
   * закрыто, права отозваны, соединение выключено. Для секретаря это штатное
   * «ответить нельзя», а не сбой.
   */
  kind: 'auth' | 'conflict' | 'flood' | 'network' | 'http' | 'business';
  message: string;
  /** Только для flood: сколько Telegram просит подождать. */
  retryAfterMs?: number;
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; failure: ApiFailure };

const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * Что просит бот у Telegram. Секретарские апдейты (Secretary Mode) приходят
 * отдельными типами: без них до бота не доходит ни одно сообщение из личных
 * чатов подключённого аккаунта. Удалённые сообщения не нужны.
 */
export const ALLOWED_UPDATES = [
  'message', 'business_connection', 'business_message', 'edited_business_message',
] as const;

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

  private failureOf(
    status: number, description: string, retryAfter: number | undefined, business = false,
  ): ApiFailure {
    if (status === 401) return { kind: 'auth', message: description };
    if (status === 409) return { kind: 'conflict', message: description };
    if (status === 429) return { kind: 'flood', message: description, retryAfterMs: (retryAfter ?? 5) * 1000 };
    if (business && (status === 400 || status === 403)) return { kind: 'business', message: description };
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
      const business = typeof payload === 'object' && payload !== null
        && (payload as Record<string, unknown>)['business_connection_id'] !== undefined;
      return { ok: false, failure: this.failureOf(res.status, description, body.parameters?.retry_after, business) };
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
      { offset, timeout: timeoutS, allowed_updates: ALLOWED_UPDATES },
      (timeoutS + 15) * 1000,
    );
  }

  async sendMessage(
    chatId: number, text: string, opts: { keyboard?: boolean; businessConnectionId?: string } = {},
  ): Promise<ApiResult<number>> {
    const payload: Record<string, unknown> = { chat_id: chatId, text, disable_web_page_preview: true };
    // В чате чужого аккаунта клавиатуры быть не может: она осталась бы на экране
    // у рекрутёра, а он с ботом не разговаривает.
    if (opts.businessConnectionId !== undefined) payload['business_connection_id'] = opts.businessConnectionId;
    if (opts.keyboard === true && opts.businessConnectionId === undefined) {
      payload['reply_markup'] = {
        keyboard: [[BUTTONS[0], BUTTONS[1]], [BUTTONS[2], BUTTONS[3]]],
        resize_keyboard: true,
      };
    }
    const r = await this.call<{ message_id: number }>('sendMessage', payload);
    return r.ok ? { ok: true, value: r.value.message_id } : r;
  }

  /** Возвращает file_id отправленного документа — его кешируем, чтобы не грузить PDF заново. */
  async sendDocumentByFileId(
    chatId: number, fileId: string, caption: string, businessConnectionId?: string,
  ): Promise<ApiResult<string>> {
    const payload: Record<string, unknown> = { chat_id: chatId, document: fileId, caption };
    if (businessConnectionId !== undefined) payload['business_connection_id'] = businessConnectionId;
    const r = await this.call<{ document?: { file_id: string } }>('sendDocument', payload);
    return r.ok ? { ok: true, value: r.value.document?.file_id ?? fileId } : r;
  }

  /** Резюме с диска. Файл читается внутри общей отправки: его отсутствие — отказ, а не исключение. */
  sendDocumentByPath(
    chatId: number, path: string, filename: string, caption: string, businessConnectionId?: string,
  ): Promise<ApiResult<string>> {
    return this.uploadDocument(chatId, () => readFileSync(path), filename, caption, businessConnectionId);
  }

  /** Текст документом, без файла на диске: так владельцу уходит вакансия вместе с пингом. */
  sendDocumentFromText(
    chatId: number, filename: string, content: string, caption: string,
  ): Promise<ApiResult<string>> {
    return this.uploadDocument(chatId, () => Buffer.from(content, 'utf8'), filename, caption);
  }

  /**
   * Файл уходит ОДНИМ буфером с рассчитанным Content-Length, а не через
   * FormData. Живой прогон 2026-09-20: FormData поверх undici ProxyAgent
   * (а весь трафик к Telegram идёт через прокси, см. core/proxy.ts) теряет
   * файловую часть — Telegram отвечает «there is no document in the request»
   * и на маленьком txt, и на резюме, с любым именем файла. Тот же запрос
   * готовым буфером проходит. Файл у нас не больше 5 МБ, держать его в памяти
   * дешевле, чем разбираться в стриминге через туннель.
   */
  private async uploadDocument(
    chatId: number, readBytes: () => Uint8Array, filename: string, caption: string,
    businessConnectionId?: string,
  ): Promise<ApiResult<string>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const boundary = `----jaa${randomUUID().replace(/-/g, '')}`;
      const field = (name: string, value: string): string =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
      // В имени файла кавычки и переводы строк сломали бы заголовок части.
      const safeName = filename.replace(/["\r\n]/g, '_');
      const head = Buffer.from(
        field('chat_id', String(chatId)) + field('caption', caption)
        + (businessConnectionId === undefined ? '' : field('business_connection_id', businessConnectionId))
        + `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${safeName}"\r\n`
        + 'Content-Type: application/octet-stream\r\n\r\n',
        'utf8',
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
      const body = Buffer.concat([head, readBytes(), tail]);
      const res = await this.fetchImpl(this.url('sendDocument'), {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(body.length),
        },
        body,
        signal: controller.signal,
      });
      const parsed = await res.json() as {
        ok?: boolean; result?: { document?: { file_id: string } }; description?: string;
        parameters?: { retry_after?: number };
      };
      if (res.ok && parsed.ok === true) return { ok: true, value: parsed.result?.document?.file_id ?? '' };
      const description = parsed.description ?? `HTTP ${res.status}`;
      return {
        ok: false,
        failure: this.failureOf(res.status, description, parsed.parameters?.retry_after, businessConnectionId !== undefined),
      };
    } catch (e) {
      return { ok: false, failure: { kind: 'network', message: e instanceof Error ? e.message : String(e) } };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Несколько файлов одним альбомом (sendMediaGroup): подпись стоит на последнем,
   * а уведомление приходит одно. Нужен пингу о собеседовании — текст вакансии и
   * файл .ics приходят вместе. Файлы уходят одним буфером с Content-Length, как и
   * одиночный документ (см. uploadDocument): FormData поверх прокси теряет файловую часть.
   */
  async sendDocumentsFromText(
    chatId: number, files: Array<{ name: string; content: string }>, caption: string,
  ): Promise<ApiResult<number>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const boundary = `----jaa${randomUUID().replace(/-/g, '')}`;
      const field = (name: string, value: string): string =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
      const media = files.map((_f, i) => ({
        type: 'document', media: `attach://f${i}`, ...(i === files.length - 1 ? { caption } : {}),
      }));
      const chunks: Buffer[] = [
        Buffer.from(field('chat_id', String(chatId)) + field('media', JSON.stringify(media)), 'utf8'),
      ];
      files.forEach((f, i) => {
        const safeName = f.name.replace(/["\r\n]/g, '_');
        chunks.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="f${i}"; filename="${safeName}"\r\n`
          + 'Content-Type: application/octet-stream\r\n\r\n', 'utf8'));
        chunks.push(Buffer.from(f.content, 'utf8'));
        chunks.push(Buffer.from('\r\n', 'utf8'));
      });
      chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
      const body = Buffer.concat(chunks);
      const res = await this.fetchImpl(this.url('sendMediaGroup'), {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(body.length),
        },
        body,
        signal: controller.signal,
      });
      const parsed = await res.json() as {
        ok?: boolean; result?: unknown[]; description?: string; parameters?: { retry_after?: number };
      };
      if (res.ok && parsed.ok === true) return { ok: true, value: parsed.result?.length ?? files.length };
      return {
        ok: false,
        failure: this.failureOf(res.status, parsed.description ?? `HTTP ${res.status}`, parsed.parameters?.retry_after),
      };
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

  /** Кто мы и можно ли подключать бота к аккаунтам (can_connect_to_business). */
  getMe(): Promise<ApiResult<TgBotUser & { can_connect_to_business?: boolean }>> {
    return this.call<TgBotUser & { can_connect_to_business?: boolean }>('getMe', {});
  }

  /** Подключение секретаря по id: владелец, права, включено ли. Нужно, когда апдейт о подключении бот пропустил. */
  getBusinessConnection(id: string): Promise<ApiResult<TgBusinessConnection>> {
    return this.call<TgBusinessConnection>('getBusinessConnection', { business_connection_id: id });
  }

  /** «печатает…» перед ответом модели. Ошибка не важна: вызывающий её глотает. */
  async sendChatAction(chatId: number, action: 'typing', businessConnectionId?: string): Promise<ApiResult<true>> {
    const payload: Record<string, unknown> = { chat_id: chatId, action };
    if (businessConnectionId !== undefined) payload['business_connection_id'] = businessConnectionId;
    return this.call<true>('sendChatAction', payload, 10_000);
  }
}
