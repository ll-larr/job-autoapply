/** Подмножество Bot API, которое бот действительно читает. Остальные поля игнорируются. */
export interface TgBotDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgBotUser {
  id: number;
  is_bot: boolean;
  username?: string;
}

export interface TgBotMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string; username?: string };
  from?: TgBotUser;
  text?: string;
  caption?: string;
  document?: TgBotDocument;
  /** Любое из этих полей означает «прислали не текст». */
  photo?: unknown;
  voice?: unknown;
  video?: unknown;
  sticker?: unknown;
  audio?: unknown;
  /** Секретарь (Secretary Mode): сообщение из чата подключённого аккаунта, а не из чата с ботом. */
  business_connection_id?: string;
  /** Сообщение отправлено ботом от имени аккаунта (в том числе нашим). */
  sender_business_bot?: TgBotUser;
  /** Есть у отредактированных сообщений. */
  edit_date?: number;
}

/** Права бота в подключённом аккаунте (Bot API 9: BusinessBotRights). Нужно одно — can_reply. */
export interface TgBusinessBotRights {
  can_reply?: boolean;
  can_read_messages?: boolean;
}

export interface TgBusinessConnection {
  id: string;
  /** Владелец аккаунта: его сообщения не повод отвечать. */
  user: TgBotUser;
  user_chat_id: number;
  date: number;
  /** Bot API 9. В старых ответах вместо него было поле can_reply на верхнем уровне. */
  rights?: TgBusinessBotRights;
  can_reply?: boolean;
  is_enabled: boolean;
}

export interface TgBotUpdate {
  update_id: number;
  message?: TgBotMessage;
  business_connection?: TgBusinessConnection;
  business_message?: TgBotMessage;
  edited_business_message?: TgBotMessage;
}
