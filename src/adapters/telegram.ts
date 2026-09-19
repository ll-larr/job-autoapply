import type { Adapter, ApplyContext, ApplyResult, SearchFilters } from './types.js';
import type { Vacancy } from '../core/vacancy.js';
import type { Queue } from '../core/queue.js';
import type { TgChatSetting } from '../core/settings.js';
import type { TgReader, TgSender } from '../telegram/types.js';
import { postToVacancy } from '../telegram/parse.js';
import { classifyTgError, describeTgFailure, type TgFailure } from '../telegram/errors.js';

/** Не больше сообщений с одного чата за прогон (спека 4.5): шумная группа не должна съесть прогон. */
export const MAX_MESSAGES_PER_CHAT = 1000;
/** FloodWait до этого — ждём и повторяем один раз; дольше — чат пропускается. */
export const MAX_FLOOD_WAIT_S = 60;

export interface TelegramSearchStats {
  read: number;
  notVacancy: number;
  noContact: number;
  skippedChats: Array<{ title: string; why: string }>;
}

export interface TelegramAdapterOptions {
  /** Ленивый: Telegram поднимается только когда до него дошёл поиск. Ошибка — с причиной для человека. */
  reader: () => Promise<TgReader | { error: string }>;
  queue: Pick<Queue, 'getTgCursor' | 'setTgCursor'>;
  chats: () => TgChatSetting[];
  firstReadDays: () => number;
  /** Слова заголовка всех включённых специальностей — для строки заголовка поста. */
  titleWords: () => string[];
  /**
   * Отправка — отдельно от чтения (спека 4.3): поиск получает только reader.
   * Без sender apply отвечает auth_required, и строки остаются approved.
   */
  sender?: () => Promise<TgSender | { error: string }>;
  /** PDF резюме специальности по её id; null — у специальности его нет. */
  resumePdf?: (specialtyId: string) => string | null;
  /** Закрыть сессию Telegram, если она поднималась (панель зовёт close у адаптеров при выходе). */
  close?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export class TelegramAdapter implements Adapter {
  readonly name = 'tg';
  readonly queryless = true;
  lastSearchStats: TelegramSearchStats | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly opts: TelegramAdapterOptions) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  async search(filters: SearchFilters): Promise<Vacancy[]> {
    const stats: TelegramSearchStats = { read: 0, notVacancy: 0, noContact: 0, skippedChats: [] };
    this.lastSearchStats = stats;
    if ((filters.skip ?? 0) > 0) return [];

    const chats = this.opts.chats().filter((c) => c.enabled);
    if (chats.length === 0) return [];
    const reader = await this.opts.reader();
    if ('error' in reader) throw new Error(reader.error);

    const since = new Date(this.now() - this.opts.firstReadDays() * 86_400_000);
    const words = this.opts.titleWords();
    const out: Vacancy[] = [];

    for (const [i, chat] of chats.entries()) {
      // Пауза между чатами: чтение подряд десятка чатов без передышки —
      // ровно тот рисунок, на который Telegram отвечает FloodWait.
      if (i > 0) await this.sleep(1000 + Math.floor(this.random() * 1001));
      const messages = await this.readChat(reader, chat, since, stats);
      if (messages === null) continue;
      let maxId = this.opts.queue.getTgCursor(chat.id);
      for (const m of messages) {
        stats.read++;
        maxId = Math.max(maxId, m.id);
        const verdict = postToVacancy(chat, m, words);
        if (verdict.ok) out.push(verdict.vacancy);
        else if (verdict.reason === 'not_vacancy') stats.notVacancy++;
        else stats.noContact++;
      }
      this.opts.queue.setTgCursor(chat.id, maxId);
    }
    return out;
  }

  private async readChat(
    reader: TgReader, chat: TgChatSetting, since: Date, stats: TelegramSearchStats,
  ) {
    const minId = this.opts.queue.getTgCursor(chat.id);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await reader.messages(chat, { minId, since, limit: MAX_MESSAGES_PER_CHAT });
      } catch (e) {
        const f = classifyTgError(e);
        if (f.kind === 'flood_wait' && f.seconds <= MAX_FLOOD_WAIT_S && attempt === 0) {
          await this.sleep(f.seconds * 1000);
          continue;
        }
        // Сессия протухла — это не про чат, а про весь Telegram: пусть
        // конвейер запишет причину и перестанет ходить сюда в этом прогоне.
        if (f.kind === 'auth') throw new Error(describeTgFailure(f));
        stats.skippedChats.push({ title: chat.title, why: describeTgFailure(f) });
        return null;
      }
    }
    return null;
  }

  /**
   * Первое сообщение рекрутёру и PDF резюме специальности (спека 5.3).
   * Вызывается только из Sender, то есть после одобрения — человеком или
   * автооткликом. Отправка необратима: у рекрутёра всплывает уведомление, и
   * удалённое сообщение он уже видел.
   */
  async apply(vacancy: Vacancy, letter: string, ctx?: ApplyContext): Promise<ApplyResult> {
    if (vacancy.contact === null) return { status: 'failed', reason: 'у вакансии нет контакта — напиши вручную' };
    const sender = this.opts.sender === undefined
      ? { error: 'отправка в Telegram не подключена' }
      : await this.opts.sender();
    // Не подключён Telegram — не вина вакансии: строка остаётся approved,
    // площадка останавливается, как при разлогиненном hh.
    if ('error' in sender) return { status: 'auth_required' };

    const username = vacancy.contact;

    const peer = await this.attempt(() => sender.resolvePeer(username));
    if (!peer.ok) return failureResult(peer.failure);
    if (peer.value.kind !== 'user') {
      const what = peer.value.kind === 'bot' ? 'бот' : 'канал или группа';
      return { status: 'failed', reason: `@${username} — ${what}, а не человек — напиши вручную` };
    }

    const sent = await this.attempt(() => sender.sendText(username, letter));
    if (!sent.ok) return failureResult(sent.failure);

    // Текст уже у рекрутёра: что бы ни случилось с файлом, это «отправлено».
    // failed здесь был бы неправдой, а повторная отправка — вторым сообщением.
    const pdf = ctx === undefined ? null : (this.opts.resumePdf?.(ctx.specialty) ?? null);
    if (pdf === null) return { status: 'sent', warning: 'у специальности нет PDF резюме — ушёл только текст' };
    const file = await this.attempt(() => sender.sendFile(username, pdf));
    if (!file.ok) return { status: 'sent', warning: `резюме не приложилось: ${describeTgFailure(file.failure)}` };
    return { status: 'sent' };
  }

  async close(): Promise<void> {
    await this.opts.close?.();
  }

  /** Вызов с одним повтором после короткого FloodWait; любой сбой — TgFailure, а не исключение. */
  private async attempt<T>(f: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; failure: TgFailure }> {
    for (let i = 0; ; i++) {
      try {
        return { ok: true, value: await f() };
      } catch (e) {
        const failure = classifyTgError(e);
        if (failure.kind === 'flood_wait' && failure.seconds <= MAX_FLOOD_WAIT_S && i === 0) {
          await this.sleep(failure.seconds * 1000);
          continue;
        }
        return { ok: false, failure };
      }
    }
  }
}

function failureResult(f: TgFailure): ApplyResult {
  // PEER_FLOOD и долгий FloodWait — ограничение аккаунта: дальше слать нельзя
  // никому, Telegram-подача встаёт (спека 5.3).
  if (f.kind === 'peer_flood' || f.kind === 'flood_wait') return { status: 'account_limited' };
  if (f.kind === 'auth') return { status: 'auth_required' };
  return { status: 'failed', reason: describeTgFailure(f) };
}
