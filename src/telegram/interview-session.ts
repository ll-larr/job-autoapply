import { Api } from 'telegram';
import { NewMessage } from 'telegram/events/index.js';
import { openTelegram } from './gramjs.js';
import type { TgMessage } from './types.js';

/**
 * Один личный диалог одним объектом (спека 2026-09-25, 4). Существующий
 * TgReader тут не годится: он намеренно не отдаёт личные переписки, а
 * resolveChat знает только каналы и группы.
 *
 * Интерфейс узкий сознательно: цикл не должен уметь ничего, кроме как читать
 * историю одного собеседника, писать ему и показывать «печатает». Ни списка
 * чатов, ни рассылки, ни кнопок.
 */

/**
 * Сообщение личного диалога: TgMessage плюс то, что нужно циклу интервью,
 * чтобы отличить свой ответ от вопроса собеседника и не наступить на кнопки.
 */
export interface DialogMessage extends TgMessage {
  /** true — сообщение отправили мы (Api.Message.out). */
  out: boolean;
  /**
   * true — у сообщения настоящие кнопки: инлайн-клавиатура или обычная
   * клавиатура (Api.Message.replyMarkup). Снятие клавиатуры и «ответить» —
   * тоже replyMarkup, но кнопок в них нет, это обычный вопрос. Кнопки не
   * нажимаем никогда.
   */
  hasButtons: boolean;
}

export interface TgDialog {
  /** Сообщения новее minId, от старых к новым. */
  history(minId: number): Promise<DialogMessage[]>;
  send(text: string): Promise<void>;
  setTyping(): Promise<void>;
  /** Подписка на входящие. Возвращает функцию отписки. */
  onMessage(cb: (m: DialogMessage) => void): () => void;
  close(): Promise<void>;
}

function toDialogMessage(m: Api.Message): DialogMessage {
  return {
    id: m.id,
    date: new Date(m.date * 1000),
    text: m.message ?? '',
    urls: [],
    out: m.out === true,
    hasButtons: m.replyMarkup instanceof Api.ReplyInlineMarkup || m.replyMarkup instanceof Api.ReplyKeyboardMarkup,
  };
}

/**
 * Сырая история от client.getMessages вперемешку с Api.MessageService
 * (закреп, звонок, скриншот — текста нет) и Api.MessageEmpty (сообщение
 * удалили — даже даты нет). Отвечать там нечему, поэтому отбрасываем и их,
 * и Api.Message без текста (медиа без подписи — ответчику тоже нечего
 * сказать). Сиблинг TgReader делает то же самое (gramjs.ts, messages()).
 */
export function toDialogMessages(items: unknown[]): DialogMessage[] {
  const out: DialogMessage[] = [];
  for (const item of items) {
    if (!(item instanceof Api.Message)) continue;
    if (typeof item.message !== 'string' || item.message === '') continue;
    out.push(toDialogMessage(item));
  }
  return out;
}

/**
 * Причина, по которой диалог не открылся, для журнала (G1). Общая подсказка
 * openTelegram — «npm run tg:login» без аргументов, то есть вход в рабочую
 * сессию; последовав ей, владелец перезаписал бы рабочий аккаунт личным.
 * Для сессии интервью подсказка называет её файл.
 */
export function openFailureReason(
  failure: { reason: 'no_keys' | 'no_session' | 'no_proxy' | 'auth'; message: string },
  sessionPath: string | undefined,
): string {
  if (sessionPath === undefined || (failure.reason !== 'auth' && failure.reason !== 'no_session')) return failure.message;
  return `${failure.message} (это сессия личного аккаунта: npm run tg:login -- --session ${sessionPath})`;
}

/**
 * `sessionPath` — сессия личного аккаунта владельца (G1): ГигаРекрутёр пишет
 * туда, а не в рабочий аккаунт `data/telegram.session`.
 */
export async function openDialog(
  username: string,
  opts: { sessionPath?: string } = {},
): Promise<{ ok: true; dialog: TgDialog } | { ok: false; reason: string }> {
  const opened = await openTelegram({ sessionPath: opts.sessionPath });
  if (!opened.ok) return { ok: false, reason: openFailureReason(opened, opts.sessionPath) };
  const client = opened.client;
  let peer: Api.TypeInputPeer;
  try {
    peer = await client.getInputEntity(username);
  } catch (e) {
    // Клиент уже подключён и авторизован — не закрыть его здесь значит
    // держать сессию открытой без единого шанса её кем-то использовать.
    await opened.close().catch(() => {});
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `не удалось найти собеседника @${username}: ${message}` };
  }

  const dialog: TgDialog = {
    async history(minId: number) {
      const msgs = await client.getMessages(peer, { limit: 100, minId });
      return toDialogMessages(msgs).reverse();
    },
    async send(text: string) {
      // Текст уходит как есть: разбор Markdown по умолчанию превратил бы
      // `**`, `_` и `[x](url)` прошедшего валидацию ответа в разметку или
      // скрытую ссылку. Превью ссылок тоже ни к чему.
      await client.sendMessage(peer, { message: text, parseMode: false, linkPreview: false });
    },
    async setTyping() {
      await client.invoke(new Api.messages.SetTyping({ peer, action: new Api.SendMessageTypingAction() }));
    },
    onMessage(cb) {
      const handler = (event: { message: Api.Message }): void => cb(toDialogMessage(event.message));
      client.addEventHandler(handler, new NewMessage({ fromUsers: [username], incoming: true }));
      return () => client.removeEventHandler(handler, new NewMessage({ fromUsers: [username], incoming: true }));
    },
    async close() {
      await opened.close();
    },
  };
  return { ok: true, dialog };
}

/**
 * Подмена для тестов: сети нет, всё в памяти. `now` — часы для дат новых
 * сообщений (своих и пришедших): стенд цикла подставляет свои фейковые часы,
 * иначе возраст сообщения мерился бы по настоящему времени.
 */
export function fakeDialog(
  seed: DialogMessage[] = [],
  now: () => number = Date.now,
): TgDialog & { sent: string[]; push(text: string, opts?: { hasButtons?: boolean }): void } {
  const messages = [...seed];
  const sent: string[] = [];
  const subs = new Set<(m: DialogMessage) => void>();
  let nextId = Math.max(0, ...messages.map((m) => m.id)) + 1;

  return {
    sent,
    async history(minId: number) {
      return messages.filter((m) => m.id > minId).sort((a, b) => a.id - b.id);
    },
    async send(text: string) {
      sent.push(text);
      // Как настоящий Telegram: своё сообщение тоже ложится в историю, иначе
      // цикл не отличит свой ответ от вопроса собеседника.
      messages.push({ id: nextId++, date: new Date(now()), text, urls: [], out: true, hasButtons: false });
    },
    async setTyping() {},
    onMessage(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    push(text: string, opts?: { hasButtons?: boolean }) {
      const m: DialogMessage = {
        id: nextId++,
        date: new Date(now()),
        text,
        urls: [],
        out: false,
        hasButtons: opts?.hasButtons ?? false,
      };
      messages.push(m);
      for (const cb of subs) cb(m);
    },
    async close() {},
  };
}
