/** Подмножество Bot API, которое бот действительно читает. Остальные поля игнорируются. */
export interface TgBotDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgBotMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  from?: { id: number; username?: string; is_bot: boolean };
  text?: string;
  caption?: string;
  document?: TgBotDocument;
  /** Любое из этих полей означает «прислали не текст». */
  photo?: unknown;
  voice?: unknown;
  video?: unknown;
  sticker?: unknown;
  audio?: unknown;
}

export interface TgBotUpdate {
  update_id: number;
  message?: TgBotMessage;
}
