/**
 * Вход в Telegram — один раз, руками человека (спека 2026-09-18, 4.2).
 * Телефон, код из Telegram и пароль 2FA вводит он сам в своём терминале;
 * скрипт их никуда не пишет. Сохраняется только строка сессии: по умолчанию
 * в data/telegram.session (рабочий аккаунт), с `-- --session <путь>` — в
 * указанный файл, например data/telegram-interview.session для личного
 * аккаунта, куда пишет ГигаРекрутёр (G1). Живую рабочую сессию скрипт не
 * перезаписывает без `-- --force`, а флаг без «--» (его забирает npm) — отказ (I1).
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { TelegramClient, sessions } from 'telegram';
import { discoverSocksProxy } from '../src/core/proxy.js';
import { readTelegramKeys, readSession, writeSession, parseLoginArgs, loginRefusal } from '../src/telegram/session.js';
import type { LogLevel } from 'telegram/extensions/Logger.js';

try { process.loadEnvFile('.env'); } catch { /* ключи могут быть в окружении */ }

const args = parseLoginArgs(process.argv.slice(2));
if ('error' in args) { console.error(args.error); process.exit(1); }
// I1: флаг, проглоченный npm, или живая рабочая сессия без --force — отказ до
// любого вопроса про телефон: иначе личный аккаунт молча лёг бы в рабочую сессию.
const refusal = loginRefusal(args, process.env, (p) => readSession(p) !== null);
if (refusal !== null) { console.error(refusal); process.exit(1); }
const sessionPath = args.sessionPath;

const keys = readTelegramKeys();
if ('error' in keys) { console.error(keys.error); process.exit(1); }
const { found, checked } = await discoverSocksProxy();
if (found === null) { console.error(`VPN выключен — Telegram отсюда недоступен. Проверены: ${checked.join(', ')}`); process.exit(1); }

console.log(`Вход в Telegram, сессия будет записана в ${sessionPath}.`);
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
writeSession(String(client.session.save()), sessionPath);
const me = await client.getMe();
console.log(`Готово: вошли как ${'username' in me && me.username ? '@' + me.username : 'аккаунт без username'}. Сессия записана в ${sessionPath}.`);
console.log('Никому не пересылай этот файл: он даёт полный доступ к аккаунту. Отозвать — Telegram → Настройки → Устройства.');
rl.close();
await client.destroy();
