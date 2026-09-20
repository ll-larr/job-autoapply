/**
 * Вход в Telegram — один раз, руками человека (спека 2026-09-18, 4.2).
 * Телефон, код из Telegram и пароль 2FA вводит он сам в своём терминале;
 * скрипт их никуда не пишет. Сохраняется только строка сессии в
 * data/telegram.session.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { TelegramClient, sessions } from 'telegram';
import { discoverSocksProxy } from '../src/core/proxy.js';
import { readTelegramKeys, writeSession, SESSION_PATH } from '../src/telegram/session.js';
import type { LogLevel } from 'telegram/extensions/Logger.js';

try { process.loadEnvFile('.env'); } catch { /* ключи могут быть в окружении */ }

const keys = readTelegramKeys();
if ('error' in keys) { console.error(keys.error); process.exit(1); }
const { found, checked } = await discoverSocksProxy();
if (found === null) { console.error(`VPN выключен — Telegram отсюда недоступен. Проверены: ${checked.join(', ')}`); process.exit(1); }

const rl = createInterface({ input: stdin, output: stdout });
const client = new TelegramClient(new sessions.StringSession(''), keys.apiId, keys.apiHash, {
  connectionRetries: 3,
  proxy: { ip: found.host, port: found.port, socksType: 5, timeout: 10 },
});
client.setLogLevel('error' as LogLevel);
await client.start({
  phoneNumber: () => rl.question('Телефон (+7…): '),
  phoneCode: () => rl.question('Код из Telegram: '),
  password: () => rl.question('Пароль 2FA (если нет — Enter): '),
  onError: (e) => { console.error(e.message); },
});
writeSession(String(client.session.save()), SESSION_PATH);
const me = await client.getMe();
console.log(`Готово: вошли как ${'username' in me && me.username ? '@' + me.username : 'аккаунт без username'}. Сессия — ${SESSION_PATH}.`);
console.log('Никому не пересылай этот файл: он даёт полный доступ к аккаунту. Отозвать — Telegram → Настройки → Устройства.');
rl.close();
await client.destroy();
