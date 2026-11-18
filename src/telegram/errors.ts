import { errors } from 'telegram';

/**
 * Что случилось с запросом к Telegram — в тех словах, которыми с этим
 * поступают (спека 2026-09-18, 5.3). GramJS отдаёт RPCError с кодом в
 * errorMessage, FloodWaitError с секундами и обычные Error от своих проверок.
 */
export type TgFailure =
  | { kind: 'flood_wait'; seconds: number }
  /** Telegram ограничил первые сообщения незнакомым: Telegram-подача встаёт. */
  | { kind: 'peer_flood' }
  /** Входящие закрыты или человек заблокирован/заблокировал. Писать вручную. */
  | { kind: 'privacy' }
  | { kind: 'not_found' }
  /** Сессия протухла или отозвана: перелогиниться. */
  | { kind: 'auth' }
  /** Чат закрыт или нас из него удалили: чат пропускается. */
  | { kind: 'chat_unavailable' }
  | { kind: 'other'; message: string };

const BY_CODE: Readonly<Record<string, TgFailure['kind']>> = {
  PEER_FLOOD: 'peer_flood',
  USER_PRIVACY_RESTRICTED: 'privacy',
  USER_IS_BLOCKED: 'privacy',
  YOU_BLOCKED_USER: 'privacy',
  PRIVACY_PREMIUM_REQUIRED: 'privacy',
  USERNAME_NOT_OCCUPIED: 'not_found',
  USERNAME_INVALID: 'not_found',
  AUTH_KEY_UNREGISTERED: 'auth',
  AUTH_KEY_INVALID: 'auth',
  SESSION_REVOKED: 'auth',
  SESSION_EXPIRED: 'auth',
  USER_DEACTIVATED: 'auth',
  USER_DEACTIVATED_BAN: 'auth',
  CHANNEL_PRIVATE: 'chat_unavailable',
  CHAT_FORBIDDEN: 'chat_unavailable',
  CHANNEL_INVALID: 'chat_unavailable',
};

export function classifyTgError(e: unknown): TgFailure {
  if (e instanceof errors.FloodWaitError) return { kind: 'flood_wait', seconds: e.seconds };
  if (e instanceof errors.RPCError) {
    const kind = BY_CODE[e.errorMessage];
    if (kind !== undefined && kind !== 'flood_wait' && kind !== 'other') return { kind } as TgFailure;
    return { kind: 'other', message: e.errorMessage };
  }
  const message = e instanceof Error ? e.message : String(e);
  if (/No user has ".*" as username|Cannot find any entity/i.test(message)) return { kind: 'not_found' };
  return { kind: 'other', message };
}

export function describeTgFailure(f: TgFailure): string {
  switch (f.kind) {
    case 'flood_wait': return `Telegram просит подождать ${f.seconds} с`;
    case 'peer_flood': return 'Telegram ограничил первые сообщения незнакомым — Telegram-подача остановлена, остальные площадки продолжают';
    case 'privacy': return 'входящие у контакта закрыты — напиши вручную';
    case 'not_found': return 'контакт не найден — напиши вручную';
    case 'auth': return 'сессия Telegram протухла — перелогинься: npm run tg:login';
    case 'chat_unavailable': return 'чат недоступен (закрыт или тебя удалили)';
    case 'other': return f.message;
  }
}
