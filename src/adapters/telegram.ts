import type { Adapter, ApplyResult, SearchFilters } from './types.js';
import type { Vacancy } from '../core/vacancy.js';
import type { Queue } from '../core/queue.js';
import type { TgChatSetting } from '../core/settings.js';
import type { TgReader } from '../telegram/types.js';
import { postToVacancy } from '../telegram/parse.js';
import { classifyTgError, describeTgFailure } from '../telegram/errors.js';

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

  async apply(): Promise<ApplyResult> {
    return { status: 'failed', reason: 'отправка в Telegram ещё не подключена' };
  }
}
