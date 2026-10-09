import type { BotApi, ApiFailure } from './api.js';
import type { BotStore, StoredConnection } from './state.js';
import { businessKey } from './state.js';
import type { BotAction } from './handlers.js';
import type { TgBotMessage, TgBusinessConnection } from './types.js';
import {
  handleSecretary, type DialogRef, type SecretaryDeps, type SecretaryInput, type SecretaryOutcome, type SilenceReason,
} from './secretary.js';

/**
 * Транспорт секретаря (спека 2026-10-09, 6.1–6.2): что делать с каждым
 * секретарским апдейтом до того, как мозг (secretary.ts) увидит текст. Здесь
 * живут фильтры («это сообщение самого аккаунта», «окно 24 часа закрыто»),
 * пачки сообщений, повторы отправки и антипетля по отметкам bot_seen.
 *
 * В лог идут ключи чатов, @username и исходы — никаких текстов рекрутёров.
 */

/** Отправка одного действия. Возвращает отказ Telegram или null, когда ушло. */
export type PerformFn = (action: BotAction) => Promise<ApiFailure | null>;

export interface SecretaryRuntimeOptions {
  api: BotApi;
  store: BotStore;
  deps: SecretaryDeps;
  perform: PerformFn;
  log: (line: string) => void;
  now?: () => number;
  /** Пауза перед повтором после FloodWait; в тестах — мгновенная. */
  sleep?: (ms: number) => Promise<void>;
}

interface Pack {
  conn: StoredConnection;
  peer: number;
  username: string | null;
  messages: TgBotMessage[];
  firstAt: number;
  lastAt: number;
}

interface Retry {
  due: number;
  key: number;
  ref: DialogRef;
  actions: BotAction[];
  attempt: number;
  connectionId: string;
}

const RETRY_EVERY_MS = 30_000;
const RETRY_MAX = 3;
const FLOOD_MAX_WAIT_MS = 10_000;
const REFRESH_EVERY_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

export class SecretaryRuntime {
  private readonly connections = new Map<string, StoredConnection>();
  private readonly packs = new Map<number, Pack>();
  private readonly retries: Retry[] = [];
  private readonly warnedOnce = new Set<string>();
  private readonly lastRefresh = new Map<string, number>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: SecretaryRuntimeOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private get cfg() {
    return this.opts.deps.secretary;
  }

  /** Username аккаунта, к которому подключён бот (без @). */
  get account(): string {
    return this.cfg.account;
  }

  private warn(key: string, line: string): void {
    if (this.warnedOnce.has(key)) return;
    this.warnedOnce.add(key);
    this.opts.log(line);
  }

  // --- соединения ---

  private toStored(c: TgBusinessConnection): StoredConnection {
    return {
      id: c.id,
      userId: c.user.id,
      username: c.user.username?.toLowerCase() ?? null,
      userChatId: c.user_chat_id,
      // Bot API 9 кладёт право в rights.can_reply; в более ранних ответах оно лежало на верхнем уровне.
      canReply: c.rights?.can_reply ?? c.can_reply ?? false,
      isEnabled: c.is_enabled,
      updatedAt: this.now(),
    };
  }

  /** Апдейт business_connection: подключили, изменили права, отключили. */
  onConnection(c: TgBusinessConnection): void {
    const stored = this.toStored(c);
    this.opts.store.upsertConnection(stored);
    this.connections.set(stored.id, stored);
    this.opts.log(`секретарь: соединение с @${stored.username ?? '?'} — ${stored.isEnabled ? 'включено' : 'выключено'}, `
      + `${stored.canReply ? 'отвечать можно' : 'отвечать нельзя'}`);
  }

  /** Кеш процесса → bot_connections → getBusinessConnection. */
  private async connection(id: string): Promise<StoredConnection | null> {
    const cached = this.connections.get(id);
    if (cached !== undefined) return cached;
    const saved = this.opts.store.connection(id);
    if (saved !== null) {
      this.connections.set(id, saved);
      return saved;
    }
    const fetched = await this.opts.api.getBusinessConnection(id);
    if (!fetched.ok) {
      this.warn(`conn:${id}`, `секретарь: соединение ${id} не прочиталось: ${fetched.failure.kind}: ${fetched.failure.message}`);
      return null;
    }
    const stored = this.toStored(fetched.value);
    this.opts.store.upsertConnection(stored);
    this.connections.set(id, stored);
    return stored;
  }

  /** После отказа Telegram права могли измениться: перечитываем соединение, но не чаще раза в 10 минут. */
  private async refreshConnection(id: string): Promise<void> {
    const last = this.lastRefresh.get(id) ?? 0;
    if (this.now() - last < REFRESH_EVERY_MS) return;
    this.lastRefresh.set(id, this.now());
    const fetched = await this.opts.api.getBusinessConnection(id);
    if (!fetched.ok) return;
    const stored = this.toStored(fetched.value);
    this.opts.store.upsertConnection(stored);
    this.connections.set(id, stored);
  }

  // --- входящие ---

  async onMessage(m: TgBotMessage, kind: 'new' | 'edit'): Promise<void> {
    const { store, deps } = this.opts;
    const connId = m.business_connection_id;
    if (connId === undefined) return;
    const conn = await this.connection(connId);
    if (conn === null) return;
    if (conn.username !== this.cfg.account.toLowerCase()) {
      // Чужой аккаунт: бот, подключённый не к тому, не должен отвечать чужим знакомым (решение 2).
      this.warn(`foreign:${connId}`, `секретарь: соединение ${connId} принадлежит @${conn.username ?? '?'}, а не @${this.cfg.account} — игнорирую`);
      return;
    }
    if (!conn.isEnabled) return;
    if (m.chat.type !== 'private' || m.chat.id <= 0) return;

    const peer = m.chat.id;
    const key = businessKey(peer);
    const username = m.chat.username?.toLowerCase() ?? m.from?.username?.toLowerCase() ?? null;
    const ref: DialogRef = { channel: 'business', peerKey: String(peer), username };
    const at = m.date * 1000;

    // Сообщение самого аккаунта: ручное сообщение владельца, наше первое
    // сообщение с GramJS-сессии или ответ этого же бота. Ответа не вызывает никогда.
    if (m.from?.id === conn.userId) {
      deps.dialogs?.outgoing(ref, at);
      const text = m.text ?? m.caption ?? '';
      if (m.sender_business_bot === undefined && text.trim() !== '') {
        const sent = username === null ? null : deps.queue.lastSentRowTo(username);
        const ours = sent !== null && sent.letter.trim() !== ''
          && text.trim().startsWith(sent.letter.trim().slice(0, 60));
        deps.memory.add(key, { who: ours ? 'agent' : 'owner', text, at });
      }
      return;
    }
    if (m.from?.is_bot === true) return;

    const seen = store.seen(key, m.message_id);
    if (kind === 'edit') {
      if (seen === null) {
        // Правка сообщения, которое мы не видели, — обычное сообщение.
      } else if (seen.outcome === 'meeting') {
        await this.handlePack(key, ref, conn, { edit: { messageId: m.message_id, meetingId: seen.meetingId }, messages: [m] });
        return;
      } else {
        return;
      }
    } else if (seen !== null) {
      return; // повторная доставка апдейта
    }

    if (this.now() - at > this.cfg.replyWindowHours * 3_600_000) {
      store.markSeen(key, [m.message_id], 'silent', null, this.now());
      deps.dialogs?.silenced(ref, 'window', this.now());
      return;
    }
    if (!conn.canReply) {
      store.markSeen(key, [m.message_id], 'silent', null, this.now());
      deps.dialogs?.silenced(ref, 'rights', this.now());
      this.warn(`rights:${connId}:${Math.floor(this.now() / DAY_MS)}`, 'секретарь: у бота нет права отвечать в этом соединении — дайте право «отвечать на сообщения» в настройках Telegram');
      return;
    }

    deps.dialogs?.incoming(ref, at, username === null ? null : deps.queue.lastSentRowTo(username)?.id ?? null);

    const pack = this.packs.get(key);
    if (pack === undefined) {
      this.packs.set(key, { conn, peer, username, messages: [m], firstAt: this.now(), lastAt: this.now() });
    } else {
      pack.messages.push(m);
      pack.lastAt = this.now();
    }
  }

  // --- пачки ---

  hasPending(): boolean {
    return this.packs.size > 0 || this.retries.length > 0;
  }

  /** Сколько секунд long polling может ждать апдейтов, не задерживая ответ: 30, если делать нечего. */
  nextWaitS(): number {
    if (!this.hasPending()) return 30;
    let due = Number.POSITIVE_INFINITY;
    for (const p of this.packs.values()) {
      due = Math.min(due, p.lastAt + this.cfg.debounceMs, p.firstAt + this.cfg.maxDebounceMs);
    }
    for (const r of this.retries) due = Math.min(due, r.due);
    return Math.max(1, Math.ceil((due - this.now()) / 1000));
  }

  /** Отдаёт мозгу готовые пачки и повторяет неудавшиеся отправки. force — при остановке бота. */
  async flushDue(force = false): Promise<void> {
    const now = this.now();
    for (const [key, p] of [...this.packs]) {
      const ready = force || now - p.lastAt >= this.cfg.debounceMs || now - p.firstAt >= this.cfg.maxDebounceMs;
      if (!ready) continue;
      this.packs.delete(key);
      const ref: DialogRef = { channel: 'business', peerKey: String(p.peer), username: p.username };
      await this.handlePack(key, ref, p.conn, { edit: null, messages: p.messages });
    }
    for (const r of [...this.retries]) {
      if (!force && r.due > this.now()) continue;
      this.retries.splice(this.retries.indexOf(r), 1);
      await this.sendActions(r.key, r.ref, r.connectionId, r.actions, r.attempt);
    }
  }

  private buildInput(
    key: number, conn: StoredConnection, ref: DialogRef,
    pack: { edit: SecretaryInput['edit']; messages: TgBotMessage[] },
  ): SecretaryInput {
    const messages = [...pack.messages].sort((a, b) => a.message_id - b.message_id);
    const text = messages.map((m) => m.text ?? m.caption ?? '').filter((t) => t.trim() !== '').join('\n').slice(0, 6000);
    const document = messages.find((m) => m.document !== undefined)?.document ?? null;
    const last = messages[messages.length - 1]!;
    return {
      channel: 'business',
      chatKey: key,
      peerChatId: Number(ref.peerKey),
      connectionId: conn.id,
      username: ref.username,
      messageIds: messages.map((m) => m.message_id),
      text,
      document,
      nonTextOnly: text === '' && document === null,
      at: last.date * 1000,
      edit: pack.edit,
    };
  }

  private async handlePack(
    key: number, ref: DialogRef, conn: StoredConnection,
    pack: { edit: SecretaryInput['edit']; messages: TgBotMessage[] },
  ): Promise<void> {
    const { store, deps, log, api } = this.opts;
    const input = this.buildInput(key, conn, ref, pack);
    // «печатает…» привязано к чату пачки.
    const scoped: SecretaryDeps = {
      ...deps,
      typing: async () => { await api.sendChatAction(input.peerChatId, 'typing', conn.id); },
    };
    let outcome: SecretaryOutcome;
    try {
      outcome = await handleSecretary(input, scoped);
    } catch (e) {
      // Одно плохое сообщение не должно ронять бота; рекрутёру — ничего, общий текст в личку не уходит никогда.
      store.markSeen(key, input.messageIds, 'silent', null, this.now());
      log(`секретарь ${key} @${ref.username ?? '?'}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (input.edit === null && input.text.trim() !== '') {
      deps.memory.add(key, { who: 'recruiter', text: input.text, at: input.at });
    }
    // Отметка ДО отправки: лучше не ответить, чем ответить дважды.
    store.markSeen(key, input.messageIds, outcome.outcome, outcome.meetingId, this.now());
    if (outcome.silenced !== null) deps.dialogs?.silenced(ref, outcome.silenced, this.now());
    log(`секретарь ${key} @${ref.username ?? '?'}: ${outcome.intent}${outcome.silenced === null ? '' : ` (молчу: ${outcome.silenced})`}`);
    if (outcome.actions.length > 0) await this.sendActions(key, ref, conn.id, outcome.actions, 0);
  }

  // --- отправка ---

  private async sendActions(
    key: number, ref: DialogRef, connectionId: string, actions: BotAction[], attempt: number,
  ): Promise<void> {
    const { deps, log } = this.opts;
    for (const [i, action] of actions.entries()) {
      let failure = await this.opts.perform(action);
      if (failure !== null && failure.kind === 'flood' && (failure.retryAfterMs ?? Infinity) <= FLOOD_MAX_WAIT_MS) {
        await this.sleep(failure.retryAfterMs ?? 1000);
        failure = await this.opts.perform(action);
      }
      if (failure === null) {
        deps.memory.add(key, {
          who: 'agent', text: action.kind === 'text' ? action.text : '[резюме]', at: this.now(),
        });
        deps.memory.noteReply(key, this.now());
        deps.dialogs?.botReply(ref, this.now());
        continue;
      }
      if (failure.kind === 'business') {
        // Окно 24 часа закрыто, права отозваны или соединение выключено: штатное «ответить нельзя».
        deps.dialogs?.silenced(ref, 'cannot_reply' satisfies SilenceReason, this.now());
        log(`секретарь ${key}: Telegram не даёт ответить (${failure.message})`);
        await this.refreshConnection(connectionId);
        return;
      }
      if (failure.kind === 'network' && attempt + 1 < RETRY_MAX) {
        this.retries.push({
          due: this.now() + RETRY_EVERY_MS, key, ref, connectionId, actions: actions.slice(i), attempt: attempt + 1,
        });
        log(`секретарь ${key}: сеть недоступна, повторю через ${RETRY_EVERY_MS / 1000} с`);
        return;
      }
      log(`секретарь ${key}: не отправилось — ${failure.kind}: ${failure.message}`);
      return;
    }
  }
}
