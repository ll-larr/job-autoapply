import { existsSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BotApi, ApiFailure } from './api.js';
import type { BotStore } from './state.js';
import { handleMessage, type BotAction, type HandlerDeps } from './handlers.js';
import { TEXTS, SECRETARY_TEXTS } from './texts.js';
import type { SecretaryRuntime } from './secretary-run.js';
import { meetingPing, reminderPing, type MeetingPing } from './ping.js';
import { meetingIcs } from './ics.js';
import type { CalendarSettings } from '../core/settings.js';
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
  /** Секретарь в личке подключённого аккаунта (спека 2026-10-09). Нет — бот работает только в своём чате. */
  secretary?: SecretaryRuntime;
  /**
   * Настройки календаря на момент вызова. Нет — пинги идут как раньше: без файла
   * .ics и без напоминаний (так работают прежние тесты и бот без календаря).
   */
  calendar?: () => CalendarSettings | null;
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

  if (opts.secretary !== undefined) {
    const me = await api.getMe();
    if (me.ok && me.value.can_connect_to_business !== true) {
      log('секретарь: у бота выключен Secretary Mode — включи его у @BotFather (Bot Settings → Business Mode)');
    }
    log(`секретарь включён для аккаунта @${opts.secretary.account}`);
    if (!store.hasConnectionOf(opts.secretary.account)) {
      log(`секретарь: подключения пока не видел — Telegram → Настройки → Telegram для бизнеса / Chat Automation → Чат-боты → этот бот. `
        + 'Если уже подключён, бот узнает о нём с первым сообщением.');
    }
  }

  let offset = Number(store.kvGet('offset') ?? 0);
  let backoff = BACKOFF_START_MS;
  let idleRounds = 0;
  let lastLoggedAt = 0;

  // Про незаданного владельца хватает одной строки за прогон: TG_OWNER_CHAT_ID
  // читается на старте, и до перезапуска ничего не изменится. Раньше это
  // предупреждение повторялось каждую минуту и заливало консоль.
  const warned = new Set<string>();
  const warnOnce = (line: string): void => {
    if (warned.has(line)) return;
    warned.add(line);
    log(line);
  };

  const logThrottled = (line: string): void => {
    const now = Date.now();
    if (now - lastLoggedAt < LOG_QUIET_MS) return;
    lastLoggedAt = now;
    log(line);
  };

  for (;;) {
    if (stopRequested()) {
      // Накопленные сообщения секретаря не выбрасываем: рекрутёр уже их написал.
      await opts.secretary?.flushDue(true);
      log('остановка по запросу — текущая пачка обработана');
      return;
    }

    // Секретарь держит long polling недолго, когда ждёт окончания пачки: ответ не должен засидеться.
    const updates = await api.getUpdates(offset, opts.secretary?.nextWaitS() ?? 30);
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
      if (update.business_connection !== undefined) {
        opts.secretary?.onConnection(update.business_connection);
        continue;
      }
      const business = update.business_message ?? update.edited_business_message;
      if (business !== undefined) {
        if (opts.secretary === undefined) {
          warnOnce('пришло сообщение секретаря, но секретарь выключен: добавь bot.secretary.account в config.json');
          continue;
        }
        try {
          await opts.secretary.onMessage(business, update.business_message !== undefined ? 'new' : 'edit');
        } catch (e) {
          log(`секретарь: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }
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

    try {
      await opts.secretary?.flushDue();
    } catch (e) {
      log(`секретарь: ${e instanceof Error ? e.message : String(e)}`);
    }
    await notifyMeetings(opts, warnOnce);
    await notifyReminders(opts);

    if (opts.stopAfterIdleRounds !== undefined && idleRounds >= opts.stopAfterIdleRounds) return;
  }
}

/**
 * Одно действие в Telegram. Отказ возвращается, а не только пишется в лог:
 * секретарь отличает «окно 24 часа закрыто» (штатно) от сбоя сети (повтор).
 * businessConnectionId — ответ уходит в чат подключённого аккаунта, без клавиатуры.
 */
export async function performAction(action: BotAction, opts: RunBotOptions): Promise<ApiFailure | null> {
  const business = action.businessConnectionId;
  if (action.kind === 'text') {
    const r = await opts.api.sendMessage(
      action.chatId, action.text,
      business === undefined ? { keyboard: action.keyboard === true } : { businessConnectionId: business },
    );
    return r.ok ? null : r.failure;
  }
  return sendCv(action.chatId, opts, business);
}

async function perform(action: BotAction, opts: RunBotOptions): Promise<void> {
  const failure = await performAction(action, opts);
  if (failure !== null) opts.log(`не отправилось в чат ${action.chatId}: ${describe(failure)}`);
}

/**
 * Резюме отправляется один раз файлом, дальше — по file_id, который Telegram
 * вернул. Ключ кеша содержит mtime PDF: обновил резюме — уйдёт новое.
 */
async function sendCv(chatId: number, opts: RunBotOptions, business?: string): Promise<ApiFailure | null> {
  const { api, store, log } = opts;
  const path = opts.resumePdf?.() ?? null;
  // В личке секретаря «напишите кандидату напрямую — @аккаунт» бессмысленно: рекрутёр уже в этом чате.
  const missing = business === undefined ? TEXTS.cvMissing(opts.deps.profile.telegram) : SECRETARY_TEXTS.cvMissing;
  const say = async (text: string): Promise<ApiFailure | null> => {
    const r = await api.sendMessage(chatId, text, business === undefined ? {} : { businessConnectionId: business });
    return r.ok ? null : r.failure;
  };
  if (path === null || !existsSync(path)) return say(missing);
  const key = `cv:${Math.round(statSync(path).mtimeMs)}`;
  const cached = store.kvGet(key);
  if (cached !== null) {
    const byId = await api.sendDocumentByFileId(chatId, cached, TEXTS.cvCaption, business);
    if (byId.ok) return null;
    if (byId.failure.kind === 'business') return byId.failure;
    log(`file_id резюме не сработал (${describe(byId.failure)}) — шлю файлом`);
  }
  const sent = await api.sendDocumentByPath(chatId, path, basename(path), TEXTS.cvCaption, business);
  if (!sent.ok) {
    if (sent.failure.kind === 'business') return sent.failure;
    log(`резюме не отправилось: ${describe(sent.failure)}`);
    return say(missing);
  }
  if (sent.value !== '') store.kvSet(key, sent.value);
  return null;
}

/**
 * Пинги о собеседованиях. Запись сделана до отправки, поэтому сбой сети не
 * теряет договорённость: попытка повторится на следующем круге.
 */
async function notifyMeetings(opts: RunBotOptions, warn: (line: string) => void): Promise<void> {
  const { api, store, deps, log } = opts;
  const pending = store.pendingMeetings();
  if (pending.length === 0) return;
  if (opts.ownerChatId === null) {
    // Через придушенный лог: круг цикла — это каждые полминуты, и без него
    // одна несделанная настройка заливает консоль одной и той же строкой.
    warn(`записей о собеседовании: ${pending.length}, но слать некуда — задай TG_OWNER_CHAT_ID в .env`);
    return;
  }
  for (const m of pending) {
    // Строка по номеру в любом статусе: к собеседованию вакансия часто уже skipped.
    const row = m.queueId === null ? null : deps.queue.byId(m.queueId);
    const previous = m.replacesId == null ? null : store.meetingById(m.replacesId);
    const ping = meetingPing(m, row, { account: opts.secretary?.account ?? null, previous });
    const cal = opts.calendar?.() ?? null;
    if (cal !== null && cal.icsInPing) {
      ping.ics = meetingIcs(m, row, {
        slotMinutes: cal.slotMinutes,
        remindMinutes: cal.remindEnabled ? cal.remindMinutes : null,
        account: opts.secretary?.account ?? null,
        now: deps.now().getTime(),
      });
    }
    const failure = await sendMeetingPing(api, opts.ownerChatId, ping, log);
    if (failure === null) store.markMeetingNotified(m.id, Date.now());
    else log(`пинг о собеседовании не ушёл: ${describe(failure)} — повторю`);
  }
}

/**
 * Напоминания о собеседованиях (спека 6.8). Если встречу записали меньше чем за
 * remindMinutes+10 минут до её начала, основной пинг пришёл только что, и
 * напоминание было бы вторым подряд: запись просто помечается. Не ушло —
 * повторяется на следующем круге, пока встреча не наступила.
 */
async function notifyReminders(opts: RunBotOptions): Promise<void> {
  const cal = opts.calendar?.() ?? null;
  if (cal === null || !cal.remindEnabled || opts.ownerChatId === null) return;
  const { api, store, deps, log } = opts;
  const now = deps.now().getTime();
  for (const m of store.dueReminders(now, cal.remindMinutes)) {
    if (m.meetAt - m.createdAt < (cal.remindMinutes + 10) * 60_000) {
      store.markReminded(m.id, m.createdAt);
      continue;
    }
    const row = m.queueId === null ? null : deps.queue.byId(m.queueId);
    const msg = await api.sendMessage(opts.ownerChatId, reminderPing(m, row, now, { account: opts.secretary?.account ?? null }));
    if (msg.ok) store.markReminded(m.id, now);
    else log(`напоминание о собеседовании не ушло: ${describe(msg.failure)} — повторю`);
  }
}

/**
 * Пинг уходит одним сообщением: документом с текстом вакансии, а сам пинг —
 * его подпись. Файл не загрузился — уходит обычное сообщение: договорённость
 * о собеседовании важнее вложения, и держать её из-за файла нельзя. Возвращает
 * отказ последней попытки; null — доставлено.
 */
async function sendMeetingPing(
  api: BotApi, chatId: number, ping: MeetingPing, log: (line: string) => void,
): Promise<ApiFailure | null> {
  // Вакансия и календарь приходят одним альбомом — одно уведомление. Не вышло —
  // прежний путь: договорённость важнее вложений.
  if (ping.ics != null && ping.file !== null) {
    const album = await api.sendDocumentsFromText(chatId, [ping.file, ping.ics], ping.text);
    if (album.ok) return null;
    log(`альбом с вакансией и .ics к пингу не ушёл: ${describe(album.failure)} — шлю по одному`);
  } else if (ping.ics != null) {
    const doc = await api.sendDocumentFromText(chatId, ping.ics.name, ping.ics.content, ping.text);
    if (doc.ok) return null;
    log(`.ics к пингу не ушёл: ${describe(doc.failure)} — шлю пинг без файла`);
    const msg = await api.sendMessage(chatId, ping.text);
    return msg.ok ? null : msg.failure;
  }
  if (ping.file !== null) {
    const doc = await api.sendDocumentFromText(chatId, ping.file.name, ping.file.content, ping.text);
    if (doc.ok) return null;
    log(`файл вакансии к пингу не ушёл: ${describe(doc.failure)} — шлю пинг без файла`);
  }
  const msg = await api.sendMessage(chatId, ping.text);
  return msg.ok ? null : msg.failure;
}
