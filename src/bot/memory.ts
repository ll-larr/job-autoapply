/**
 * Оперативная память секретаря (спека 2026-10-09, 6.7 и 6.2). Живёт только в
 * процессе бота: на диск тексты не пишутся — действующее правило проекта «бот не
 * хранит тексты рекрутёров». Перезапуск бота забывает всё, и это нормально: ответ
 * без контекста хуже, чем с ним, но не опаснее.
 *
 * Две разные вещи под одной крышей:
 *  - реплики для промпта (последние N моложе TTL) — контекст ответа модели;
 *  - счётчики антипетли (ответы, приветствия, повтор текста) — они не должны
 *    зависеть от размера окна реплик, иначе «8 ответов в час» упёрлись бы в
 *    потолок памяти в 8 реплик.
 */

export interface Turn {
  who: 'recruiter' | 'agent' | 'owner';
  text: string;
  at: number;
}

export type SocialKind = 'greeting' | 'thanks' | 'bye';

/** Длиннее одна реплика в промпт не идёт. */
const TURN_MAX = 800;
/** Чатов в памяти не больше: бот висит сутками, а память не должна расти вместе с числом рекрутёров. */
const KEYS_MAX = 500;

export class ChatMemory {
  private readonly turns = new Map<number, Turn[]>();
  private readonly replies = new Map<number, number[]>();
  private readonly social = new Map<number, Map<SocialKind, number>>();
  private readonly incoming = new Map<number, { norm: string; at: number }>();

  constructor(private readonly opts: { turns: number; ttlMs: number }) {}

  /** Реплика в память. Пустой текст и нулевое окно — ничего не хранится. */
  add(key: number, turn: Turn): void {
    const text = turn.text.trim();
    if (this.opts.turns <= 0 || text === '') return;
    const list = this.turns.get(key) ?? [];
    list.push({ ...turn, text: text.length > TURN_MAX ? `${text.slice(0, TURN_MAX - 1)}…` : text });
    while (list.length > this.opts.turns) list.shift();
    this.turns.set(key, list);
    this.trim();
  }

  /** Последние реплики не старше TTL, от старых к новым. */
  recent(key: number, now: number): Turn[] {
    const list = this.turns.get(key);
    if (list === undefined) return [];
    const fresh = list.filter((t) => now - t.at <= this.opts.ttlMs);
    if (fresh.length !== list.length) {
      if (fresh.length === 0) this.turns.delete(key);
      else this.turns.set(key, fresh);
    }
    return fresh;
  }

  noteReply(key: number, at: number): void {
    const list = (this.replies.get(key) ?? []).filter((t) => at - t <= 86_400_000);
    list.push(at);
    this.replies.set(key, list);
    this.trim();
  }

  /** Сколько ответов секретаря в чате с момента `sinceMs`. */
  repliesSince(key: number, sinceMs: number): number {
    return (this.replies.get(key) ?? []).filter((t) => t >= sinceMs).length;
  }

  noteSocial(key: number, kind: SocialKind, at: number): void {
    const byKind = this.social.get(key) ?? new Map<SocialKind, number>();
    byKind.set(kind, at);
    this.social.set(key, byKind);
    this.trim();
  }

  /** Когда на этот вид социального сообщения отвечали в последний раз. */
  lastSocialAt(key: number, kind: SocialKind): number | null {
    return this.social.get(key)?.get(kind) ?? null;
  }

  /** Запоминает нормализованный текст пачки; возвращает прежний — для «тот же текст повторно». */
  swapIncoming(key: number, norm: string, at: number): { norm: string; at: number } | null {
    const previous = this.incoming.get(key) ?? null;
    this.incoming.set(key, { norm, at });
    this.trim();
    return previous;
  }

  private trim(): void {
    for (const map of [this.turns, this.replies, this.social, this.incoming] as Array<Map<number, unknown>>) {
      while (map.size > KEYS_MAX) {
        const oldest = map.keys().next();
        if (oldest.done === true) break;
        map.delete(oldest.value);
      }
    }
  }
}
