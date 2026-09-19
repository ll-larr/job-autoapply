/**
 * Telegram глазами остального кода (спека 2026-09-18, 4.3). Две узкие обёртки
 * вместо GramJS-клиента целиком:
 *
 * - TgReader — только чтение. Его получает поиск, и поэтому поиск не может
 *   ничего отправить даже по ошибке: методов отправки у него нет.
 * - TgSender — отправка. Его получает только TelegramAdapter.apply(), а тот
 *   вызывается только из Sender, то есть после одобрения (или автоотклика).
 *
 * Обе подменяются в тестах; сети в тестах нет. Настоящие — src/telegram/gramjs.ts.
 */

export interface TgChat {
  /** Id чата так, как его отдаёт GramJS (у каналов и супергрупп — с префиксом -100). */
  id: string;
  title: string;
  /** Публичное имя без @; null у закрытых чатов. */
  username: string | null;
  kind: 'channel' | 'group';
}

export interface TgMessage {
  id: number;
  date: Date;
  /** Текст поста как есть: ссылки, спрятанные за словами, в нём не видны — они в urls. */
  text: string;
  /** Адреса всех ссылок поста: и видимых текстом, и спрятанных за словами. */
  urls: string[];
}

export interface TgPeer {
  kind: 'user' | 'bot' | 'channel' | 'group';
  username: string;
}

export interface TgReader {
  /** Каналы и группы аккаунта — для выбора в настройках. Личные переписки не отдаются. */
  dialogs(): Promise<TgChat[]>;
  /** Чат по @имени или ссылке t.me. */
  resolveChat(ref: string): Promise<TgChat>;
  /**
   * Сообщения новее minId и не старше since, от новых к старым, не больше
   * limit. Прочитанными не помечаются.
   */
  messages(chat: TgChat, opts: { minId: number; since: Date; limit: number }): Promise<TgMessage[]>;
}

export interface TgSender {
  resolvePeer(username: string): Promise<TgPeer>;
  sendText(username: string, text: string): Promise<void>;
  sendFile(username: string, path: string): Promise<void>;
}
