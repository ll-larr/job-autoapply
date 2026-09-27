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
 * историю одного собеседника, писать ему, показывать «печатает» и нажимать
 * инлайн-кнопку одного его сообщения — единственный разрешённый случай
 * нажатия, выбор вакансии (G2). Ни списка чатов, ни рассылки.
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
   * нажимаем, кроме выбора вакансии (G2).
   */
  hasButtons: boolean;
  /**
   * Тексты кнопок инлайн- или обычной клавиатуры по строкам слева направо
   * (G2); кнопок нет — пусто.
   */
  buttons: string[];
}

export interface TgDialog {
  /** Сообщения новее minId, от старых к новым. */
  history(minId: number): Promise<DialogMessage[]>;
  /**
   * Одно сообщение по id в его нынешнем виде (G2): бот правит подсказку выбора
   * вакансии на месте, и перед нажатием её надо перечитать. Нет такого — null.
   */
  getMessage(id: number): Promise<DialogMessage | null>;
  send(text: string): Promise<void>;
  setTyping(): Promise<void>;
  /**
   * Нажимает инлайн-кнопку с ровно этим текстом у сообщения `messageId` (G2).
   * false — такого сообщения или такой кнопки нет (или её нельзя нажать без
   * пароля или отправки текста): не нажато ничего.
   */
  pressButton(messageId: number, buttonText: string): Promise<boolean>;
  /** Подписка на входящие. Возвращает функцию отписки. */
  onMessage(cb: (m: DialogMessage) => void): () => void;
  close(): Promise<void>;
}

/** Тексты кнопок клавиатуры (G2). Снятие клавиатуры и «ответить» — не кнопки. */
function buttonTexts(markup: Api.TypeReplyMarkup | undefined): string[] {
  if (!(markup instanceof Api.ReplyInlineMarkup) && !(markup instanceof Api.ReplyKeyboardMarkup)) return [];
  return markup.rows.flatMap((row) => row.buttons.map((b) => b.text));
}

function toDialogMessage(m: Api.Message): DialogMessage {
  return {
    id: m.id,
    date: new Date(m.date * 1000),
    text: m.message ?? '',
    urls: [],
    out: m.out === true,
    hasButtons: m.replyMarkup instanceof Api.ReplyInlineMarkup || m.replyMarkup instanceof Api.ReplyKeyboardMarkup,
    buttons: buttonTexts(m.replyMarkup),
  };
}

/**
 * Инлайн-кнопка с данными и ровно этим текстом (G2). Только она и нажимается:
 * кнопка обычной клавиатуры отправила бы свой текст сообщением (а в чат уходит
 * только текст, прошедший валидатор), ссылка и прочее — не выбор, кнопке с
 * паролем (как у BotFather) не место в интервью.
 */
export function findCallbackButton(
  markup: Api.TypeReplyMarkup | undefined,
  text: string,
): Api.KeyboardButtonCallback | undefined {
  if (!(markup instanceof Api.ReplyInlineMarkup)) return undefined;
  for (const row of markup.rows) {
    for (const b of row.buttons) {
      if (b instanceof Api.KeyboardButtonCallback && b.text === text && b.requiresPassword !== true) return b;
    }
  }
  return undefined;
}

/**
 * Нажатие инлайн-кнопки — то же, что делает GramJS в MessageButton.click()
 * (node_modules/telegram/tl/custom/messageButton.js): messages.GetBotCallbackAnswer
 * с данными кнопки. BOT_RESPONSE_TIMEOUT значит, что бот нажатие получил, но
 * не ответил на него всплывашкой вовремя, — нажатие состоялось (GramJS тоже
 * его глотает).
 */
export async function pressCallback(
  invoke: (request: Api.messages.GetBotCallbackAnswer) => Promise<unknown>,
  peer: Api.TypeInputPeer,
  msgId: number,
  button: Api.KeyboardButtonCallback,
): Promise<boolean> {
  try {
    await invoke(new Api.messages.GetBotCallbackAnswer({ peer, msgId, data: button.data }));
  } catch (e) {
    if ((e as { errorMessage?: unknown }).errorMessage === 'BOT_RESPONSE_TIMEOUT') return true;
    throw e;
  }
  return true;
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
  sessionPath: string,
): string {
  if (failure.reason !== 'auth' && failure.reason !== 'no_session') return failure.message;
  return `${failure.message} (это сессия личного аккаунта: npm run tg:login -- --session ${sessionPath})`;
}

/**
 * `sessionPath` — сессия личного аккаунта владельца (G1): ГигаРекрутёр пишет
 * туда, а не в рабочий аккаунт `data/telegram.session`. Обязателен (M5): без
 * него openTelegram молча открыл бы рабочую сессию.
 */
export async function openDialog(
  username: string,
  opts: { sessionPath: string },
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
    async getMessage(id: number) {
      // getMessages с ids отбрасывает сообщения чужого чата (GramJS, _IDsIter):
      // по id достаётся только сообщение этого собеседника.
      const [m] = await client.getMessages(peer, { ids: [id] });
      return toDialogMessages([m])[0] ?? null;
    },
    async pressButton(messageId: number, buttonText: string) {
      // Кнопку берём из свежего сообщения, а не из того, что видел цикл: бот
      // мог его уже поправить. Нажимается только инлайн-кнопка с данными.
      const [m] = await client.getMessages(peer, { ids: [messageId] });
      const button = m instanceof Api.Message ? findCallbackButton(m.replyMarkup, buttonText) : undefined;
      if (button === undefined) return false;
      return pressCallback((request) => client.invoke(request), peer, messageId, button);
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

export interface FakeDialog extends TgDialog {
  sent: string[];
  /** Нажатия кнопок по порядку (G2). */
  presses: { messageId: number; button: string }[];
  /** Что бот делает в ответ на нажатие: тест подставляет свой сценарий. */
  onPress: ((messageId: number, button: string) => void) | null;
  /**
   * Входящее от собеседника; возвращает его id. `buttons` — тексты кнопок, с
   * ними hasButtons по умолчанию true.
   */
  push(text: string, opts?: { hasButtons?: boolean; buttons?: string[] }): number;
  /** Правка сообщения на месте, как делает бот: тот же id и дата (G2). */
  edit(id: number, patch: { text?: string; buttons?: string[] }): void;
}

/**
 * Подмена для тестов: сети нет, всё в памяти. `now` — часы для дат новых
 * сообщений (своих и пришедших): стенд цикла подставляет свои фейковые часы,
 * иначе возраст сообщения мерился бы по настоящему времени.
 */
export function fakeDialog(
  seed: DialogMessage[] = [],
  now: () => number = Date.now,
): FakeDialog {
  const messages = [...seed];
  const sent: string[] = [];
  const subs = new Set<(m: DialogMessage) => void>();
  let nextId = Math.max(0, ...messages.map((m) => m.id)) + 1;
  const find = (id: number): number => messages.findIndex((m) => m.id === id);

  const dialog: FakeDialog = {
    sent,
    presses: [],
    onPress: null,
    async history(minId: number) {
      return messages.filter((m) => m.id > minId).sort((a, b) => a.id - b.id);
    },
    async getMessage(id: number) {
      const m = messages[find(id)];
      return m === undefined ? null : { ...m, buttons: [...m.buttons] };
    },
    async send(text: string) {
      sent.push(text);
      // Как настоящий Telegram: своё сообщение тоже ложится в историю, иначе
      // цикл не отличит свой ответ от вопроса собеседника.
      messages.push({ id: nextId++, date: new Date(now()), text, urls: [], out: true, hasButtons: false, buttons: [] });
    },
    async setTyping() {},
    async pressButton(messageId: number, buttonText: string) {
      const m = messages[find(messageId)];
      if (m === undefined || m.out || !m.buttons.includes(buttonText)) return false;
      dialog.presses.push({ messageId, button: buttonText });
      dialog.onPress?.(messageId, buttonText);
      return true;
    },
    onMessage(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    push(text: string, opts?: { hasButtons?: boolean; buttons?: string[] }) {
      const buttons = opts?.buttons ?? [];
      const m: DialogMessage = {
        id: nextId++,
        date: new Date(now()),
        text,
        urls: [],
        out: false,
        hasButtons: opts?.hasButtons ?? buttons.length > 0,
        buttons,
      };
      messages.push(m);
      for (const cb of subs) cb(m);
      return m.id;
    },
    edit(id: number, patch: { text?: string; buttons?: string[] }) {
      const i = find(id);
      const m = messages[i];
      if (m === undefined) throw new Error(`fakeDialog.edit: нет сообщения ${id}`);
      // Новый объект, а не правка старого: уже прочитанная циклом история не меняется задним числом.
      messages[i] = {
        ...m,
        text: patch.text ?? m.text,
        ...(patch.buttons === undefined ? {} : { buttons: patch.buttons, hasButtons: patch.buttons.length > 0 }),
      };
    },
    async close() {},
  };
  return dialog;
}
