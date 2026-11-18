/**
 * Только чтение: кто такой бот и какие апдейты Telegram ему сейчас отдаёт.
 * Токен берётся из .env и нигде не печатается. getUpdates НЕ вызывается: второй
 * long polling Telegram не разрешает, и работающий бот вышел бы с кодом 1.
 *
 * Что смотреть:
 *  - can_connect_to_business: true — у @BotFather включён Secretary Mode, бота можно
 *    подключить к аккаунту (Настройки → Telegram для бизнеса / Chat Automation);
 *  - allowed_updates после запуска бота должен содержать business_message — иначе
 *    секретарь не получает сообщения из личных чатов аккаунта.
 *
 * Run: npx tsx scripts/bot-whoami.ts
 */
import { createProxiedFetch } from '../src/core/proxy.js';

try { process.loadEnvFile('.env'); } catch { /* токен может прийти из окружения */ }

const token = process.env['TG_BOT_TOKEN'];
if (token === undefined || token === '') {
  console.error('нет TG_BOT_TOKEN в .env');
  process.exit(1);
}

const fetchImpl = createProxiedFetch();
for (const method of ['getMe', 'getWebhookInfo']) {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const body = await res.json() as { ok: boolean; result?: Record<string, unknown>; description?: string };
  console.log(method, JSON.stringify(body.ok ? body.result : body.description, null, 1));
}
