import { TelegramClient, Api, sessions } from 'telegram';
import type { Dialog } from 'telegram/tl/custom/dialog.js';
import type { LogLevel } from 'telegram/extensions/Logger.js';
import { discoverSocksProxy } from '../core/proxy.js';
import { classifyTgError, describeTgFailure } from './errors.js';
import { readSession, readTelegramKeys, SESSION_PATH } from './session.js';
import type { TgChat, TgMessage, TgPeer, TgReader, TgSender } from './types.js';

export type OpenResult =
  | { ok: true; reader: TgReader; sender: TgSender; close(): Promise<void> }
  | { ok: false; reason: 'no_keys' | 'no_session' | 'no_proxy' | 'auth'; message: string };

function chatOf(entity: Api.Channel | Api.Chat, id: string): TgChat {
  const username = 'username' in entity && typeof entity.username === 'string' ? entity.username : null;
  const kind = entity instanceof Api.Channel && entity.broadcast ? 'channel' : 'group';
  return { id, title: entity.title, username, kind };
}

/** Ссылки поста: и те, что видны текстом, и спрятанные за словами (MessageEntityTextUrl). */
function urlsOf(m: Api.Message): string[] {
  const urls: string[] = [];
  for (const e of m.entities ?? []) {
    if (e instanceof Api.MessageEntityTextUrl) urls.push(e.url);
    if (e instanceof Api.MessageEntityUrl) urls.push(m.message.slice(e.offset, e.offset + e.length));
  }
  return urls;
}

export async function openTelegram(opts: { sessionPath?: string } = {}): Promise<OpenResult> {
  const keys = readTelegramKeys();
  if ('error' in keys) return { ok: false, reason: 'no_keys', message: keys.error };
  const saved = readSession(opts.sessionPath ?? SESSION_PATH);
  if (saved === null) return { ok: false, reason: 'no_session', message: 'Telegram не подключён — войди: npm run tg:login' };
  const { found, checked } = await discoverSocksProxy();
  if (found === null) {
    return { ok: false, reason: 'no_proxy', message: `VPN выключен, Telegram пропущен (проверены: ${checked.join(', ')})` };
  }

  const client = new TelegramClient(new sessions.StringSession(saved), keys.apiId, keys.apiHash, {
    connectionRetries: 2,
    proxy: { ip: found.host, port: found.port, socksType: 5, timeout: 10 },
  });
  // Только ошибки: на уровне info GramJS печатает каждое переподключение.
  client.setLogLevel('error' as LogLevel);
  try {
    await client.connect();
    if (!(await client.checkAuthorization())) {
      await client.destroy();
      return { ok: false, reason: 'auth', message: describeTgFailure({ kind: 'auth' }) };
    }
  } catch (e) {
    await client.destroy().catch(() => {});
    const f = classifyTgError(e);
    return { ok: false, reason: f.kind === 'auth' ? 'auth' : 'no_proxy', message: describeTgFailure(f) };
  }

  // Сущности чатов по id. StringSession их не хранит, поэтому id из настроек
  // становятся пригодными для запросов только после getDialogs в этом
  // процессе: dialogs() заполняет карту, messages() ей пользуется.
  const entities = new Map<string, Api.Channel | Api.Chat>();

  const reader: TgReader = {
    async dialogs() {
      const out: TgChat[] = [];
      for (const d of (await client.getDialogs({})) as Dialog[]) {
        const e = d.entity;
        if (!(e instanceof Api.Channel) && !(e instanceof Api.Chat)) continue;
        const id = String(d.id);
        entities.set(id, e);
        out.push(chatOf(e, id));
      }
      return out;
    },
    async resolveChat(ref) {
      const username = ref.trim().replace(/^https?:\/\/(t|telegram)\.me\//, '').replace(/^@/, '').split(/[/?]/)[0]!;
      const e = await client.getEntity(username);
      if (!(e instanceof Api.Channel) && !(e instanceof Api.Chat)) throw new Error(`@${username} — не канал и не группа`);
      const id = String((await client.getPeerId(e)));
      entities.set(id, e);
      return chatOf(e, id);
    },
    async messages(chat, { minId, since, limit }) {
      if (!entities.has(chat.id)) await reader.dialogs();
      const e = entities.get(chat.id);
      if (e === undefined) throw new Error('chat_unavailable');
      const out: TgMessage[] = [];
      for await (const m of client.iterMessages(e, { limit, minId })) {
        if (!(m instanceof Api.Message)) continue;
        const date = new Date(m.date * 1000);
        if (date < since) break;
        if (typeof m.message !== 'string' || m.message === '') continue;
        out.push({ id: m.id, date, text: m.message, urls: urlsOf(m) });
      }
      return out;
    },
  };

  const sender: TgSender = {
    async resolvePeer(username) {
      const e = await client.getEntity(username);
      if (e instanceof Api.User) return { kind: e.bot ? 'bot' : 'user', username };
      if (e instanceof Api.Channel) return { kind: e.broadcast ? 'channel' : 'group', username };
      return { kind: 'group', username };
    },
    async sendText(username, text) {
      await client.sendMessage(username, { message: text, linkPreview: false });
    },
    async sendFile(username, path) {
      await client.sendFile(username, { file: path, forceDocument: true });
    },
  };

  return { ok: true, reader, sender, close: () => client.destroy() };
}
