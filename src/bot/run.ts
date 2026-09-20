import { existsSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BotApi, ApiFailure } from './api.js';
import type { BotStore } from './state.js';
import { handleMessage, type BotAction, type HandlerDeps } from './handlers.js';
import { TEXTS } from './texts.js';
import { MAX_FILE_BYTES, isObviouslyUnsupported, sniffFileKind } from './intake.js';
import { extractFileText } from './extract.js';
import type { TgBotDocument } from './types.js';

/**
 * Цикл long polling. Вместе с bot/api.ts это единственное место, где бот
 * касается сети, файлов и часов, — поэтому переезд на VPS или на вебхук меняет
 * два файла, а логика (bot/handlers.ts) остаётся нетронутой.
 */

/** Куда кладётся присланный файл на время разбора. Имя генерим сами. */
export const INBOX_DIR = 'data/bot-inbox';
const MIN_FILE_TEXT = 200;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const LOG_QUIET_MS = 60_000;

export interface RunBotOptions {
  api: BotApi;
  store: BotStore;
  deps: HandlerDeps;
  /** Куда слать пинги. null — не заданы, бот подскажет chat_id в логе. */
  ownerChatId: number | null;
  log: (line: string) => void;
  /** Путь к PDF резюме для /cv. null — резюме не подключено. */
  resumePdf?: () => string | null;
  /** Только для тестов: столько пустых кругов подряд — и цикл выходит. */
  stopAfterIdleRounds?: number;
  /** Пауза между кругами (в бою её задаёт long polling, в тестах — 0). */
  sleep?: (ms: number) => Promise<void>;
  stopRequested?: () => boolean;
}

const wait = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/**
 * Чтение присланного файла: тип по расширению — до скачивания, по сигнатуре —
 * после. Файл живёт ровно до конца разбора и удаляется даже при ошибке: держать
 * чужие файлы на диске незачем.
 */
export function makeReadFile(api: BotApi): HandlerDeps['readFile'] {
  return async (doc: TgBotDocument) => {
    if (isObviouslyUnsupported(doc.file_name)) return { ok: false, reason: 'type' };
    if (doc.file_size !== undefined && doc.file_size > MAX_FILE_BYTES) return { ok: false, reason: 'size' };

    const file = await api.getFile(doc.file_id);
    if (!file.ok) return { ok: false, reason: 'unreadable' };

    mkdirSync(INBOX_DIR, { recursive: true });
    // Оригинальное имя не используется нигде: «..\..\» в нём увело бы запись
    // куда угодно (спека 2026-09-20, 5.5).
    const dest = join(INBOX_DIR, randomUUID());
    const got = await api.download(file.value.filePath, dest, MAX_FILE_BYTES);
    if (!got.ok) return { ok: false, reason: got.failure.message.includes('больше') ? 'size' : 'unreadable' };

    try {
      const { readFileSync } = await import('node:fs');
      const head = new Uint8Array(readFileSync(dest).subarray(0, 8));
      const kind = sniffFileKind(doc.file_name, doc.mime_type, head);
      if (kind === null) return { ok: false, reason: 'type' };
      const text = await extractFileText(dest, kind);
      if (!text.ok || text.text.trim().length < MIN_FILE_TEXT) return { ok: false, reason: 'unreadable' };
      return { ok: true, text: text.text };
    } finally {
      try {
        unlinkSync(dest);
      } catch {
        // файла может уже не быть — это не ошибка
      }
    }
  };
}

function describe(failure: ApiFailure): string {
  return `${failure.kind}: ${failure.message}`;
}

export async function runBot(opts: RunBotOptions): Promise<void> {
  const { api, store, deps, log } = opts;
  const sleep = opts.sleep ?? wait;
  const stopRequested = opts.stopRequested ?? ((): boolean => false);

  const webhook = await api.getWebhookInfo();
  if (webhook.ok && webhook.value.url !== '') {
    log(`у бота стоит вебхук (${webhook.value.url}) — long polling работать не будет. `
      + 'Сними его у @BotFather или удали вебхук сам, я настройки бота не меняю');
    return;
  }
  if (!webhook.ok && webhook.failure.kind === 'auth') {
    log(`токен отвергнут (${webhook.failure.message}) — проверь TG_BOT_TOKEN в .env`);
    process.exitCode = 1;
    return;
  }

  let offset = Number(store.kvGet('offset') ?? 0);
  let backoff = BACKOFF_START_MS;
  let idleRounds = 0;
  let lastLoggedAt = 0;

  const logThrottled = (line: string): void => {
    const now = Date.now();
    if (now - lastLoggedAt < LOG_QUIET_MS) return;
    lastLoggedAt = now;
    log(line);
  };

  for (;;) {
    if (stopRequested()) {
      log('остановка по запросу — текущая пачка обработана');
      return;
    }

    const updates = await api.getUpdates(offset);
    if (!updates.ok) {
      const f = updates.failure;
      if (f.kind === 'auth') {
        log(`токен отвергнут (${f.message}) — проверь TG_BOT_TOKEN в .env`);
        process.exitCode = 1;
        return;
      }
      if (f.kind === 'conflict') {
        log('уже запущен другой экземпляр бота (или стоит вебхук) — второй getUpdates Telegram не разрешает');
        process.exitCode = 1;
        return;
      }
      // Сеть и 5xx: VPN перезапускают, не спрашивая бота. Попытки не
      // прекращаются, но лог не сыплется каждую секунду.
      const pause = f.kind === 'flood' ? (f.retryAfterMs ?? BACKOFF_START_MS) : backoff;
      logThrottled(`Telegram недоступен (${describe(f)}) — жду ${Math.round(pause / 1000)} с`);
      await sleep(pause);
      if (f.kind !== 'flood') backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      continue;
    }
    backoff = BACKOFF_START_MS;

    const batch = updates.value;
    if (batch.length === 0) {
      idleRounds += 1;
    } else {
      idleRounds = 0;
    }

    for (const update of batch) {
      offset = Math.max(offset, update.update_id + 1);
      const message = update.message;
      if (message === undefined) continue;
      if (opts.ownerChatId === null) {
        log(`chat_id этого собеседника: ${message.chat.id} — положи свой в .env как TG_OWNER_CHAT_ID`);
      }
      try {
        const actions = await handleMessage(message, deps);
        for (const action of actions) await perform(action, opts);
      } catch (e) {
        // Одно плохое сообщение не должно ронять бота: рекрутёр получит
        // общий текст, владелец увидит причину в логе.
        log(`сообщение ${message.message_id} из чата ${message.chat.id}: ${e instanceof Error ? e.message : String(e)}`);
        await api.sendMessage(message.chat.id, TEXTS.modelFailure);
      }
    }
    // Оффсет пишется ПОСЛЕ обработки пачки: упали в середине — переобработаем
    // последнее сообщение, но не потеряем его.
    store.kvSet('offset', String(offset));

    await notifyMeetings(opts);

    if (opts.stopAfterIdleRounds !== undefined && idleRounds >= opts.stopAfterIdleRounds) return;
  }
}

async function perform(action: BotAction, opts: RunBotOptions): Promise<void> {
  const { api, store, log } = opts;
  if (action.kind === 'text') {
    const r = await api.sendMessage(action.chatId, action.text, { keyboard: action.keyboard === true });
    if (!r.ok) log(`не отправилось в чат ${action.chatId}: ${describe(r.failure)}`);
    return;
  }
  if (action.kind === 'owner') {
    if (opts.ownerChatId === null) {
      log(`пинг владельцу некуда слать (нет TG_OWNER_CHAT_ID):\n${action.text}`);
      return;
    }
    const r = await api.sendMessage(opts.ownerChatId, action.text);
    if (!r.ok) log(`пинг владельцу не ушёл: ${describe(r.failure)}`);
    return;
  }
  await sendCv(action.chatId, opts);
  void store;
}

/**
 * Резюме отправляется один раз файлом, дальше — по file_id, который Telegram
 * вернул. Ключ кеша содержит mtime PDF: обновил резюме — уйдёт новое.
 */
async function sendCv(chatId: number, opts: RunBotOptions): Promise<void> {
  const { api, store, log } = opts;
  const path = opts.resumePdf?.() ?? null;
  if (path === null || !existsSync(path)) {
    await api.sendMessage(chatId, TEXTS.cvMissing);
    return;
  }
  const key = `cv:${Math.round(statSync(path).mtimeMs)}`;
  const cached = store.kvGet(key);
  if (cached !== null) {
    const byId = await api.sendDocumentByFileId(chatId, cached, TEXTS.cvCaption);
    if (byId.ok) return;
    log(`file_id резюме не сработал (${describe(byId.failure)}) — шлю файлом`);
  }
  const sent = await api.sendDocumentByPath(chatId, path, basename(path), TEXTS.cvCaption);
  if (!sent.ok) {
    log(`резюме не отправилось: ${describe(sent.failure)}`);
    await api.sendMessage(chatId, TEXTS.cvMissing);
    return;
  }
  if (sent.value !== '') store.kvSet(key, sent.value);
}

/**
 * Пинги о собеседованиях. Запись сделана до отправки, поэтому сбой сети не
 * теряет договорённость: попытка повторится на следующем круге.
 */
async function notifyMeetings(opts: RunBotOptions): Promise<void> {
  const { api, store, deps, log } = opts;
  const pending = store.pendingMeetings();
  if (pending.length === 0) return;
  if (opts.ownerChatId === null) {
    log(`есть ${pending.length} записей о собеседовании, но слать некуда — задай TG_OWNER_CHAT_ID в .env`);
    return;
  }
  for (const m of pending) {
    const row = m.queueId === null ? null : deps.queue.listByStatus('pending').find((r) => r.id === m.queueId);
    const lines = [
      `Собеседование: ${m.raw}`,
      `Рекрутёр: ${m.username === null ? `id ${m.chatId}` : `@${m.username}`}`,
      m.queueId === null
        ? 'вакансию он не присылал'
        : `вакансия #${m.queueId}${row === undefined || row === null ? '' : ` — ${row.vacancy.title}`}`,
    ];
    const r = await api.sendMessage(opts.ownerChatId, lines.join('\n'));
    if (r.ok) store.markMeetingNotified(m.id, Date.now());
    else log(`пинг о собеседовании не ушёл: ${describe(r.failure)} — повторю`);
  }
}
