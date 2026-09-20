# Telegram и автоотклик

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Искать вакансии в каналах и группах Telegram, писать рекрутёру первое сообщение с резюме, и дать тумблер «автоотклик», при котором поиск сам отправляет то, что прошло фильтры.

**Architecture:** Telegram виден коду через две узкие обёртки: `TgReader` (только чтение, получает поиск) и `TgSender` (отправка, получает только `apply()`). Посты разбираются правилами в `Vacancy` с новым полем `contact`, дальше — общий конвейер из плана 2026-09-18. Автоотклик — отдельный модуль, который после поиска одобряет строки по условиям спеки и запускает обычный `Sender`.

**Tech Stack:** Node.js 24 + TypeScript strict, GramJS (npm `telegram` 2.26.x) через SOCKS5 VPN-клиента, `node:sqlite`, vitest, Playwright (тесты панели).

**Spec:** [`docs/superpowers/specs/2026-09-18-search-settings-telegram-autoapply-design.md`](../specs/2026-09-18-search-settings-telegram-autoapply-design.md), разделы 4–7. Опирается на выполненный план [`2026-09-18-search-settings.md`](2026-09-18-search-settings.md).

## Global Constraints

- Серверы Telegram и t.me с этой машины напрямую не отвечают (проверено 2026-09-18 и 2026-09-19) — всё про Telegram идёт через SOCKS5 VPN-клиента (`127.0.0.1:10808`, находится `discoverSocksProxy`).
- Поиск получает только `TgReader`. `TgSender` — только `TelegramAdapter.apply()`. `readHistory`/пометка прочитанным не вызывается нигде (спека 4.3).
- Файл сессии `data/telegram.session` — полный доступ к аккаунту: не логируется, в панель не отдаётся (спека 4.2). `api_id`/`api_hash` пользователь кладёт в `.env` сам (`TG_API_ID`, `TG_API_HASH`); код их никуда не вводит.
- Первое чтение чата — 14 дней, дальше от курсора; не больше 1000 сообщений с чата за прогон; пауза 1–2 с между чатами; `FloodWait` ≤ 60 с — ждём, дольше — чат пропускается (спека 4.5).
- Контакт — `@username` из текста; пост без него отбрасывается, кроме ссылки на hh.ru/careerist (спека 4.6).
- Лимит Telegram: `maxPerDay: 40`, пауза 60–180 с (спека 5.4). `PEER_FLOOD` и долгий `FloodWait` — останавливающий `account_limited` (спека 5.3).
- Одному контакту — не чаще раза в 7 дней, и при поиске (не в автоотклик), и при отправке (остаётся `approved`, не `failed`) (спека 5.5).
- Автоотклик по умолчанию выключен; `minScore` автоотклика по умолчанию = общий `minScore`; не одобряются: пустое письмо, `letterMode 'none'`, скор ниже порога, контакт за 7 дней (спека 7.2).
- Тесты не ходят в сеть. Фикстуры постов — настоящие посты, `@username`, ссылки на личные аккаунты и имена людей вымараны.
- Живые отправки — только вместе с пользователем, на вакансию, которую он выберет (спека 9, этап 7).
- Все коммиты заканчиваются строкой `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## Структура файлов

```
src/telegram/
├── types.ts        # TgChat, TgMessage, TgReader, TgSender, TgPeer
├── errors.ts       # classifyTgError: GramJS-ошибка → вид сбоя
├── parse.ts        # пост → черновик вакансии (отбор, заголовок, контакт, ссылки, хэш)
├── gramjs.ts       # TgReader/TgSender поверх GramJS; openTelegram()
└── session.ts      # чтение/запись data/telegram.session, ключи из .env
src/adapters/telegram.ts   # TelegramAdapter: search (бесфразовый) и apply
src/core/dm.ts             # текст первого сообщения рекрутёру
src/core/autoapply.ts      # выбор строк для автоодобрения
scripts/tg-login.ts        # интерактивный вход (npm run tg:login)
```

Меняются: `src/core/proxy.ts` (SOCKS5), `src/core/vacancy.ts` (`contact`), `src/core/settings.ts` (`telegram`, `autoApply`), `src/core/queue.ts` (колонки, курсоры), `src/adapters/types.ts` (`queryless`, контекст `apply`, `account_limited`), `src/pipeline.ts` (бесфразовые адаптеры), `src/core/sender.ts` (7 дней, `account_limited`), `src/cli.ts`, `src/ui/server.ts`, `src/ui/panel.html`, `config.json`, `scripts/run.ps1`, `.claude/skills/jobs/SKILL.md`.

---

### Task 1: Доступ к Telegram

**Files:**
- Create: `src/telegram/types.ts`, `src/telegram/errors.ts`, `src/telegram/session.ts`, `src/telegram/gramjs.ts`, `scripts/tg-login.ts`, `tests/telegram-errors.test.ts`
- Modify: `src/core/proxy.ts` (SOCKS5), `tests/proxy.test.ts`, `src/cli.ts` (`loadDotEnv`), `package.json` (зависимость `telegram` уже стоит; скрипт `tg:login`)

**Interfaces:**
- Produces:
  - `types.ts`:
    ```ts
    export interface TgChat { id: string; title: string; username: string | null; kind: 'channel' | 'group' }
    export interface TgMessage { id: number; date: Date; text: string; urls: string[] }
    export interface TgPeer { kind: 'user' | 'bot' | 'channel' | 'group'; username: string }
    export interface TgReader {
      dialogs(): Promise<TgChat[]>;
      resolveChat(ref: string): Promise<TgChat>;
      messages(chat: TgChat, opts: { minId: number; since: Date; limit: number }): Promise<TgMessage[]>;
    }
    export interface TgSender {
      resolvePeer(username: string): Promise<TgPeer>;
      sendText(username: string, text: string): Promise<void>;
      sendFile(username: string, path: string): Promise<void>;
    }
    ```
  - `errors.ts`: `type TgFailure = { kind: 'flood_wait'; seconds: number } | { kind: 'peer_flood' } | { kind: 'privacy' } | { kind: 'not_found' } | { kind: 'auth' } | { kind: 'chat_unavailable' } | { kind: 'other'; message: string }`; `classifyTgError(e: unknown): TgFailure`; `describeTgFailure(f: TgFailure): string` (по-русски).
  - `proxy.ts`: `probeSocks5(address: ProxyAddress, timeoutMs?: number): Promise<boolean>` — приветствие без пароля + `CONNECT 149.154.167.51:443`; `discoverSocksProxy(deps?: DiscoveryDeps): Promise<ProxyDiscovery>`.
  - `session.ts`: `SESSION_PATH = 'data/telegram.session'`; `readTelegramKeys(env?): { apiId: number; apiHash: string } | { error: string }`; `readSession(path?): string | null`; `writeSession(value: string, path?): void`.
  - `gramjs.ts`: `openTelegram(opts?: { sessionPath?: string }): Promise<{ ok: true; reader: TgReader; sender: TgSender; close(): Promise<void> } | { ok: false; reason: 'no_keys' | 'no_session' | 'no_proxy' | 'auth'; message: string }>`.

- [ ] **Step 1: Тест классификации ошибок**

`tests/telegram-errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { errors } from 'telegram';
import { classifyTgError, describeTgFailure } from '../src/telegram/errors.js';

function rpc(message: string): Error {
  const e = new errors.RPCError(message, {} as never, 400);
  return e;
}

describe('classifyTgError', () => {
  it('FloodWaitError — секунды ожидания', () => {
    const e = new errors.FloodWaitError({ request: {} as never, capture: 42 });
    expect(classifyTgError(e)).toEqual({ kind: 'flood_wait', seconds: 42 });
  });

  it.each([
    ['PEER_FLOOD', 'peer_flood'],
    ['USER_PRIVACY_RESTRICTED', 'privacy'],
    ['USER_IS_BLOCKED', 'privacy'],
    ['YOU_BLOCKED_USER', 'privacy'],
    ['USERNAME_NOT_OCCUPIED', 'not_found'],
    ['USERNAME_INVALID', 'not_found'],
    ['AUTH_KEY_UNREGISTERED', 'auth'],
    ['SESSION_REVOKED', 'auth'],
    ['USER_DEACTIVATED', 'auth'],
    ['CHANNEL_PRIVATE', 'chat_unavailable'],
    ['CHAT_FORBIDDEN', 'chat_unavailable'],
  ])('%s → %s', (message, kind) => {
    expect(classifyTgError(rpc(message)).kind).toBe(kind);
  });

  it('«No user has "x" as username» от getEntity — not_found', () => {
    expect(classifyTgError(new Error('No user has "recruiter" as username')).kind).toBe('not_found');
  });

  it('всё остальное — other с текстом', () => {
    expect(classifyTgError(new Error('socket hang up'))).toEqual({ kind: 'other', message: 'socket hang up' });
  });

  it('описание по-русски называет, что делать', () => {
    expect(describeTgFailure({ kind: 'auth' })).toMatch(/npm run tg:login/);
    expect(describeTgFailure({ kind: 'peer_flood' })).toMatch(/ограничил/);
    expect(describeTgFailure({ kind: 'privacy' })).toMatch(/вручную/);
  });
});
```

Run: `npx vitest run tests/telegram-errors.test.ts` — Expected: FAIL (нет модуля). Если конструкторы `errors.RPCError`/`errors.FloodWaitError` в установленной версии принимают другие аргументы — открой `node_modules/telegram/errors/RPCBaseErrors.d.ts` и `RPCErrorList.d.ts` и создай их так, как там объявлено; проверяемое — `errorMessage` и `seconds`.

- [ ] **Step 2: types.ts и errors.ts**

`src/telegram/types.ts` — интерфейсы из блока Interfaces выше, с комментарием в шапке:

```ts
/**
 * Telegram глазами остального кода (спека 2026-09-18, 4.3). Две узкие обёртки
 * вместо GramJS-клиента целиком:
 *
 * - TgReader — только чтение. Его получает поиск, и поэтому поиск не может
 *   ничего отправить даже по ошибке: методов отправки у него нет.
 * - TgSender — отправка. Его получает только TelegramAdapter.apply(), а тот
 *   вызывается только из Sender, то есть после одобрения (или автоотклика).
 *
 * Обе подменяются в тестах; сети в тестах нет.
 */
```

`src/telegram/errors.ts`:

```ts
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
```

Run: `npx vitest run tests/telegram-errors.test.ts` — Expected: PASS.

- [ ] **Step 3: SOCKS5 в proxy.ts (тест, затем код)**

В `tests/proxy.test.ts` добавь (поднимает настоящий локальный сервер, не ходит наружу):

```ts
import { createServer } from 'node:net';
import { probeSocks5, discoverSocksProxy } from '../src/core/proxy.js';

describe('probeSocks5', () => {
  async function fakeSocks(connectReply: number): Promise<{ port: number; close(): void }> {
    const server = createServer((s) => {
      let stage = 0;
      s.on('data', () => {
        if (stage === 0) { s.write(Buffer.from([5, 0])); stage = 1; return; }
        s.write(Buffer.from([5, connectReply, 0, 1, 0, 0, 0, 0, 0, 0]));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    return { port, close: () => server.close() };
  }

  it('SOCKS5 без пароля, CONNECT прошёл — годен', async () => {
    const s = await fakeSocks(0);
    expect(await probeSocks5({ host: '127.0.0.1', port: s.port })).toBe(true);
    s.close();
  });

  it('CONNECT отклонён — не годен', async () => {
    const s = await fakeSocks(5);
    expect(await probeSocks5({ host: '127.0.0.1', port: s.port })).toBe(false);
    s.close();
  });

  it('HTTP-прокси вместо SOCKS — не годен', async () => {
    const server = createServer((s) => s.on('data', () => s.end('HTTP/1.1 400 Bad Request\r\n\r\n')));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    expect(await probeSocks5({ host: '127.0.0.1', port })).toBe(false);
    server.close();
  });

  it('discoverSocksProxy пробует кандидатов SOCKS-проверкой', async () => {
    const d = await discoverSocksProxy({
      env: {}, windowsProxyPorts: async () => [10809], vpnProcessPorts: async () => [10808, 10809],
      probe: async (a) => a.port === 10808,
    });
    expect(d.found).toMatchObject({ port: 10808, source: 'vpn-process' });
  });
});
```

В `src/core/proxy.ts` после `probeHttpProxy`:

```ts
/**
 * Годится ли адрес как SOCKS5-прокси до Telegram (спека 2026-09-18, 4.1).
 *
 * Серверы Telegram с этой машины напрямую не отвечают, а GramJS умеет только
 * SOCKS. У VPN-клиента рядом слушают SOCKS- и HTTP-порт (а у v2RayTun один
 * порт смешанный), поэтому проверка — настоящее рукопожатие: приветствие без
 * пароля и CONNECT к дата-центру Telegram DC2. Ответ «успех» на CONNECT
 * значит, что прокси живой и сам дотянулся до Telegram.
 */
export function probeSocks5(address: ProxyAddress, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: address.host, port: address.port });
    let settled = false;
    let stage = 0;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])));
    socket.on('data', (buf) => {
      if (stage === 0) {
        if (buf.length < 2 || buf[0] !== 5 || buf[1] !== 0) return done(false);
        stage = 1;
        // CONNECT 149.154.167.51:443 (DC2), IPv4.
        socket.write(Buffer.from([5, 1, 0, 1, 149, 154, 167, 51, 0x01, 0xbb]));
        return;
      }
      done(buf.length >= 2 && buf[0] === 5 && buf[1] === 0);
    });
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.once('close', () => done(false));
  });
}

/** То же, что discoverProxy, но годность кандидата — SOCKS5 до Telegram. */
export function discoverSocksProxy(deps: DiscoveryDeps = {}): Promise<ProxyDiscovery> {
  return discoverProxy({ ...deps, probe: deps.probe ?? ((a) => probeSocks5(a)) });
}
```

Run: `npx vitest run tests/proxy.test.ts` — Expected: PASS.

- [ ] **Step 4: session.ts и .env**

`loadDotEnv` в `src/cli.ts` сейчас выходит, если `OPENROUTER_API_KEY` уже задан, — тогда `TG_API_ID` из `.env` не прочитается. Замени тело на:

```ts
function loadDotEnv(): void {
  try {
    // process.loadEnvFile не перезаписывает переменные, уже заданные в
    // окружении: явно выставленное человеком по-прежнему главнее файла.
    process.loadEnvFile('.env');
  } catch {
    // Файла нет — это нормально, ключи могут приходить из окружения.
  }
}
```

Перед заменой проверь поведение одной командой (Node 24):

```bash
node -e "process.env.X='env'; require('fs').writeFileSync(require('os').tmpdir()+'/e.env','X=file\nY=file'); process.loadEnvFile(require('os').tmpdir()+'/e.env'); console.log(process.env.X, process.env.Y)"
```

Expected: `env file`. Если выводит `file file` — не заменяй, а загружай файл в копию и переноси только отсутствующие ключи (`for (const [k, v] of Object.entries(parsed)) process.env[k] ??= v`, разбор через `util.parseEnv`).

`src/telegram/session.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Строка сессии Telegram — полный доступ к аккаунту (спека 4.2). Лежит в
 * data/ (вне git), не логируется, в панель не отдаётся. Отозвать —
 * Настройки Telegram → Устройства.
 */
export const SESSION_PATH = 'data/telegram.session';

export function readTelegramKeys(env: NodeJS.ProcessEnv = process.env)
  : { apiId: number; apiHash: string } | { error: string } {
  const apiId = Number(env['TG_API_ID']);
  const apiHash = (env['TG_API_HASH'] ?? '').trim();
  if (!Number.isInteger(apiId) || apiId <= 0 || apiHash === '') {
    return {
      error: 'нет TG_API_ID/TG_API_HASH в .env — получи их на my.telegram.org (API development tools) и положи в .env',
    };
  }
  return { apiId, apiHash };
}

export function readSession(path: string = SESSION_PATH): string | null {
  if (!existsSync(path)) return null;
  const s = readFileSync(path, 'utf8').trim();
  return s === '' ? null : s;
}

export function writeSession(value: string, path: string = SESSION_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o600 });
}
```

- [ ] **Step 5: gramjs.ts**

`src/telegram/gramjs.ts` — единственное место, где код трогает GramJS. Юнит-тестов нет (обёртка тонкая, проверяется живым прогоном в Task 9); всё решающее вынесено в `errors.ts` и `parse.ts`.

```ts
import { TelegramClient, Api, sessions } from 'telegram';
import type { Dialog } from 'telegram/tl/custom/dialog.js';
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
  client.setLogLevel('error');
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
```

Если `tsc` ругается на импорт `Dialog` — возьми тип из `Awaited<ReturnType<TelegramClient['getDialogs']>>[number]`. Если `getPeerId` возвращает `string` или `bigInt` — `String(...)` покрывает оба.

- [ ] **Step 6: вход**

`scripts/tg-login.ts`:

```ts
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
client.setLogLevel('error');
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
```

В `package.json` → `scripts`: `"tg:login": "tsx scripts/tg-login.ts"`.

- [ ] **Step 7: Проверка и коммит**

Run: `npx tsc --noEmit && npx vitest run tests/telegram-errors.test.ts tests/proxy.test.ts`
Expected: PASS, tsc чистый.

```bash
git add package.json package-lock.json src/telegram src/core/proxy.ts src/cli.ts scripts/tg-login.ts tests/telegram-errors.test.ts tests/proxy.test.ts
git commit -m "feat: reach Telegram through the VPN's SOCKS5, with a login script the owner runs"
```

---

### Task 2: Разбор поста

**Files:**
- Create: `src/telegram/parse.ts`, `tests/telegram-parse.test.ts`, `tests/fixtures/tg-posts.json`

**Interfaces:**
- Consumes: `TgChat`, `TgMessage` (Task 1), `hasTitleWord` (screening.ts), `parseExperienceFromText`, `normalizeVacancy`, `RawVacancy`.
- Produces:
  - `MIN_POST_LENGTH = 200`, `VACANCY_MARKERS: readonly string[]`, `RESUME_MARKERS: readonly string[]`
  - `isVacancyPost(text: string): boolean`
  - `pickContact(text: string, ownUsername: string | null): string | null` — без `@`
  - `platformLink(urls: string[], text: string): { source: 'hh' | 'careerist'; sourceId: string; url: string } | null`
  - `postTitle(text: string, titleWords: readonly string[]): string`
  - `contentHash(text: string): string` — sha1 hex нормализованного текста
  - `postUrl(chat: TgChat, messageId: number): string`
  - `type PostVerdict = { ok: true; vacancy: Vacancy } | { ok: false; reason: 'not_vacancy' | 'no_contact' }`
  - `postToVacancy(chat: TgChat, m: TgMessage, allTitleWords: readonly string[]): PostVerdict` — `title` по словам заголовка всех включённых специальностей; `source 'tg'` или `hh`/`careerist` по ссылке; `contact`; `experience` из текста.

- [ ] **Step 1: Фикстура**

Собери `tests/fixtures/tg-posts.json` — массив `{ chat: TgChat, message: { id, date, text, urls } }` из снятых 2026-09-19 превью `t.me/s/workayte`, `t.me/s/foranalysts`, `t.me/s/refer_me_it`, `t.me/s/it_vakansii_jobs` (через VPN). Состав — ровно эти посты, по одному на случай:

| пост | случай |
|---|---|
| workayte/4320 «Ищем Senior аналитика команды КХД» | вакансия, контакт в строке «📩 Отклик: @…» |
| workayte/4328 «…требуется Системный аналитик» | контакт в строке «Контакты: @…», опыт «от 3 – лет» |
| workayte/4312 «SDR + Sales Manager» | вакансия, контакт `tg:@…`, но не аналитик |
| foranalysts/10868 «Junior / Middle System Analyst / Business Analyst» | единственный `@` — самореклама «Больше вакансий: @jobforjunior» → нет контакта |
| foranalysts/10885 «Ищем героев для 5 сезона подкаста» | не вакансия |
| refer_me_it/795 «System Analyst/Business Analyst», ссылка на бота | нет `@`, нет hh → нет контакта |
| it_vakansii_jobs/3176 «Дайджест резюме недели» | резюме, не вакансия |

Вымарай: каждый `@username` человека → `@recruiter_a`, `@recruiter_b`, … (и в `urls`: `https://t.me/recruiter_a`), имена людей → «Имя Фамилия», телефоны → `+70000000000`, почты → `hr@example.com`. `@jobforjunior` (канал-реклама) не трогай — это публичный канал, на нём и проверяется правило. Добавь два синтетических поста (так и помечены полем `"synthetic": true`): «Бизнес-аналитик … Подробнее: https://hh.ru/vacancy/123456789» без `@`, и «Бизнес-аналитик … https://careerist.ru/vakansii/biznes-analitik-89110600.html» без `@`.

Сборщик — одноразовый скрипт в scratchpad (не в репозитории): читает превью, берёт текст поста как GramJS (текст ссылок остаётся в тексте, адреса — в `urls`, хэштеговые ссылки `?q=` отбрасываются), вымарывает и пишет JSON. После сборки прочитай JSON глазами целиком и убедись, что ни одного живого `@username` человека и ни одного имени не осталось.

- [ ] **Step 2: Тест**

`tests/telegram-parse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  isVacancyPost, pickContact, platformLink, postTitle, contentHash, postUrl, postToVacancy,
} from '../src/telegram/parse.js';
import type { TgChat, TgMessage } from '../src/telegram/types.js';

interface Fixture { chat: TgChat; message: Omit<TgMessage, 'date'> & { date: string }; synthetic?: boolean }
const FIXTURES = (JSON.parse(readFileSync('tests/fixtures/tg-posts.json', 'utf8')) as Fixture[])
  .map((f) => ({ chat: f.chat, message: { ...f.message, date: new Date(f.message.date) } }));
function post(startsWith: string) {
  const f = FIXTURES.find((x) => x.message.text.trimStart().startsWith(startsWith));
  if (!f) throw new Error(`нет поста «${startsWith}» в фикстуре`);
  return f;
}
const WORDS = ['аналитик', 'analyst', 'BA', 'SA'];

describe('isVacancyPost', () => {
  it('настоящие вакансии — да', () => {
    expect(isVacancyPost(post('Ищем Senior аналитика').message.text)).toBe(true);
    expect(isVacancyPost(post('На проект ведущего банка').message.text)).toBe(true);
  });
  it('подкаст, дайджест резюме, короткий пост — нет', () => {
    expect(isVacancyPost(post('😎 Ищем героев').message.text)).toBe(false);
    expect(isVacancyPost(post('Дайджест резюме').message.text)).toBe(false);
    expect(isVacancyPost('Вакансия аналитика, пишите')).toBe(false);
  });
  it('#резюме и «ищу работу» — нет, даже со словом «вакансия»', () => {
    const long = 'x'.repeat(300);
    expect(isVacancyPost(`#резюме Бизнес-аналитик, ищу вакансию. ${long}`)).toBe(false);
    expect(isVacancyPost(`Ищу работу бизнес-аналитиком, требования к вакансии: ${long}`)).toBe(false);
  });
});

describe('pickContact', () => {
  it('строка «Отклик:» / «Контакты:» / «tg:» — контакт', () => {
    expect(pickContact(post('Ищем Senior аналитика').message.text, 'workayte')).toBe('recruiter_a');
    expect(pickContact(post('На проект ведущего банка').message.text, 'workayte')).toBe('recruiter_b');
    expect(pickContact(post('‼️SDR').message.text, 'workayte')).toMatch(/^recruiter_/);
  });
  it('реклама канала «Больше вакансий: @…» — не контакт', () => {
    expect(pickContact(post('Junior / Middle System Analyst').message.text, 'foranalysts')).toBeNull();
  });
  it('упоминание самого канала — не контакт', () => {
    expect(pickContact('Вакансия. Пишите @workayte, резюме в личку', 'workayte')).toBeNull();
  });
  it('без слов-признаков берётся первый @ не из рекламной строки', () => {
    expect(pickContact('Бизнес-аналитик в банк\n@hr_person\nПодписывайтесь на @channel_x', null)).toBe('hr_person');
  });
  it('почта и e-mail@домен — не username', () => {
    expect(pickContact('Резюме на hr@example.com', null)).toBeNull();
  });
});

describe('platformLink', () => {
  it('hh.ru — источник hh с id', () => {
    expect(platformLink(['https://hh.ru/vacancy/123456789?from=tg'], '')).toEqual({
      source: 'hh', sourceId: '123456789', url: 'https://hh.ru/vacancy/123456789',
    });
  });
  it('ссылка в тексте тоже считается', () => {
    expect(platformLink([], 'Подробнее: spb.hh.ru/vacancy/42')!.sourceId).toBe('42');
  });
  it('careerist — id из хвоста адреса', () => {
    expect(platformLink(['https://careerist.ru/vakansii/biznes-analitik-89110600.html'], '')).toEqual({
      source: 'careerist', sourceId: '89110600', url: 'https://careerist.ru/vakansii/biznes-analitik-89110600.html',
    });
  });
  it('LinkedIn и прочее — нет', () => {
    expect(platformLink(['https://lnkd.in/x'], '')).toBeNull();
  });
});

describe('postTitle', () => {
  it('первая строка со словом заголовка, без эмодзи и хэштегов', () => {
    expect(postTitle('🔥🔥\n#вакансия #удаленка\n💼 Бизнес-аналитик (middle) #fintech\nОписание', WORDS))
      .toBe('Бизнес-аналитик (middle)');
  });
  it('слово только в хэштеге — следующая строка со словом, иначе первая непустая', () => {
    expect(postTitle('#аналитик #вакансия\nВедущий специалист\nОписание', WORDS)).toBe('Ведущий специалист');
  });
  it('обрезается до 120 символов', () => {
    expect(postTitle(`Аналитик ${'x'.repeat(300)}`, WORDS).length).toBeLessThanOrEqual(120);
  });
});

describe('contentHash', () => {
  it('репост с другими эмодзи, хэштегами, ссылками и пробелами — тот же хэш', () => {
    const a = '🔥 Бизнес-аналитик\n\nОпыт от 1 года. Пишите @hr';
    const b = 'Бизнес-аналитик #вакансия\nОпыт   от 1 года. https://t.me/x Пишите @hr ✅';
    expect(contentHash(a)).toBe(contentHash(b));
  });
  it('другой текст — другой хэш', () => {
    expect(contentHash('Бизнес-аналитик')).not.toBe(contentHash('Системный аналитик'));
  });
});

describe('postUrl', () => {
  it('публичный канал — t.me/<username>/<id>', () => {
    expect(postUrl({ id: '-1001', title: 't', username: 'workayte', kind: 'channel' }, 4320))
      .toBe('https://t.me/workayte/4320');
  });
  it('закрытый — t.me/c/<id без -100>/<id>', () => {
    expect(postUrl({ id: '-1001234567', title: 't', username: null, kind: 'group' }, 7))
      .toBe('https://t.me/c/1234567/7');
  });
});

describe('postToVacancy', () => {
  it('вакансия с контактом — источник tg, контакт, опыт, ссылка на пост', () => {
    const f = post('На проект ведущего банка');
    const r = postToVacancy(f.chat, f.message, WORDS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vacancy.source).toBe('tg');
    expect(r.vacancy.sourceId).toBe(`${f.chat.id}:${f.message.id}`);
    expect(r.vacancy.contact).toBe('recruiter_b');
    expect(r.vacancy.title).toMatch(/Системный аналитик/);
    expect(r.vacancy.url).toBe(postUrl(f.chat, f.message.id));
    expect(r.vacancy.company).toBe('');
    expect(r.vacancy.description).toBe(f.message.text);
    expect(r.vacancy.experience).toBe('between1And3');
  });
  it('без контакта — no_contact', () => {
    const f = post('Junior / Middle System Analyst');
    expect(postToVacancy(f.chat, f.message, WORDS)).toEqual({ ok: false, reason: 'no_contact' });
  });
  it('не вакансия — not_vacancy', () => {
    const f = post('😎 Ищем героев');
    expect(postToVacancy(f.chat, f.message, WORDS)).toEqual({ ok: false, reason: 'not_vacancy' });
  });
  it('ссылка на hh без контакта — вакансия hh, подаётся адаптером hh', () => {
    const f = FIXTURES.find((x) => x.message.urls.some((u) => u.includes('hh.ru/vacancy/')))!;
    const r = postToVacancy(f.chat, f.message, WORDS);
    expect(r.ok && r.vacancy.source).toBe('hh');
    expect(r.ok && r.vacancy.sourceId).toBe('123456789');
    expect(r.ok && r.vacancy.url).toBe('https://hh.ru/vacancy/123456789');
    expect(r.ok && r.vacancy.contact).toBeNull();
  });
});
```

Run: `npx vitest run tests/telegram-parse.test.ts` — Expected: FAIL (нет модуля).

- [ ] **Step 3: parse.ts**

`src/telegram/parse.ts`:

```ts
import { createHash } from 'node:crypto';
import { normalizeVacancy, type Vacancy } from '../core/vacancy.js';
import { parseExperienceFromText, hasTitleWord } from '../core/screening.js';
import { containsTerm } from '../core/matching.js';
import type { TgChat, TgMessage } from './types.js';

/**
 * Пост Telegram → вакансия, правилами, без LLM (спека 2026-09-18, 4.6;
 * выбор владельца — «подход A»). Снято на живых каналах 2026-09-19:
 * контакт стоит в строке «📩 Отклик: @…», «Контакты: @…», «tg:@…», а
 * каналы-агрегаторы вставляют в пост рекламу себя («Больше вакансий: @…»),
 * которую за контакт принимать нельзя.
 */

export const MIN_POST_LENGTH = 200;

/** Признаки вакансии. Расширяется одной строкой. */
export const VACANCY_MARKERS: readonly string[] = [
  'вакансия', 'ваканси*', 'требования', 'обязанности', 'зп', 'зарплат*', 'оклад', 'vacancy', 'job',
  'что предстоит', 'чем предстоит', 'мы ожидаем', 'ищем',
];

/** Признаки поста-резюме или дайджеста резюме: это не вакансия, писать некому. */
export const RESUME_MARKERS: readonly string[] = ['резюме недели', 'ищу работу', 'ищу вакансию'];

export function isVacancyPost(text: string): boolean {
  if (text.length < MIN_POST_LENGTH) return false;
  if (/#резюме|#resume|#ищу/i.test(text)) return false;
  if (RESUME_MARKERS.some((m) => containsTerm(text, m))) return false;
  return /#(вакансия|vacancy|job|работа)\b/i.test(text) || VACANCY_MARKERS.some((m) => containsTerm(text, m));
}

const USERNAME = /(?<![\w@.])@([A-Za-z][A-Za-z0-9_]{3,31})\b/g;
/** Строка, где стоит контакт. */
const CONTACT_LINE = /отклик|контакт|писать|пишите|напиши|связь|связаться|tg\s*:|telegram|телеграм|резюме|cv|hr\b|📩|✉️|👉/i;
/** Строка с рекламой канала — её @ контактом не бывает. */
const PROMO_LINE = /больше ваканси|подпис|наш канал|канал[е]? с|чат[е]? с|рекомендац|реклам/i;

export function pickContact(text: string, ownUsername: string | null): string | null {
  const own = ownUsername?.toLowerCase() ?? null;
  const candidates: Array<{ name: string; strong: boolean }> = [];
  for (const line of text.split('\n')) {
    if (PROMO_LINE.test(line)) continue;
    for (const m of line.matchAll(USERNAME)) {
      const name = m[1]!;
      if (own !== null && name.toLowerCase() === own) continue;
      candidates.push({ name, strong: CONTACT_LINE.test(line) });
    }
  }
  return (candidates.find((c) => c.strong) ?? candidates[0])?.name ?? null;
}

const HH_RE = /(?:^|[^\w.])(?:[a-z-]+\.)?hh\.ru\/vacancy\/(\d+)/i;
const CAREERIST_RE = /careerist\.ru\/vakansii\/[\w-]*?-(\d+)\.html/i;

export function platformLink(urls: string[], text: string)
  : { source: 'hh' | 'careerist'; sourceId: string; url: string } | null {
  for (const s of [...urls, text]) {
    const hh = HH_RE.exec(s);
    if (hh) return { source: 'hh', sourceId: hh[1]!, url: `https://hh.ru/vacancy/${hh[1]!}` };
    const c = CAREERIST_RE.exec(s);
    if (c) {
      const url = /https?:\/\/[^\s]+/.exec(s)?.[0] ?? `https://${c[0]}`;
      return { source: 'careerist', sourceId: c[1]!, url };
    }
  }
  return null;
}

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const HASHTAG = /#[\p{L}\p{N}_]+/gu;
const TITLE_MAX = 120;

function cleanLine(line: string): string {
  return line.replace(EMOJI, '').replace(HASHTAG, '').replace(/\s+/g, ' ').replace(/^[\s\-–—:|•*]+|[\s\-–—:|•*]+$/g, '');
}

export function postTitle(text: string, titleWords: readonly string[]): string {
  const lines = text.split('\n');
  const cleaned = lines.map(cleanLine);
  let title = cleaned.find((c, i) => c !== '' && hasTitleWord(c, titleWords) && hasTitleWord(lines[i]!, titleWords));
  title ??= cleaned.find((c) => c !== '') ?? '';
  return title.slice(0, TITLE_MAX);
}

export function contentHash(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(HASHTAG, '')
    .replace(EMOJI, '')
    .replace(/[^\p{L}\p{N}@]+/gu, '');
  return createHash('sha1').update(normalized).digest('hex');
}

export function postUrl(chat: TgChat, messageId: number): string {
  if (chat.username !== null) return `https://t.me/${chat.username}/${messageId}`;
  return `https://t.me/c/${chat.id.replace(/^-100/, '').replace(/^-/, '')}/${messageId}`;
}

export type PostVerdict =
  | { ok: true; vacancy: Vacancy }
  | { ok: false; reason: 'not_vacancy' | 'no_contact' };

/**
 * Черновик вакансии из поста. Специальность здесь не выбирается: слова
 * заголовка всех включённых специальностей нужны только чтобы найти строку
 * заголовка. Какая специальность оценит пост — решает конвейер (pipeline.ts).
 */
export function postToVacancy(chat: TgChat, m: TgMessage, allTitleWords: readonly string[]): PostVerdict {
  if (!isVacancyPost(m.text)) return { ok: false, reason: 'not_vacancy' };
  const link = platformLink(m.urls, m.text);
  const contact = pickContact(m.text, chat.username);
  if (contact === null && link === null) return { ok: false, reason: 'no_contact' };

  const vacancy = normalizeVacancy({
    source: link?.source ?? 'tg',
    sourceId: link?.sourceId ?? `${chat.id}:${m.id}`,
    title: postTitle(m.text, allTitleWords),
    company: '',
    url: link?.url ?? postUrl(chat, m.id),
    description: m.text,
    geo: '',
    postedAt: m.date,
    experience: parseExperienceFromText(m.text),
    contact: link === null ? contact : null,
    contentHash: contentHash(m.text),
    channel: chat.title,
  });
  return { ok: true, vacancy };
}
```

`normalizeVacancy` получит `contact`, `contentHash`, `channel` в Task 3 — до него этот файл не компилируется, поэтому Task 2 коммитится вместе с Task 3 (см. Step 3 Task 3).

- [ ] **Step 4: Прогон**

Отложен до Task 3 (нужны поля `Vacancy`). Порядок: Task 3 Steps 1–3, затем `npx vitest run tests/telegram-parse.test.ts` — Expected: PASS.

---

### Task 3: Модель, настройки, очередь

**Files:**
- Modify: `src/core/vacancy.ts`, `src/core/settings.ts`, `src/core/queue.ts`, `tests/vacancy.test.ts`, `tests/settings.test.ts`, `tests/queue.test.ts`

**Interfaces:**
- Produces:
  - `Vacancy`/`RawVacancy`: `contact: string | null` (raw — необязательно), `contentHash: string | null`, `channel: string | null` (название чата, для карточки).
  - `Settings.telegram: { chats: TgChatSetting[]; firstReadDays: number }`, `TgChatSetting = TgChat & { enabled: boolean }`; `Settings.autoApply: { enabled: boolean; minScore: number | null }`. Отсутствующие секции при чтении дополняются значениями по умолчанию (`chats: []`, `firstReadDays: 14`, `enabled: false`, `minScore: null`); `firstReadDays` — целое 1–90; `minScore` — null или целое 0–100.
  - `Queue`: колонки `contact`, `content_hash`, `approved_by` (`'human' | 'auto'`); `QueueRow.contact: string | null`, `QueueRow.approvedBy: 'human' | 'auto' | null`, `QueueRow.createdAt: number`, `QueueRow.sentAt: number | null`; `insertPending(..., specialty)` пишет `contact`/`content_hash` из вакансии; `hasContentHash(hash: string): boolean`; `approve(id, letter?, by: 'human' | 'auto' = 'human')`; `lastContactAt(contact: string): { at: number; title: string; status: Status } | null` — последняя строка с этим контактом в `sent` (по `sent_at`) или в `pending`/`approved` (по `created_at`); `listSentSince(sinceMs: number): QueueRow[]`; `getTgCursor(chatId: string): number` (0, если нет); `setTgCursor(chatId: string, lastId: number): void`.

- [ ] **Step 1: Тесты**

`tests/vacancy.test.ts` — добавь:

```ts
it('contact, contentHash, channel — необязательны, по умолчанию null', () => {
  const v = normalizeVacancy({ source: 'hh', sourceId: '1', title: 't', company: 'c', url: 'u', description: 'd', geo: 'g', postedAt: '2026-09-19T00:00:00Z' });
  expect(v.contact).toBeNull();
  expect(v.contentHash).toBeNull();
  expect(v.channel).toBeNull();
});

it('contact чистится от @ и пробелов', () => {
  const v = normalizeVacancy({ source: 'tg', sourceId: '1:2', title: 't', company: '', url: 'u', description: 'd', geo: '', postedAt: new Date(), contact: ' @hr_person ' });
  expect(v.contact).toBe('hr_person');
});
```

`tests/settings.test.ts` — добавь:

```ts
describe('settings — telegram и автоотклик', () => {
  it('старый файл без секций — значения по умолчанию', () => {
    const s = seedSettings(undefined, null) as unknown as Record<string, unknown>;
    delete s['telegram'];
    delete s['autoApply'];
    const r = validateSettings(s);
    expect(r.ok && r.settings.telegram).toEqual({ chats: [], firstReadDays: 14 });
    expect(r.ok && r.settings.autoApply).toEqual({ enabled: false, minScore: null });
  });

  it('чаты: id и название обязательны, дубль id выкидывается', () => {
    const s = seedSettings(undefined, null);
    s.telegram.chats = [
      { id: '-1001', title: 'Работа в ИТ', username: 'workayte', kind: 'channel', enabled: true },
      { id: '-1001', title: 'дубль', username: null, kind: 'channel', enabled: true },
    ];
    const r = validateSettings(s);
    expect(r.ok && r.settings.telegram.chats).toHaveLength(1);
    s.telegram.chats = [{ id: '', title: 'x', username: null, kind: 'group', enabled: true }];
    expect(validateSettings(s).ok).toBe(false);
  });

  it.each([0, 91, 1.5])('глубина первого чтения %s — ошибка', (days) => {
    const s = seedSettings(undefined, null);
    s.telegram.firstReadDays = days;
    expect(validateSettings(s)).toMatchObject({ ok: false });
  });

  it('порог автоотклика — null или целое 0–100', () => {
    const s = seedSettings(undefined, null);
    s.autoApply = { enabled: true, minScore: 55 };
    expect(validateSettings(s).ok).toBe(true);
    s.autoApply = { enabled: true, minScore: 101 };
    expect(validateSettings(s).ok).toBe(false);
  });
});
```

`tests/queue.test.ts` — добавь:

```ts
describe('Queue — Telegram и автоотклик', () => {
  function tgVacancy(id: string, contact: string, hash = `h${id}`) {
    return normalizeVacancy({
      source: 'tg', sourceId: `-1001:${id}`, title: 'Бизнес-аналитик', company: '', url: `https://t.me/x/${id}`,
      description: 'd', geo: '', postedAt: '2026-09-19T00:00:00Z', contact, contentHash: hash, channel: 'Работа в ИТ',
    });
  }

  it('контакт и хэш пишутся и читаются', () => {
    q.insertPending(tgVacancy('1', 'hr_a'), 60, [], 'п', 'dm');
    expect(q.listByStatus('pending')[0]!.contact).toBe('hr_a');
    expect(q.hasContentHash('h1')).toBe(true);
    expect(q.hasContentHash('нет')).toBe(false);
  });

  it('approve помнит, кто одобрил', () => {
    q.insertPending(tgVacancy('1', 'hr_a'), 60, [], 'п', 'dm');
    const [row] = q.listByStatus('pending');
    q.approve(row!.id, undefined, 'auto');
    expect(q.listByStatus('approved')[0]!.approvedBy).toBe('auto');
  });

  it('lastContactAt — последняя строка с контактом, отправленная или в очереди', () => {
    expect(q.lastContactAt('hr_a')).toBeNull();
    q.insertPending(tgVacancy('1', 'hr_a'), 60, [], 'п', 'dm');
    expect(q.lastContactAt('hr_a')).toMatchObject({ status: 'pending', title: 'Бизнес-аналитик' });
    const [row] = q.listByStatus('pending');
    q.approve(row!.id);
    q.markSent(row!.id);
    expect(q.lastContactAt('hr_a')!.status).toBe('sent');
    expect(q.lastContactAt('HR_A')).not.toBeNull(); // username без учёта регистра
  });

  it('курсоры чатов', () => {
    expect(q.getTgCursor('-1001')).toBe(0);
    q.setTgCursor('-1001', 4331);
    q.setTgCursor('-1001', 4400);
    expect(q.getTgCursor('-1001')).toBe(4400);
  });

  it('listSentSince — отправленные после момента', () => {
    q.insertPending(tgVacancy('1', 'hr_a'), 60, [], 'п', 'dm');
    const [row] = q.listByStatus('pending');
    q.approve(row!.id, undefined, 'auto');
    q.markSent(row!.id);
    const sent = q.listSentSince(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.approvedBy).toBe('auto');
    expect(sent[0]!.sentAt).toBeGreaterThan(0);
  });
});
```

Run: `npx vitest run tests/vacancy.test.ts tests/settings.test.ts tests/queue.test.ts` — Expected: FAIL.

- [ ] **Step 2: Реализация**

`src/core/vacancy.ts`: в `RawVacancy` — `contact?: string | null; contentHash?: string | null; channel?: string | null;` (с комментарием: только у Telegram, спека 4.6/4.7), в `Vacancy` — те же поля без `?`. В `normalizeVacancy`:

```ts
    contact: raw.contact == null ? null : (raw.contact.trim().replace(/^@/, '') || null),
    contentHash: raw.contentHash ?? null,
    channel: raw.channel ?? null,
```

`src/core/settings.ts`:
- импорт `import type { TgChat } from '../telegram/types.js';`
- типы:

```ts
export type TgChatSetting = TgChat & { enabled: boolean };

export interface Settings {
  version: 1;
  specialties: Specialty[];
  stopWords: string[];
  /** Каналы и группы, где искать (спека 4.4). */
  telegram: { chats: TgChatSetting[]; firstReadDays: number };
  /**
   * Автоотклик (спека 7.1). По умолчанию выключен. minScore null — общий
   * minScore из config.json, то есть уходит всё, что прошло фильтры.
   */
  autoApply: { enabled: boolean; minScore: number | null };
}

export const DEFAULT_FIRST_READ_DAYS = 14;
```

- в `validateSettings` перед `return { ok: true, … }`:

```ts
  const tgRaw = isRecord(raw['telegram']) ? raw['telegram'] : {};
  const days = tgRaw['firstReadDays'] ?? DEFAULT_FIRST_READ_DAYS;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 90) {
    return { ok: false, error: 'Telegram: глубина первого чтения — целое число дней от 1 до 90' };
  }
  const chats: TgChatSetting[] = [];
  const seenChats = new Set<string>();
  for (const [i, c] of (Array.isArray(tgRaw['chats']) ? tgRaw['chats'] : []).entries()) {
    if (!isRecord(c) || typeof c['id'] !== 'string' || c['id'].trim() === ''
      || typeof c['title'] !== 'string' || c['title'].trim() === '') {
      return { ok: false, error: `Telegram, чат №${i + 1}: нужны id и название` };
    }
    const id = c['id'].trim();
    if (seenChats.has(id)) continue;
    seenChats.add(id);
    chats.push({
      id,
      title: c['title'].trim(),
      username: typeof c['username'] === 'string' && c['username'].trim() !== '' ? c['username'].trim().replace(/^@/, '') : null,
      kind: c['kind'] === 'channel' ? 'channel' : 'group',
      enabled: c['enabled'] !== false,
    });
  }

  const aaRaw = isRecord(raw['autoApply']) ? raw['autoApply'] : {};
  const aaMin = aaRaw['minScore'] ?? null;
  if (aaMin !== null && (typeof aaMin !== 'number' || !Number.isInteger(aaMin) || aaMin < 0 || aaMin > 100)) {
    return { ok: false, error: 'Автоотклик: порог — целое от 0 до 100 или пусто' };
  }
```

  и `return { ok: true, settings: { version: 1, specialties, stopWords: …, telegram: { chats, firstReadDays: days }, autoApply: { enabled: aaRaw['enabled'] === true, minScore: aaMin } } };`
- в `seedSettings` добавь `telegram: { chats: [], firstReadDays: DEFAULT_FIRST_READ_DAYS }, autoApply: { enabled: false, minScore: null }`.

`src/core/queue.ts`:
- миграции после `specialty` — `contact TEXT`, `content_hash TEXT`, `approved_by TEXT`, и

```ts
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tg_cursors (
        chat_id    TEXT PRIMARY KEY,
        last_id    INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_contact ON applications(contact);
      CREATE INDEX IF NOT EXISTS idx_hash ON applications(content_hash);
    `);
```

  (индексы — после `ALTER TABLE`, иначе на старой базе колонок ещё нет).
- `QueueRow`: `contact`, `approvedBy`, `createdAt`, `sentAt`; `DbRow`: `contact`, `approved_by`, `created_at`, `sent_at`; `toQueueRow` их переносит.
- `insertPending` — колонки `contact, content_hash` со значениями `v.contact?.toLowerCase() ?? null, v.contentHash`. Контакт хранится в нижнем регистре: username в Telegram регистронезависим.
- `approve(id, letter?, by: 'human' | 'auto' = 'human')` — в оба UPDATE добавь `approved_by=?`.
- новые методы:

```ts
  hasContentHash(hash: string): boolean {
    return this.db.prepare('SELECT 1 FROM applications WHERE content_hash = ? LIMIT 1').get(hash) !== undefined;
  }

  /**
   * Последняя строка с этим контактом (спека 5.5): отправленная — по времени
   * отправки, ждущая решения или отправки — по времени постановки. null —
   * этому человеку мы ещё не писали и писать не собираемся.
   */
  lastContactAt(contact: string): { at: number; title: string; status: Status } | null {
    const row = this.db.prepare(`
      SELECT status, vacancy_json,
             CASE WHEN status = 'sent' THEN sent_at ELSE created_at END AS at
      FROM applications
      WHERE contact = ? AND status IN ('sent', 'pending', 'approved')
      ORDER BY at DESC LIMIT 1
    `).get(contact.toLowerCase().replace(/^@/, '')) as unknown as { status: string; vacancy_json: string; at: number } | undefined;
    if (row === undefined) return null;
    return { at: row.at, status: row.status as Status, title: (JSON.parse(row.vacancy_json) as { title: string }).title };
  }

  listSentSince(sinceMs: number): QueueRow[] {
    const rows = this.db.prepare(
      "SELECT * FROM applications WHERE status='sent' AND sent_at >= ? ORDER BY sent_at DESC",
    ).all(sinceMs) as unknown as DbRow[];
    return rows.map(this.toQueueRow);
  }

  getTgCursor(chatId: string): number {
    const row = this.db.prepare('SELECT last_id FROM tg_cursors WHERE chat_id = ?').get(chatId) as unknown as { last_id: number } | undefined;
    return row?.last_id ?? 0;
  }

  setTgCursor(chatId: string, lastId: number): void {
    this.db.prepare(`
      INSERT INTO tg_cursors (chat_id, last_id, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET last_id = MAX(last_id, excluded.last_id), updated_at = excluded.updated_at
    `).run(chatId, lastId, Date.now());
  }
```

- [ ] **Step 3: Прогон и коммит Task 2 + 3**

Run: `npx tsc --noEmit && npx vitest run`
Expected: всё PASS, включая `tests/telegram-parse.test.ts`. Старые тесты, которые строят `Settings` руками, получат ошибку типа — добавь им `telegram`/`autoApply` через `seedSettings` или распространи засев.

```bash
git add src/core/vacancy.ts src/core/settings.ts src/core/queue.ts src/telegram/parse.ts tests/fixtures/tg-posts.json tests/telegram-parse.test.ts tests/vacancy.test.ts tests/settings.test.ts tests/queue.test.ts
git commit -m "feat: Telegram posts become vacancies with a recruiter contact; queue remembers contacts"
```

---

### Task 4: Поиск в Telegram

**Files:**
- Create: `src/adapters/telegram.ts`, `tests/telegram-adapter.test.ts`
- Modify: `src/adapters/types.ts`, `src/pipeline.ts`, `src/cli.ts` (отчёт), `src/ui/panel.html` (сводка), `tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `TgReader`, `TgChat`, `TgMessage` (Task 1); `postToVacancy` (Task 2); `Queue.getTgCursor/setTgCursor`, `Settings.telegram` (Task 3); `classifyTgError`.
- Produces:
  - `Adapter.queryless?: boolean` — конвейер вызывает такой адаптер один раз за прогон.
  - `TelegramAdapter` (`name = 'tg'`, `queryless = true`): конструктор `{ reader: () => Promise<TgReader | { error: string }>; sender?: …(Task 6); queue: Pick<Queue,'getTgCursor'|'setTgCursor'>; chats: () => TgChatSetting[]; firstReadDays: () => number; titleWords: () => string[]; sleep?; now?; random? }`.
  - `TelegramAdapter.lastSearchStats: { read: number; notVacancy: number; noContact: number; skippedChats: Array<{ title: string; why: string }> }`.
  - `SearchReport`: `tgNotVacancy`, `tgNoContact`, `tgSkippedChats: Array<{ title; why }>`, `textDuplicates`.
  - `RunSearchOptions.specialties?: Specialty[]` — включённые специальности, для бесфразовых адаптеров.

- [ ] **Step 1: Тест адаптера**

`tests/telegram-adapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TelegramAdapter } from '../src/adapters/telegram.js';
import type { TgChat, TgMessage, TgReader } from '../src/telegram/types.js';
import type { TgChatSetting } from '../src/core/settings.js';
import { errors } from 'telegram';

const CHAT: TgChatSetting = { id: '-1001', title: 'Работа в ИТ', username: 'workayte', kind: 'channel', enabled: true };
const VACANCY_TEXT = 'Бизнес-аналитик в банк\nТребования: BPMN, опыт от 1 года. ' + 'Описание задач. '.repeat(15) + '\nОтклик: @hr_person';
const NOW = new Date('2026-09-19T12:00:00Z');

function msg(id: number, text = VACANCY_TEXT, daysAgo = 1): TgMessage {
  return { id, date: new Date(NOW.getTime() - daysAgo * 86_400_000), text, urls: [] };
}

function mkReader(byChat: Record<string, TgMessage[] | Error>, calls: Array<{ chat: string; minId: number }> = []): TgReader {
  return {
    async dialogs() { return []; },
    async resolveChat() { throw new Error('не нужен'); },
    async messages(chat: TgChat, opts) {
      calls.push({ chat: chat.id, minId: opts.minId });
      const v = byChat[chat.id];
      if (v instanceof Error) throw v;
      return (v ?? []).filter((m) => m.id > opts.minId && m.date >= opts.since).slice(0, opts.limit);
    },
  };
}

function mkAdapter(reader: TgReader | { error: string }, chats: TgChatSetting[] = [CHAT]) {
  const cursors = new Map<string, number>();
  const slept: number[] = [];
  const adapter = new TelegramAdapter({
    reader: async () => reader,
    queue: { getTgCursor: (id) => cursors.get(id) ?? 0, setTgCursor: (id, last) => cursors.set(id, Math.max(cursors.get(id) ?? 0, last)) },
    chats: () => chats,
    firstReadDays: () => 14,
    titleWords: () => ['аналитик'],
    sleep: async (ms) => { slept.push(ms); },
    now: () => NOW.getTime(),
    random: () => 0,
  });
  return { adapter, cursors, slept };
}

describe('TelegramAdapter.search', () => {
  it('бесфразовый: второй вызов за прогон (skip > 0) ничего не читает', async () => {
    const calls: Array<{ chat: string; minId: number }> = [];
    const { adapter } = mkAdapter(mkReader({ '-1001': [msg(10)] }, calls));
    expect(adapter.queryless).toBe(true);
    expect(await adapter.search({ query: '', skip: 0 })).toHaveLength(1);
    expect(await adapter.search({ query: '', skip: 1 })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('первое чтение — от 0 на 14 дней, дальше — от курсора', async () => {
    const calls: Array<{ chat: string; minId: number }> = [];
    const { adapter, cursors } = mkAdapter(mkReader({ '-1001': [msg(12), msg(11, VACANCY_TEXT, 20)] }, calls));
    const first = await adapter.search({ query: '', skip: 0 });
    expect(first.map((v) => v.sourceId)).toEqual(['-1001:12']); // 20 дней назад — за глубиной
    expect(cursors.get('-1001')).toBe(12);
    await adapter.search({ query: '', skip: 0 });
    expect(calls.at(-1)!.minId).toBe(12);
  });

  it('счётчики: не вакансия, нет контакта', async () => {
    const noContact = VACANCY_TEXT.replace('Отклик: @hr_person', 'Отклик на сайте');
    const { adapter } = mkAdapter(mkReader({ '-1001': [msg(1, 'Короткий пост'), msg(2, noContact), msg(3)] }));
    const out = await adapter.search({ query: '', skip: 0 });
    expect(out).toHaveLength(1);
    expect(adapter.lastSearchStats).toMatchObject({ read: 3, notVacancy: 1, noContact: 1 });
  });

  it('выключенный чат не читается', async () => {
    const calls: Array<{ chat: string; minId: number }> = [];
    const { adapter } = mkAdapter(mkReader({ '-1001': [msg(1)] }, calls), [{ ...CHAT, enabled: false }]);
    expect(await adapter.search({ query: '', skip: 0 })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('недоступный чат пропускается и называется, остальные читаются', async () => {
    const other: TgChatSetting = { ...CHAT, id: '-1002', title: 'Второй' };
    const gone = new errors.RPCError('CHANNEL_PRIVATE', {} as never, 400);
    const { adapter } = mkAdapter(mkReader({ '-1001': gone, '-1002': [msg(5)] }), [CHAT, other]);
    const out = await adapter.search({ query: '', skip: 0 });
    expect(out).toHaveLength(1);
    expect(adapter.lastSearchStats!.skippedChats).toEqual([{ title: 'Работа в ИТ', why: 'чат недоступен (закрыт или тебя удалили)' }]);
  });

  it('FloodWait до 60 с — ждём и повторяем; дольше — чат пропускается', async () => {
    let n = 0;
    const flaky: TgReader = {
      ...mkReader({}),
      async messages() {
        n++;
        if (n === 1) throw new errors.FloodWaitError({ request: {} as never, capture: 30 });
        return [msg(7)];
      },
    };
    const { adapter, slept } = mkAdapter(flaky);
    expect(await adapter.search({ query: '', skip: 0 })).toHaveLength(1);
    expect(slept).toContain(30_000);

    const long: TgReader = { ...mkReader({}), async messages() { throw new errors.FloodWaitError({ request: {} as never, capture: 600 }); } };
    const b = mkAdapter(long);
    expect(await b.adapter.search({ query: '', skip: 0 })).toEqual([]);
    expect(b.adapter.lastSearchStats!.skippedChats[0]!.why).toMatch(/600/);
  });

  it('Telegram не подключён — ошибка с причиной (конвейер запишет её в отчёт)', async () => {
    const { adapter } = mkAdapter({ error: 'VPN выключен, Telegram пропущен' });
    await expect(adapter.search({ query: '', skip: 0 })).rejects.toThrow('VPN выключен');
  });

  it('между чатами пауза 1–2 с', async () => {
    const other: TgChatSetting = { ...CHAT, id: '-1002', title: 'Второй' };
    const { adapter, slept } = mkAdapter(mkReader({ '-1001': [], '-1002': [] }), [CHAT, other]);
    await adapter.search({ query: '', skip: 0 });
    expect(slept).toEqual([1000]);
  });
});
```

Run: `npx vitest run tests/telegram-adapter.test.ts` — Expected: FAIL.

- [ ] **Step 2: Адаптер**

`src/adapters/types.ts`: в `Adapter` — `readonly queryless?: boolean;` с комментарием: «Адаптер не ищет по фразам (Telegram читает ленту). Конвейер вызывает его один раз за прогон со `skip: 0`; `search` при `skip > 0` обязан вернуть пустой список.»

`src/adapters/telegram.ts` (часть `search`; `apply` — в Task 6, пока `apply` возвращает `{ status: 'failed', reason: 'отправка в Telegram ещё не подключена' }`):

```ts
import type { Adapter, ApplyResult, SearchFilters } from './types.js';
import type { Vacancy } from '../core/vacancy.js';
import type { Queue } from '../core/queue.js';
import type { TgChatSetting } from '../core/settings.js';
import type { TgReader } from '../telegram/types.js';
import { postToVacancy } from '../telegram/parse.js';
import { classifyTgError, describeTgFailure } from '../telegram/errors.js';

/** Не больше сообщений с одного чата за прогон (спека 4.5): шумная группа не должна съесть прогон. */
export const MAX_MESSAGES_PER_CHAT = 1000;
/** FloodWait до этого — ждём и повторяем один раз; дольше — чат пропускается. */
export const MAX_FLOOD_WAIT_S = 60;

export interface TelegramSearchStats {
  read: number;
  notVacancy: number;
  noContact: number;
  skippedChats: Array<{ title: string; why: string }>;
}

export interface TelegramAdapterOptions {
  /** Ленивый: Telegram поднимается только когда до него дошёл поиск. Ошибка — с причиной для человека. */
  reader: () => Promise<TgReader | { error: string }>;
  queue: Pick<Queue, 'getTgCursor' | 'setTgCursor'>;
  chats: () => TgChatSetting[];
  firstReadDays: () => number;
  /** Слова заголовка всех включённых специальностей — для строки заголовка поста. */
  titleWords: () => string[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export class TelegramAdapter implements Adapter {
  readonly name = 'tg';
  readonly queryless = true;
  lastSearchStats: TelegramSearchStats | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly opts: TelegramAdapterOptions) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  async search(filters: SearchFilters): Promise<Vacancy[]> {
    const stats: TelegramSearchStats = { read: 0, notVacancy: 0, noContact: 0, skippedChats: [] };
    this.lastSearchStats = stats;
    if ((filters.skip ?? 0) > 0) return [];

    const chats = this.opts.chats().filter((c) => c.enabled);
    if (chats.length === 0) return [];
    const reader = await this.opts.reader();
    if ('error' in reader) throw new Error(reader.error);

    const since = new Date(this.now() - this.opts.firstReadDays() * 86_400_000);
    const words = this.opts.titleWords();
    const out: Vacancy[] = [];

    for (const [i, chat] of chats.entries()) {
      // Пауза между чатами: чтение подряд десятка чатов без передышки —
      // ровно тот рисунок, на который Telegram отвечает FloodWait.
      if (i > 0) await this.sleep(1000 + Math.floor(this.random() * 1001));
      const messages = await this.readChat(reader, chat, since, stats);
      if (messages === null) continue;
      let maxId = this.opts.queue.getTgCursor(chat.id);
      for (const m of messages) {
        stats.read++;
        maxId = Math.max(maxId, m.id);
        const verdict = postToVacancy(chat, m, words);
        if (verdict.ok) out.push(verdict.vacancy);
        else if (verdict.reason === 'not_vacancy') stats.notVacancy++;
        else stats.noContact++;
      }
      this.opts.queue.setTgCursor(chat.id, maxId);
    }
    return out;
  }

  private async readChat(
    reader: TgReader, chat: TgChatSetting, since: Date, stats: TelegramSearchStats,
  ) {
    const minId = this.opts.queue.getTgCursor(chat.id);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await reader.messages(chat, { minId, since, limit: MAX_MESSAGES_PER_CHAT });
      } catch (e) {
        const f = classifyTgError(e);
        if (f.kind === 'flood_wait' && f.seconds <= MAX_FLOOD_WAIT_S && attempt === 0) {
          await this.sleep(f.seconds * 1000);
          continue;
        }
        // Сессия протухла — это не про чат, а про весь Telegram: пусть
        // конвейер запишет причину и перестанет ходить сюда в этом прогоне.
        if (f.kind === 'auth') throw new Error(describeTgFailure(f));
        stats.skippedChats.push({ title: chat.title, why: describeTgFailure(f) });
        return null;
      }
    }
    return null;
  }

  async apply(): Promise<ApplyResult> {
    return { status: 'failed', reason: 'отправка в Telegram ещё не подключена' };
  }
}
```

Run: `npx vitest run tests/telegram-adapter.test.ts` — Expected: PASS.

- [ ] **Step 3: Конвейер — тест**

В `tests/pipeline.test.ts` добавь:

```ts
describe('runSearch — бесфразовый адаптер (Telegram)', () => {
  const PM: Specialty = {
    ...DEFAULT_SPECIALTY, id: 'pm', name: 'Менеджер продукта', legacyLetters: false,
    titleWords: ['продакт', 'product manager'],
    skills: [{ id: 'roadmap', name: 'Роадмап', synonyms: ['роадмап'], weight: 30, core: true }],
  };

  function tgAdapter(posts: Array<{ id: string; title: string; text: string; contact?: string; hash?: string }>): Adapter & { calls: number } {
    const a = {
      name: 'tg', queryless: true, calls: 0,
      async search(f: SearchFilters) {
        a.calls++;
        if ((f.skip ?? 0) > 0) return [];
        return posts.map((p) => normalizeVacancy({
          source: 'tg', sourceId: p.id, title: p.title, company: '', url: `https://t.me/x/${p.id}`,
          description: p.text, geo: '', postedAt: '2026-09-19T00:00:00Z',
          contact: p.contact ?? 'hr', contentHash: p.hash ?? p.id, channel: 'Работа в ИТ',
        }));
      },
      async apply() { return { status: 'sent' as const }; },
    };
    return a;
  }

  it('вызывается один раз, сколько бы фраз ни было', async () => {
    const tg = tgAdapter([]);
    await runSearch({
      queue: q, config: CONFIG, queries: [{ query: 'а' }, { query: 'б' }, { query: 'в' }],
      specialties: [DEFAULT_SPECIALTY], adapters: [tg], target: 10,
      generate: async () => ({ letter: 'п', mode: 'dm' as const }),
    });
    expect(tg.calls).toBe(1);
  });

  it('специальность — та, чьи слова заголовка есть в посте; при нескольких — лучший скор', async () => {
    const seen: string[] = [];
    const rep = await runSearch({
      queue: q, config: CONFIG, queries: [{ query: 'x' }], specialties: [DEFAULT_SPECIALTY, PM],
      adapters: [tgAdapter([
        { id: '1', title: 'Бизнес-аналитик', text: `Бизнес-аналитик. ${PROCESS_LANGUAGE}` },
        { id: '2', title: 'Product manager', text: 'Product manager, ведём роадмап продукта и не только.' },
        { id: '3', title: 'Повар', text: 'Повар на кухню, опыт от года.' },
      ])],
      generate: async (_v, _m, mode, s) => { seen.push(s.id); return { letter: 'п', mode }; },
    });
    expect(seen.sort()).toEqual(['business-analyst', 'pm']);
    expect(rep.rejectedTitle).toBe(1); // повар — ни одна специальность
    expect(q.listByStatus('pending').map((r) => r.specialty).sort()).toEqual(['business-analyst', 'pm']);
  });

  it('гейт заголовка не повторяется: заголовок поста может не содержать слов', async () => {
    const rep = await runSearch({
      queue: q, config: CONFIG, queries: [{ query: 'x' }], specialties: [DEFAULT_SPECIALTY],
      adapters: [tgAdapter([{ id: '1', title: 'Ищем в команду банка', text: `Системный аналитик. ${PROCESS_LANGUAGE}` }])],
      generate: async () => ({ letter: 'п', mode: 'dm' as const }),
    });
    expect(rep.queued).toBe(1);
  });

  it('репост с тем же текстом — дубль по хэшу, и в прогоне, и между прогонами', async () => {
    const posts = [
      { id: '1', title: 'Бизнес-аналитик', text: `Бизнес-аналитик. ${PROCESS_LANGUAGE}`, hash: 'H' },
      { id: '2', title: 'Бизнес-аналитик', text: `Бизнес-аналитик. ${PROCESS_LANGUAGE}`, hash: 'H' },
    ];
    const opts = {
      queue: q, config: CONFIG, queries: [{ query: 'x' }], specialties: [DEFAULT_SPECIALTY],
      generate: async () => ({ letter: 'п', mode: 'dm' as const }),
    };
    const first = await runSearch({ ...opts, adapters: [tgAdapter(posts)] });
    expect(first.queued).toBe(1);
    expect(first.textDuplicates).toBe(1);
    const second = await runSearch({ ...opts, adapters: [tgAdapter([{ ...posts[0]!, id: '3' }])] });
    expect(second.queued).toBe(0);
    expect(second.textDuplicates).toBe(1);
  });

  it('статистика адаптера — в отчёте', async () => {
    const tg = tgAdapter([]) as Adapter & { lastSearchStats?: unknown };
    tg.lastSearchStats = { read: 5, notVacancy: 3, noContact: 2, skippedChats: [{ title: 'X', why: 'чат недоступен' }] };
    const rep = await runSearch({
      queue: q, config: CONFIG, queries: [{ query: 'x' }], specialties: [DEFAULT_SPECIALTY], adapters: [tg],
      generate: async () => ({ letter: 'п', mode: 'dm' as const }),
    });
    expect(rep).toMatchObject({ found: 5, tgNotVacancy: 3, tgNoContact: 2, tgSkippedChats: [{ title: 'X', why: 'чат недоступен' }] });
  });
});
```

Добавь `'dm'` в `LetterMode` уже здесь (Task 5 его использует): `export type LetterMode = 'hybrid' | 'full' | 'none' | 'manual' | 'dm';` с комментарием «`dm` — личное сообщение рекрутёру в Telegram (core/dm.ts)».

Run: `npx vitest run tests/pipeline.test.ts` — Expected: FAIL.

- [ ] **Step 4: Конвейер — реализация**

В `src/pipeline.ts`:
- `RunSearchOptions.specialties?: Specialty[]` (комментарий: «Включённые специальности — для бесфразовых адаптеров; по умолчанию специальности фраз.»)
- `SearchReport`: `tgNotVacancy: number; tgNoContact: number; tgSkippedChats: Array<{ title: string; why: string }>; textDuplicates: number;` (инициализация нулями/`[]`).
- построение `tasks`: бесфразовый адаптер получает одну задачу на весь прогон:

```ts
  opts.queries.forEach((qc, queryIndex) => {
    for (const adapter of opts.adapters) {
      if (adapter.queryless === true && queryIndex > 0) continue;
      tasks.push({ qc, adapter, queryIndex, skip: 0, done: false });
    }
  });
  const specialtiesForQueryless = opts.specialties
    ?? [...new Map(opts.queries.map((q) => [(q.specialty ?? DEFAULT_SPECIALTY).id, q.specialty ?? DEFAULT_SPECIALTY])).values()];
```

- статистика: после `const stats = …lastSearchStats` добавь чтение Telegram-полей по утиной типизации:

```ts
    const tgStats = (task.adapter as unknown as { lastSearchStats?: { notVacancy?: number; noContact?: number; skippedChats?: Array<{ title: string; why: string }> } }).lastSearchStats;
    report.tgNotVacancy += tgStats?.notVacancy ?? 0;
    report.tgNoContact += tgStats?.noContact ?? 0;
    report.tgSkippedChats.push(...(tgStats?.skippedChats ?? []));
```

  и `const read = stats ? stats.read : vacancies.length;` оставь; для Telegram `stats.read` есть, а `rejectedExperience` в нём нет — сложи `?? 0`.
- бесфразовый адаптер после одного захода — `task.done = true` (независимо от `read`).
- в цикле по вакансиям, после `opts.queue.has(v)`:

```ts
      // Один пост часто перепощен в несколько каналов (спека 4.7): ключ дубля —
      // хэш текста, и в прогоне, и между прогонами.
      if (v.contentHash !== null) {
        if (seenHashes.has(v.contentHash) || opts.queue.hasContentHash(v.contentHash)) {
          report.textDuplicates++;
          continue;
        }
        seenHashes.add(v.contentHash);
      }
```

  (`const seenHashes = new Set<string>();` рядом с `seenThisRun`).
- выбор специальности и отсев для бесфразового адаптера — вместо одной специальности фразы:

```ts
      const candidates = task.adapter.queryless === true
        ? specialtiesForQueryless.filter((s) => hasTitleWord(`${v.title}\n${v.description}`, s.titleWords))
        : [task.qc.specialty ?? DEFAULT_SPECIALTY];
      if (candidates.length === 0) { report.rejectedTitle++; continue; }

      let best: { specialty: Specialty; score: number; matched: string[] } | null = null;
      let firstReject: ScreenResult | null = null;
      let lowScore = false;
      let noCore = false;
      for (const specialty of candidates) {
        const screen = screenVacancy(v, {
          titleWords: specialty.titleWords, experienceYears: specialty.experienceYears, stopWords,
          skipTitleGate: task.adapter.queryless === true,
        });
        if (!screen.passed) { firstReject ??= screen; continue; }
        const s = scoreVacancy(v, specialty.skills);
        if (s.score < opts.config.minScore) { lowScore = true; continue; }
        if (!s.hasCoreMatch) { noCore = true; continue; }
        // При равенстве — первая по порядку в настройках (строгое «>»).
        if (best === null || s.score > best.score) best = { specialty, score: s.score, matched: s.matched };
      }
      if (best === null) {
        if (firstReject !== null && !lowScore && !noCore) countReject(firstReject);
        else if (lowScore) report.belowThreshold++;
        else report.noCoreMatch++;
        continue;
      }
      const { specialty, score, matched } = best;
```

  где `countReject(screen)` — вынесенный из прежнего кода подсчёт причин отсева (`experience`/`grade`/`not_title`/`internship`/`stopword` + `stopwordHits`). Для обычных адаптеров `candidates` — одна специальность фразы, и поведение прежнее: весь существующий набор тестов конвейера обязан пройти без правок.
- импорты: `hasTitleWord`, `type ScreenResult` из screening.

`src/cli.ts#formatSearchReport` — после строки «Отсеяно (стажировка)»:

```ts
  if (report.tgNotVacancy + report.tgNoContact + report.textDuplicates > 0) {
    lines.push(`Telegram: не вакансия ${report.tgNotVacancy}, без контакта ${report.tgNoContact}, репостов ${report.textDuplicates}`);
  }
  for (const c of report.tgSkippedChats) lines.push(`  Telegram, «${c.title}» пропущен: ${c.why}`);
```

`src/ui/panel.html#pollSearch` — в `parts`: `if (r.tgNoContact) parts.push(\`tg без контакта ${r.tgNoContact}\`); if (r.textDuplicates) parts.push(\`репостов ${r.textDuplicates}\`); for (const c of r.tgSkippedChats ?? []) parts.push(\`«${c.title}»: ${c.why}\`);`

- [ ] **Step 5: Прогон и коммит**

Run: `npx tsc --noEmit && npx vitest run` — Expected: PASS (старые тесты без правок, кроме полей `SearchReport` в `tests/cli.test.ts#BASE_REPORT` — добавь нули).

```bash
git add src/adapters/types.ts src/adapters/telegram.ts src/pipeline.ts src/cli.ts src/ui/panel.html src/core/queue.ts tests/telegram-adapter.test.ts tests/pipeline.test.ts tests/cli.test.ts
git commit -m "feat: read Telegram channels once per run and let the best-fitting specialty score each post"
```

---

### Task 5: Текст первого сообщения

**Files:**
- Create: `src/core/dm.ts`, `tests/dm.test.ts`
- Modify: `src/cli.ts` (`generate` и `fillEmptyLetters`: ветка для `contact !== null`)

**Interfaces:**
- Consumes: `complete`, `ChatMessage` (openrouter.ts), `findForbiddenClaim` (letter.ts), `Vacancy`.
- Produces: `DM_MAX_LENGTH = 1200`; `buildDmMessages(input: { vacancy: Vacancy; resume: string; role: string }): ChatMessage[]`; `isUsableDm(text: string, vacancy: Vacancy): string | null` (причина или null); `generateDm(input, options: CompletionOptions): Promise<{ letter: string; mode: 'dm' | 'none'; failure?: string }>`.

- [ ] **Step 1: Тест**

`tests/dm.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { buildDmMessages, isUsableDm, generateDm, DM_MAX_LENGTH } from '../src/core/dm.js';
import { normalizeVacancy } from '../src/core/vacancy.js';

const V = normalizeVacancy({
  source: 'tg', sourceId: '-1001:7', title: 'Системный аналитик', company: '', url: 'https://t.me/workayte/7',
  description: 'Нужен BPMN, UML, SQL. Контакты: @hr', geo: '', postedAt: '2026-09-19T00:00:00Z',
  contact: 'hr', channel: 'Работа в ИТ',
});
const KEY = process.env['OPENROUTER_API_KEY'];
afterEach(() => { if (KEY === undefined) delete process.env['OPENROUTER_API_KEY']; else process.env['OPENROUTER_API_KEY'] = KEY; });

describe('buildDmMessages', () => {
  const [system, user] = buildDmMessages({ vacancy: V, resume: 'РЕЗЮМЕ', role: 'Системный аналитик' });
  it('правила личного сообщения: вакансия и ссылка сразу, 2–3 предложения, резюме во вложении', () => {
    expect(system!.content).toMatch(/ссылк/);
    expect(system!.content).toMatch(/2–3 предложения/);
    expect(system!.content).toMatch(/во вложении/);
  });
  it('без правил письма, которые здесь неверны', () => {
    expect(system!.content).not.toContain('Не начинай с упоминания того, что это отклик');
    expect(system!.content).not.toContain('"Резюме прикреплено"');
  });
  it('общие запреты письма — на месте', () => {
    expect(system!.content).toContain('Никаких длинных тире');
    expect(system!.content).toContain('диплом');
  });
  it('в user — пост, ссылка, название чата', () => {
    expect(user!.content).toContain('https://t.me/workayte/7');
    expect(user!.content).toContain('Работа в ИТ');
    expect(user!.content).toContain('Нужен BPMN');
  });
});

describe('isUsableDm', () => {
  it('годное — null', () => {
    expect(isUsableDm('Здравствуйте! Пишу по вакансии системного аналитика https://t.me/workayte/7. Делал BPMN-схемы. Резюме во вложении.', V)).toBeNull();
  });
  it('без ссылки на пост — негодно', () => {
    expect(isUsableDm('Здравствуйте! Хочу к вам. Резюме во вложении.', V)).toMatch(/ссылк/);
  });
  it('длиннее предела — негодно', () => {
    expect(isUsableDm(`https://t.me/workayte/7 ${'а'.repeat(DM_MAX_LENGTH)}`, V)).toMatch(/длин/);
  });
  it('выдуманный навык — негодно', () => {
    expect(isUsableDm('https://t.me/workayte/7 Писал оконные функции.', V)).toMatch(/оконные функции/);
  });
});

describe('generateDm', () => {
  it('негодный ответ пропускается, годный возвращается с mode dm', async () => {
    process.env['OPENROUTER_API_KEY'] = 'k';
    const answers = ['Без ссылки', 'Здравствуйте! По вакансии https://t.me/workayte/7 — делал BPMN. Резюме во вложении.'];
    const r = await generateDm({ vacancy: V, resume: 'R', role: 'Системный аналитик' }, {
      models: ['m'], attemptsPerModel: 2,
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: answers.shift() } }] })),
    });
    expect(r.mode).toBe('dm');
    expect(r.letter).toContain('https://t.me/workayte/7');
  });
});
```

Run: `npx vitest run tests/dm.test.ts` — Expected: FAIL.

- [ ] **Step 2: dm.ts**

В `src/core/letter.ts` вынеси общие строки правил в экспортируемую константу `COMMON_WRITING_RULES` (все пункты `WRITING_RULES`, кроме «Не начинай с упоминания…», «Не заканчивай… "Резюме прикреплено"» и пункта про стажировку), а `WRITING_RULES` собери как `COMMON_WRITING_RULES` + эти три пункта в прежнем порядке — текст промпта писем не должен измениться ни на символ (проверь: `buildPrompt` до и после даёт одинаковую строку; добавь такой тест в `tests/letter.test.ts`, сравнив со снимком строки, взятым до правки).

`src/core/dm.ts`:

```ts
import type { Vacancy } from './vacancy.js';
import { complete, type ChatMessage, type CompletionOptions } from './openrouter.js';
import { COMMON_WRITING_RULES, findForbiddenClaim } from './letter.js';

/**
 * Первое личное сообщение рекрутёру в Telegram (спека 2026-09-18, 5.1). Не
 * сопроводительное письмо: у рекрутёра десятки вакансий, поэтому сначала —
 * какая именно и ссылка на пост, дальше коротко, почему подходишь. Часть
 * правил письма здесь неверна («не начинай с вакансии», «не заканчивай
 * „резюме прикреплено“») и не передаётся; запреты на выдумки и обороты —
 * общие.
 */

export const DM_MAX_LENGTH = 1200;

const INSTRUCTION = (role: string): string => `Ты помогаешь кандидату написать первое личное сообщение
рекрутёру в Telegram по вакансии (специальность «${role}»).
Сообщение короткое:
- первой фразой назови вакансию и дай ссылку на пост — у рекрутёра их много;
- потом 2–3 предложения о том, почему он подходит: конкретный проект, инструмент или цифра из резюме,
  привязанные к тому, что просит вакансия;
- в конце — что резюме во вложении, и короткий вопрос или просьба.
Обращение «Здравствуйте!» без имени. Подпись «Артём». Не длиннее ${DM_MAX_LENGTH} символов.
Опирайся только на факты из резюме — ничего не выдумывай. Верни только текст сообщения.

${COMMON_WRITING_RULES}`;

export function buildDmMessages(input: { vacancy: Vacancy; resume: string; role: string }): ChatMessage[] {
  const v = input.vacancy;
  return [
    { role: 'system', content: `${INSTRUCTION(input.role)}\n\n=== РЕЗЮМЕ ===\n${input.resume}` },
    {
      role: 'user',
      content: [
        `Вакансия: ${v.title}`,
        `Ссылка на пост: ${v.url}`,
        v.channel === null ? '' : `Чат: ${v.channel}`,
        '',
        '=== ТЕКСТ ПОСТА ===',
        v.description,
      ].filter((s) => s !== '').join('\n'),
    },
  ];
}

export function isUsableDm(text: string, vacancy: Vacancy): string | null {
  const t = text.trim();
  if (t === '') return 'пустой ответ';
  if (t.length > DM_MAX_LENGTH) return `длиннее ${DM_MAX_LENGTH} символов`;
  if (!t.includes(vacancy.url)) return 'нет ссылки на пост';
  const claim = findForbiddenClaim(t);
  if (claim !== null) return `выдуман навык: ${claim}`;
  return null;
}

export async function generateDm(
  input: { vacancy: Vacancy; resume: string; role: string },
  options: CompletionOptions,
): Promise<{ letter: string; mode: 'dm' | 'none'; failure?: string }> {
  const r = await complete(buildDmMessages(input), options, (text) => isUsableDm(text, input.vacancy));
  return r.ok ? { letter: r.text.trim(), mode: 'dm' } : { letter: '', mode: 'none', failure: r.failure };
}
```

- [ ] **Step 3: Проводка**

В `src/cli.ts`:
- `SearchCommandDeps` и `FillLettersDeps` — поле `generateDmFn: typeof generateDm` (в `main()` — `generateDm`; в тестах cli — подставной).
- `generate` в `runSearchCommand`: первой строкой

```ts
      if (v.source === 'tg') {
        const result = await deps.generateDmFn(
          { vacancy: v, resume: deps.resumeFor(specialty), role: specialty.name },
          { models: deps.config.letterModels },
        );
        if (result.mode === 'none') { emptyLetters++; letterFailure = result.failure ?? letterFailure; }
        return result;
      }
```

- то же в `fillEmptyLetters` для `row.source === 'tg'` (`setLetter(row.id, result.letter, 'dm')`).
- в `tests/cli.test.ts` добавь тест: вакансия `source: 'tg'` уходит в `generateDmFn`, а не в `generateLetterFn`, с резюме и ролью специальности.

Run: `npx tsc --noEmit && npx vitest run` — Expected: PASS.

```bash
git add src/core/dm.ts src/core/letter.ts src/cli.ts tests/dm.test.ts tests/letter.test.ts tests/cli.test.ts
git commit -m "feat: a short first message to the recruiter, with the post link and no invented skills"
```

---

### Task 6: Отправка в Telegram

**Files:**
- Modify: `src/adapters/types.ts`, `src/adapters/telegram.ts`, `src/core/sender.ts`, `src/cli.ts`, `src/ui/panel.html` (`buildSendResultText`), `config.json`, `tests/telegram-adapter.test.ts`, `tests/sender.test.ts`, `tests/panel-html.test.ts`

**Interfaces:**
- Produces:
  - `ApplyResult`: `| { status: 'account_limited' }` и `{ status: 'sent'; warning?: string }`; `isHaltingResult` включает `account_limited`.
  - `Adapter.apply(vacancy, letter, ctx?: { specialty: string })`.
  - `HaltReason`: + `'account_limited'`.
  - `SendReport.deferredContacts: Array<{ contact: string; until: number; title: string }>`, `SendReport.warnings: string[]`.
  - `CONTACT_COOLDOWN_MS = 7 * 86_400_000` (sender.ts, экспорт).
  - `TelegramAdapterOptions.sender?: () => Promise<TgSender | { error: string }>`, `resumePdf?: (specialtyId: string) => string | null`.

- [ ] **Step 1: Тесты адаптера (apply)**

В `tests/telegram-adapter.test.ts` добавь:

```ts
describe('TelegramAdapter.apply', () => {
  const V = normalizeVacancy({
    source: 'tg', sourceId: '-1001:7', title: 'Системный аналитик', company: '', url: 'https://t.me/workayte/7',
    description: 'd', geo: '', postedAt: '2026-09-19T00:00:00Z', contact: 'hr_person', channel: 'Работа в ИТ',
  });

  function mkSender(over: Partial<TgSender> = {}) {
    const log: string[] = [];
    const sender: TgSender = {
      async resolvePeer(u) { log.push(`resolve ${u}`); return { kind: 'user', username: u }; },
      async sendText(u, t) { log.push(`text ${u} ${t.slice(0, 10)}`); },
      async sendFile(u, p) { log.push(`file ${u} ${p}`); },
      ...over,
    };
    return { sender, log };
  }
  function adapterWith(sender: TgSender | { error: string }, pdf: string | null = 'C:/cv.pdf') {
    return new TelegramAdapter({
      reader: async () => ({ error: 'не нужен' }), queue: { getTgCursor: () => 0, setTgCursor: () => {} },
      chats: () => [], firstReadDays: () => 14, titleWords: () => [],
      sender: async () => sender, resumePdf: () => pdf, sleep: async () => {},
    });
  }

  it('человек — текст, затем PDF специальности', async () => {
    const { sender, log } = mkSender();
    expect(await adapterWith(sender).apply(V, 'Здравствуйте! …', { specialty: 'ba' })).toEqual({ status: 'sent' });
    expect(log).toEqual(['resolve hr_person', 'text hr_person Здравствуй', 'file hr_person C:/cv.pdf']);
  });

  it.each(['bot', 'channel', 'group'] as const)('%s вместо человека — failed, ничего не отправлено', async (kind) => {
    const { sender, log } = mkSender({ async resolvePeer(u) { return { kind, username: u }; } });
    const r = await adapterWith(sender).apply(V, 'x', { specialty: 'ba' });
    expect(r).toMatchObject({ status: 'failed' });
    expect(r.status === 'failed' && r.reason).toMatch(/вручную/);
    expect(log.some((l) => l.startsWith('text'))).toBe(false);
  });

  it('текст ушёл, файл нет — sent с предупреждением (текст не вернуть)', async () => {
    const { sender } = mkSender({ async sendFile() { throw new Error('upload failed'); } });
    const r = await adapterWith(sender).apply(V, 'x', { specialty: 'ba' });
    expect(r).toMatchObject({ status: 'sent' });
    expect(r.status === 'sent' && r.warning).toMatch(/резюме не приложилось/);
  });

  it('нет PDF у специальности — только текст, с предупреждением', async () => {
    const { sender, log } = mkSender();
    const r = await adapterWith(sender, null).apply(V, 'x', { specialty: 'ba' });
    expect(r.status === 'sent' && r.warning).toMatch(/PDF/);
    expect(log.some((l) => l.startsWith('file'))).toBe(false);
  });

  it.each([
    ['PEER_FLOOD', 'account_limited'],
    ['USER_PRIVACY_RESTRICTED', 'failed'],
    ['USERNAME_NOT_OCCUPIED', 'failed'],
    ['AUTH_KEY_UNREGISTERED', 'auth_required'],
  ])('%s → %s', async (code, status) => {
    const { sender } = mkSender({ async sendText() { throw new errors.RPCError(code, {} as never, 400); } });
    expect((await adapterWith(sender).apply(V, 'x', { specialty: 'ba' })).status).toBe(status);
  });

  it('FloodWait до 60 с — ждём и повторяем; дольше — account_limited', async () => {
    let n = 0;
    const { sender } = mkSender({ async sendText() { if (n++ === 0) throw new errors.FloodWaitError({ request: {} as never, capture: 20 }); } });
    expect((await adapterWith(sender).apply(V, 'x', { specialty: 'ba' })).status).toBe('sent');
    const b = mkSender({ async sendText() { throw new errors.FloodWaitError({ request: {} as never, capture: 3600 }); } });
    expect((await adapterWith(b.sender).apply(V, 'x', { specialty: 'ba' })).status).toBe('account_limited');
  });

  it('Telegram не подключён — auth_required с причиной-ошибкой не путается: failed не ставится', async () => {
    expect((await adapterWith({ error: 'Telegram не подключён' }).apply(V, 'x', { specialty: 'ba' })).status).toBe('auth_required');
  });

  it('вакансия без контакта — failed «контакт не найден»', async () => {
    const { sender } = mkSender();
    const r = await adapterWith(sender).apply({ ...V, contact: null }, 'x', { specialty: 'ba' });
    expect(r).toMatchObject({ status: 'failed' });
  });
});
```

(Импорты в шапке файла: `normalizeVacancy`, `type TgSender`.)

- [ ] **Step 2: Реализация apply**

`src/adapters/types.ts`:

```ts
export type ApplyResult =
  | { status: 'sent'; warning?: string }
  | { status: 'already_applied' }
  | { status: 'captcha' }
  | { status: 'auth_required' }
  /** Площадка ограничила аккаунт (Telegram: PEER_FLOOD, долгий FloodWait). Останавливает площадку. */
  | { status: 'account_limited' }
  | { status: 'failed'; reason: string };

export interface ApplyContext {
  /** id специальности строки очереди — по нему Telegram находит PDF резюме. */
  specialty: string;
}

export interface Adapter {
  readonly name: string;
  readonly queryless?: boolean;
  search(filters: SearchFilters): Promise<Vacancy[]>;
  apply(vacancy: Vacancy, letter: string, ctx?: ApplyContext): Promise<ApplyResult>;
}

export function isHaltingResult(r: ApplyResult): boolean {
  return r.status === 'captcha' || r.status === 'auth_required' || r.status === 'account_limited';
}
```

`src/adapters/telegram.ts` — в опции `sender?`, `resumePdf?`; замени заглушку `apply`:

```ts
  async apply(vacancy: Vacancy, letter: string, ctx?: ApplyContext): Promise<ApplyResult> {
    if (vacancy.contact === null) return { status: 'failed', reason: 'у вакансии нет контакта — напиши вручную' };
    const sender = await (this.opts.sender?.() ?? Promise.resolve({ error: 'отправка в Telegram не подключена' }));
    // Не подключён Telegram — не вина вакансии: строка остаётся approved,
    // площадка останавливается, как при разлогиненном hh.
    if ('error' in sender) return { status: 'auth_required' };

    const username = vacancy.contact;
    const attempt = async <T>(f: () => Promise<T>): Promise<T | TgFailure> => {
      for (let i = 0; i < 2; i++) {
        try { return await f(); } catch (e) {
          const failure = classifyTgError(e);
          if (failure.kind === 'flood_wait' && failure.seconds <= MAX_FLOOD_WAIT_S && i === 0) {
            await this.sleep(failure.seconds * 1000);
            continue;
          }
          return failure;
        }
      }
      return { kind: 'other', message: 'повтор не помог' };
    };
    const isFailure = (x: unknown): x is TgFailure => typeof x === 'object' && x !== null && 'kind' in x;
    const toResult = (f: TgFailure): ApplyResult => {
      if (f.kind === 'peer_flood' || f.kind === 'flood_wait') return { status: 'account_limited' };
      if (f.kind === 'auth') return { status: 'auth_required' };
      return { status: 'failed', reason: describeTgFailure(f) };
    };

    const peer = await attempt(() => sender.resolvePeer(username));
    if (isFailure(peer)) return toResult(peer);
    if (peer.kind !== 'user') {
      return { status: 'failed', reason: `@${username} — ${peer.kind === 'bot' ? 'бот' : 'канал или группа'}, а не человек — напиши вручную` };
    }

    const sent = await attempt(() => sender.sendText(username, letter));
    if (isFailure(sent)) return toResult(sent);

    // Текст уже у рекрутёра: что бы ни случилось с файлом, это «отправлено».
    const pdf = ctx === undefined ? null : (this.opts.resumePdf?.(ctx.specialty) ?? null);
    if (pdf === null) return { status: 'sent', warning: 'у специальности нет PDF резюме — ушёл только текст' };
    const file = await attempt(() => sender.sendFile(username, pdf));
    if (isFailure(file)) return { status: 'sent', warning: `резюме не приложилось: ${describeTgFailure(file)}` };
    return { status: 'sent' };
  }
```

(`import type { TgFailure } …`, `import type { ApplyContext } …`, `TgSender` в типы опций.)

Run: `npx vitest run tests/telegram-adapter.test.ts` — Expected: PASS.

- [ ] **Step 3: Sender — тесты**

В `tests/sender.test.ts` добавь (используй хелперы файла для очереди и конфига; для Telegram — строка `source: 'tg'` с `contact`):

```ts
describe('Sender — Telegram', () => {
  // mkTgRow(q, id, contact) — вставить pending tg-вакансию с контактом и одобрить её
  it('контакту писали за 7 дней — строка остаётся approved, в отчёте «отложено до»', async () => { /* … */ });
  it('account_limited останавливает только tg, hh продолжает', async () => { /* … */ });
  it('sent с warning — строка sent, предупреждение в отчёте', async () => { /* … */ });
  it('apply получает специальность строки', async () => { /* … */ });
});
```

Каждый тест написать полностью по образцу существующих в файле (фейковый адаптер с `apply` → заданный результат; `throttle: { tg: { minDelayMs: 0, maxDelayMs: 0 }, hh: { … } }`; `sleep: async () => {}`). Проверяемое:
1. Строка A (`hr_a`) — `sent` сейчас; строка B (`hr_a`) — `approved`. После `run()`: B осталась `approved`, `adapter.apply` не вызывался, `report.deferredContacts[0]` = `{ contact: 'hr_a', until: sentAt + 7 дней, title }`.
2. tg-адаптер отвечает `account_limited`; hh-строка после неё отправлена; `report.haltedSources` содержит `{ source: 'tg', reason: 'account_limited' }`; tg-строка осталась `approved`.
3. `{ status: 'sent', warning: 'резюме не приложилось: …' }` — строка `sent`, `report.warnings` содержит «резюме не приложилось» и заголовок.
4. `apply` третьим аргументом получил `{ specialty: <specialty строки> }`.

Run: `npx vitest run tests/sender.test.ts` — Expected: FAIL.

- [ ] **Step 4: Sender — реализация**

В `src/core/sender.ts`:
- `HaltReason` += `'account_limited'`; `SendReport` += `deferredContacts`, `warnings` (инициализация `[]`).
- `export const CONTACT_COOLDOWN_MS = 7 * DAY;`
- перед вызовом `apply`, после проверки пустого письма:

```ts
      // Одному человеку — не чаще раза в 7 дней (спека 5.5). Строка не уходит
      // в failed (оттуда нет выхода), а ждёт: следующий прогон после срока
      // отправит её сам.
      if (row.contact !== null) {
        const last = this.queue.lastContactAt(row.contact);
        if (last !== null && last.status === 'sent' && this.now() - last.at < CONTACT_COOLDOWN_MS) {
          report.deferredContacts.push({ contact: row.contact, until: last.at + CONTACT_COOLDOWN_MS, title: row.vacancy.title });
          continue;
        }
      }

      const result = await adapter.apply(row.vacancy, row.letter, { specialty: row.specialty });
```

- останавливающие статусы: `if (result.status === 'captcha' || result.status === 'auth_required' || result.status === 'account_limited')`.
- на `sent` с `warning`: `report.warnings.push(\`${row.vacancy.title}: ${result.warning}\`)`.

`src/cli.ts`:
- `explainHalt`: `case 'account_limited': return \`площадка ${halted.source}: аккаунт ограничен (Telegram: PEER_FLOOD или долгий FloodWait). Первые сообщения незнакомым сейчас не проходят — подожди сутки, строки остались approved.\`;`
- `formatSendResult`: строки для `deferredContacts` («Отложено до ДД.ММ: @контакт — заголовок») и `warnings` («ВНИМАНИЕ: …»).
- `buildAdapters()` пока без изменений; Telegram подключается в Task 7.

`src/ui/panel.html#buildSendResultText`: добавь «отложено N (писали за 7 дней)» и предупреждения; тест в `tests/panel-html.test.ts`.

`config.json` → `throttle`: `"tg": { "maxPerDay": 40, "minDelayMs": 60000, "maxDelayMs": 180000 }`.

Run: `npx tsc --noEmit && npx vitest run` — Expected: PASS.

```bash
git add src/adapters src/core/sender.ts src/cli.ts src/ui/panel.html config.json tests/telegram-adapter.test.ts tests/sender.test.ts tests/panel-html.test.ts
git commit -m "feat: send the first message and the resume in Telegram, once a week per recruiter at most"
```

---

### Task 7: Telegram в панели и в командах

**Files:**
- Modify: `src/cli.ts`, `src/ui/server.ts`, `src/ui/panel.html`, `tests/ui-server.test.ts`, `tests/panel-browser.test.ts`

**Interfaces:**
- Consumes: `openTelegram` (Task 1), `TelegramAdapter` (Tasks 4, 6), `Settings.telegram` (Task 3).
- Produces:
  - `PanelDeps.telegram?: { dialogs(): Promise<{ ok: true; chats: TgChat[] } | { ok: false; error: string }>; resolve(ref: string): Promise<{ ok: true; chat: TgChat } | { ok: false; error: string }> }`
  - Ручки: `GET /api/telegram/dialogs`, `POST /api/telegram/resolve {ref}` → `200 {chats}|{chat}` или `502 {error}`; без зависимости — `409`.
  - `GET /api/pending` и `GET /api/approved` — к каждой строке с `contact` добавлено `contactWarning: string | null` («ты писал @x N дней назад по вакансии Y»/«@x уже в очереди по вакансии Y»).
  - cli: `openTelegramLazily(): { reader(): Promise<TgReader | {error}>; sender(): Promise<TgSender | {error}>; close(): Promise<void> }` — одна сессия на процесс, поднимается при первом обращении.

- [ ] **Step 1: Тесты сервера**

В `tests/ui-server.test.ts`:

```ts
describe('панель — Telegram', () => {
  it('dialogs и resolve — отдаются, ошибки — 502 с причиной, без зависимости — 409', async () => { /* … */ });
  it('строка с контактом, которому писали 2 дня назад, приходит с contactWarning', async () => { /* … */ });
});
```

Написать полностью: `startPanel(q, 0, { telegram: { dialogs: async () => ({ ok: true, chats: [CHAT] }), resolve: async (ref) => ref === 'bad' ? { ok: false, error: 'не найден' } : { ok: true, chat: CHAT } } })`; для предупреждения — вставить и отправить tg-строку с `hr_a` (`approve` → `markSent`), вставить вторую pending с `hr_a`, `GET /api/pending` → у неё `contactWarning` содержит `@hr_a` и заголовок первой.

- [ ] **Step 2: Сервер**

В `src/ui/server.ts`:
- `PanelDeps.telegram` (как в Interfaces), ручки `/api/telegram/dialogs` (GET) и `/api/telegram/resolve` (POST), 409 без зависимости, 502 на `{ ok: false }`.
- `/api/pending` и `/api/approved`: `queue.listByStatus(…).map(withContactWarning)`, где

```ts
function withContactWarning(queue: Queue) {
  return (row: QueueRow) => {
    if (row.contact === null) return { ...row, contactWarning: null };
    const last = queue.lastContactAt(row.contact);
    // Сама строка тоже «последняя с контактом» — её не считаем.
    if (last === null || (last.status !== 'sent' && last.title === row.vacancy.title)) return { ...row, contactWarning: null };
    const days = Math.floor((Date.now() - last.at) / 86_400_000);
    const when = last.status === 'sent' ? `ты писал @${row.contact} ${days === 0 ? 'сегодня' : `${days} дн. назад`}` : `@${row.contact} уже в очереди`;
    return { ...row, contactWarning: `${when} по вакансии «${last.title}»` };
  };
}
```

- [ ] **Step 3: Панель**

В `src/ui/panel.html`:
- карточка (`renderPending`, `renderApproved`): если `r.contact` — строка `Telegram: @${r.contact} · ${r.vacancy.channel ?? ''} · <a href="${r.vacancy.url}" target="_blank">пост</a>`; если `r.contactWarning` — плашка того же цвета, что `#proxyWarn`, с текстом предупреждения; письмо с `letterMode === 'dm'` подписано «сообщение рекрутёру» вместо «письмо».
- вкладка «Настройки», блок «Telegram» после стоп-слов:

```html
    <div class="settings-block" id="tgBlock">
      <strong>Telegram</strong>
      <span class="hint">каналы и группы, где искать. Нужен VPN и вход: npm run tg:login.</span>
      <div id="tgChats"></div>
      <div class="actions" style="padding-left:0">
        <input type="text" id="tgRef" placeholder="@канал или ссылка t.me" size="28">
        <button id="tgAdd">Добавить</button>
        <button id="tgPick">Выбрать из моих чатов</button>
        <label>Глубина первого чтения, дней <input type="number" id="tgDays" min="1" max="90" step="1"></label>
      </div>
      <div id="tgPicker"></div>
      <span class="hint" id="tgNote"></span>
    </div>
```

- скрипт: `renderSettings` заполняет `#tgChats` строками `<label><input type="checkbox" data-chat-id=… checked> Название (@username, канал/группа)</label> <button class="del-chat">×</button>` и `#tgDays`; `collectSettings` собирает `telegram: { chats, firstReadDays }` из этих строк (id, title, username, kind из `data-*`) и сохраняет `autoApply` из загруженных настроек как есть (тумблер — Task 8); «Добавить» → `POST /api/telegram/resolve` → добавляет строку; «Выбрать из моих чатов» → `GET /api/telegram/dialogs` → список чекбоксов в `#tgPicker` с кнопкой «Добавить отмеченные»; ошибки — в `#tgNote` текстом сервера.
- тест в `tests/panel-browser.test.ts`: выбор из подставных чатов добавляет чат, сохранение кладёт его в `stored.telegram.chats`; ошибка resolve показывается в `#tgNote`.

- [ ] **Step 4: Проводка в cli.ts**

- `openTelegramLazily()`: один `openTelegram()` на процесс по первому обращению к `reader()`/`sender()`, результат запоминается; `{ ok: false }` превращается в `{ error: message }`.
- `buildAdapters(settingsGetter, queue, tg)`: добавь `new TelegramAdapter({ reader: tg.reader, sender: tg.sender, queue, chats: () => settingsGetter().telegram.chats, firstReadDays: () => settingsGetter().telegram.firstReadDays, titleWords: () => enabledSpecialties(settingsGetter()).flatMap((s) => s.titleWords), resumePdf: (id) => specialtyOf(settingsGetter(), id).resumePdf })`. Сигнатура `buildAdapters` меняется — поправь вызовы в `panel`, `search`, `send` и `tests/cli.test.ts` (тест «buildAdapters собирает все площадки» ожидает `['hh', 'hrge', 'careerist', 'tg']`).
- `runSearchCommand` → `runSearch({ …, specialties: enabledSpecialties(settings) })` — поле `specialties` в `SearchCommandDeps`.
- `panel`: `telegram: { dialogs: async () => …tg.reader() → reader.dialogs(), resolve: async (ref) => …reader.resolveChat(ref) }` с переводом ошибок через `classifyTgError`/`describeTgFailure`.
- Telegram-адаптер без чатов в настройках не поднимает сессию вовсе (`search` выходит до `reader()`), так что поиск без Telegram работает, как раньше.

Run: `npx tsc --noEmit && npx vitest run` — Expected: PASS.

```bash
git add src/cli.ts src/ui/server.ts src/ui/panel.html tests/ui-server.test.ts tests/panel-browser.test.ts tests/cli.test.ts
git commit -m "feat: pick Telegram chats in the panel; cards show the recruiter and warn about repeat contacts"
```

---

### Task 8: Автоотклик

**Files:**
- Create: `src/core/autoapply.ts`, `tests/autoapply.test.ts`
- Modify: `src/cli.ts`, `src/ui/server.ts`, `src/ui/panel.html`, `scripts/run.ps1`, `.claude/skills/jobs/SKILL.md`, `docs/superpowers/specs/2026-08-27-job-autoapply-design.md`, `tests/ui-server.test.ts`, `tests/panel-browser.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: `Queue.listByStatus`, `approve(id, undefined, 'auto')`, `lastContactAt`, `QueueRow.createdAt` (Task 3); `CONTACT_COOLDOWN_MS` (Task 6); `Settings.autoApply`.
- Produces:
  - `autoapply.ts`: `type AutoSkipReason = 'empty_letter' | 'below_threshold' | 'recent_contact'`; `selectAutoApprovals(rows: QueueRow[], opts: { minScore: number; recentContact: (contact: string, rowId: number) => boolean }): { approve: number[]; skipped: Array<{ id: number; reason: AutoSkipReason }> }`; `autoApproveAfterSearch(queue: Queue, since: number, settings: Settings, config: Config, now?: () => number): { approved: number; skipped: Array<{ id: number; reason: AutoSkipReason }> }`.
  - `/api/sent` → строки `sent` за 30 дней, с `approvedBy`.
  - cli: `runSearchCommand` возвращает ещё `autoApproved: number` и, при включённом автоотклике, запускает `Sender` (в панели — через тот же `send`-стейт, что кнопка).

- [ ] **Step 1: Тест выбора**

`tests/autoapply.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { selectAutoApprovals } from '../src/core/autoapply.js';
import type { QueueRow } from '../src/core/queue.js';

function row(over: Partial<QueueRow>): QueueRow {
  return {
    id: 1, source: 'hh', sourceId: '1', vacancy: {} as never, score: 60, matched: [], letter: 'письмо',
    letterMode: 'hybrid', status: 'pending', error: null, specialty: 'business-analyst', contact: null,
    approvedBy: null, createdAt: 0, sentAt: null, ...over,
  };
}
const NONE = { minScore: 40, recentContact: () => false };

describe('selectAutoApprovals (спека 7.2)', () => {
  it('годная строка одобряется', () => {
    expect(selectAutoApprovals([row({})], NONE)).toEqual({ approve: [1], skipped: [] });
  });
  it('пустое письмо и mode none — нет', () => {
    const r = selectAutoApprovals([row({ id: 1, letter: '  ' }), row({ id: 2, letterMode: 'none', letter: '' })], NONE);
    expect(r.approve).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual(['empty_letter', 'empty_letter']);
  });
  it('скор ниже порога автоотклика — нет', () => {
    expect(selectAutoApprovals([row({ score: 50 })], { ...NONE, minScore: 55 }).skipped[0]!.reason).toBe('below_threshold');
  });
  it('контакт за 7 дней — нет', () => {
    const r = selectAutoApprovals([row({ contact: 'hr' })], { ...NONE, recentContact: () => true });
    expect(r.skipped[0]!.reason).toBe('recent_contact');
  });
  it('два поста одного рекрутёра в одном прогоне — одобряется только первый по скору', () => {
    const r = selectAutoApprovals(
      [row({ id: 1, contact: 'hr', score: 50 }), row({ id: 2, contact: 'hr', score: 70 })],
      NONE,
    );
    expect(r.approve).toEqual([2]);
    expect(r.skipped).toEqual([{ id: 1, reason: 'recent_contact' }]);
  });
});
```

`autoApproveAfterSearch` — отдельный тест на настоящей очереди в `tmp`: автоотклик выключен — не трогает ничего; включён — одобряет только строки с `createdAt >= since`, с `approvedBy === 'auto'`; `minScore: null` берёт `config.minScore`; строка, чьему контакту писали 3 дня назад, остаётся `pending`.

Run: `npx vitest run tests/autoapply.test.ts` — Expected: FAIL.

- [ ] **Step 2: autoapply.ts**

```ts
import type { Queue, QueueRow } from './queue.js';
import type { Settings } from './settings.js';
import type { Config } from './config.js';
import { CONTACT_COOLDOWN_MS } from './sender.js';

/**
 * Автоотклик (спека 2026-09-18, раздел 7). Решение владельца от 2026-09-18:
 * при включённом тумблере поиск сам одобряет прошедшее фильтры, и отправка
 * идёт без его взгляда. Это отменяет «полностью автономная отправка — вне
 * скоупа навсегда» из дизайна 2026-08-27.
 *
 * Не одобряется автоматически и ждёт человека (7.2): пустое письмо (модель
 * не ответила, VPN выключен); скор ниже порога автоотклика; контакт, которому
 * писали за 7 дней или которому уже пишем в этом прогоне. Проверку на
 * выдуманные факты письмо уже прошло при генерации: непрошедшее не
 * возвращается моделью, и строка остаётся с пустым письмом.
 */

export type AutoSkipReason = 'empty_letter' | 'below_threshold' | 'recent_contact';

export function selectAutoApprovals(
  rows: QueueRow[],
  opts: { minScore: number; recentContact: (contact: string, rowId: number) => boolean },
): { approve: number[]; skipped: Array<{ id: number; reason: AutoSkipReason }> } {
  const approve: number[] = [];
  const skipped: Array<{ id: number; reason: AutoSkipReason }> = [];
  const takenContacts = new Set<string>();
  for (const r of [...rows].sort((a, b) => b.score - a.score || a.id - b.id)) {
    if (r.letter.trim() === '' || r.letterMode === 'none') { skipped.push({ id: r.id, reason: 'empty_letter' }); continue; }
    if (r.score < opts.minScore) { skipped.push({ id: r.id, reason: 'below_threshold' }); continue; }
    if (r.contact !== null) {
      if (takenContacts.has(r.contact) || opts.recentContact(r.contact, r.id)) {
        skipped.push({ id: r.id, reason: 'recent_contact' });
        continue;
      }
      takenContacts.add(r.contact);
    }
    approve.push(r.id);
  }
  approve.sort((a, b) => a - b);
  return { approve, skipped: skipped.sort((a, b) => a.id - b.id) };
}

export function autoApproveAfterSearch(
  queue: Queue, since: number, settings: Settings, config: Config, now: () => number = Date.now,
): { approved: number; skipped: Array<{ id: number; reason: AutoSkipReason }> } {
  if (!settings.autoApply.enabled) return { approved: 0, skipped: [] };
  const fresh = queue.listByStatus('pending').filter((r) => r.createdAt >= since);
  const { approve, skipped } = selectAutoApprovals(fresh, {
    minScore: settings.autoApply.minScore ?? config.minScore,
    recentContact: (contact) => {
      const last = queue.lastContactAt(contact);
      return last !== null && last.status === 'sent' && now() - last.at < CONTACT_COOLDOWN_MS;
    },
  });
  for (const id of approve) queue.approve(id, undefined, 'auto');
  return { approved: approve.length, skipped };
}
```

Run: `npx vitest run tests/autoapply.test.ts` — Expected: PASS.

- [ ] **Step 3: Поиск → автоодобрение → отправка**

`src/cli.ts`:
- `runSearchCommand`: запомни `const startedAt = Date.now()` до `runSearch`; после — `const auto = autoApproveAfterSearch(deps.queue, startedAt, deps.settings, deps.config)`; верни `autoApproved: auto.approved, autoSkipped: auto.skipped.length`. Поле `settings: Settings` в `SearchCommandDeps`.
- команда `search`: если `settings.autoApply.enabled` и `autoApproved > 0` — `clearStop()`, `new Sender(queue, adapterMap, config).run()`, печать `formatSendResult`. Перед поиском, если включён, печать крупно: `АВТООТКЛИК ВКЛЮЧЁН — поиск отправляет отклики без одобрения. Выключить: вкладка «Настройки».`
- `formatSearchReport` — строка `Автоотклик: одобрено N, оставлено на просмотр M`.

`src/ui/server.ts`:
- `startSearch` в панели возвращает `autoApproved`; после завершения поиска, если `autoApproved > 0` и отправка не идёт — сервер запускает тот же код, что `/api/send/start` (вынеси его тело в функцию `startSend()`), с пометкой `send.origin = 'auto'`.
- `/api/settings` POST: если `autoApply.enabled` было `true`, стало `false`, и идёт отправка с `origin === 'auto'` — `requestStop()` (спека 7.3).
- `GET /api/sent` → `queue.listSentSince(Date.now() - 30 * 86_400_000)`.
- `GET /api/settings` уже отдаёт `autoApply`; баннер панель рисует сама.

`src/ui/panel.html`:
- вкладка «Отправлено» (`#tab-sent`/`#pane-sent`, в `TABS`): строки — дата отправки, площадка, заголовок, контакт, пометка «авто»/«вручную», раскрывающийся текст письма.
- в шапке `<div id="autoBanner" hidden>АВТООТКЛИК ВКЛЮЧЁН — поиск отправляет отклики</div>` (красный фон, белый текст, жирный), показывается по `settings.autoApply.enabled` при загрузке и после сохранения.
- во вкладке «Настройки» блок «Автоотклик»: чекбокс `#autoApply` и поле `#autoMinScore` (пусто = общий порог). Включение чекбокса — через `confirm()` со списком из спеки 7.2/7.3/7.6 (что уйдёт без одобрения, что не уйдёт, что продолжает действовать, риски); отказ в `confirm` возвращает чекбокс в выключенное. Сохраняется общей кнопкой «Сохранить».
- тесты `tests/panel-browser.test.ts`: включение с `confirm` → `true` сохраняет `autoApply.enabled`; `dialog.dismiss()` оставляет выключенным; баннер виден при включённом; вкладка «Отправлено» показывает пометку «авто».

`scripts/run.ps1` — перед запуском поиска:

```powershell
$settingsPath = Join-Path $PSScriptRoot '..\data\settings.json'
if (Test-Path $settingsPath) {
  $s = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($s.autoApply -and $s.autoApply.enabled) {
    Write-Host ''
    Write-Host '  АВТООТКЛИК ВКЛЮЧЁН — поиск отправляет отклики без одобрения.' -ForegroundColor White -BackgroundColor DarkRed
    Write-Host '  Выключить: панель → «Настройки».' -ForegroundColor White -BackgroundColor DarkRed
    Write-Host ''
  }
}
```

- [ ] **Step 4: Документы**

- `.claude/skills/jobs/SKILL.md`, «Железные правила», пункт 1 дополни: «**При включённом автоотклике `search` — тоже отправка.** Перед любым запуском поиска прочитай `data/settings.json#autoApply.enabled`; если `true` — спроси пользователя явно, как перед `send`.» Раздел «Площадки»: Telegram — поиск в каналах и группах из настроек (нужен VPN и `npm run tg:login`), первое сообщение + PDF, лимит 40/сутки, пауза 1–3 мин, одному контакту раз в 7 дней, `PEER_FLOOD` останавливает Telegram. Команды: `npm run tg:login`.
- `docs/superpowers/specs/2026-08-27-job-autoapply-design.md`, раздел 2, после строки «полностью автономная отправка без подтверждения человеком;» — «> 2026-09-18: пересмотрено по решению владельца — тумблер «автоотклик», см. `2026-09-18-search-settings-telegram-autoapply-design.md`, раздел 7.»

Run: `npx tsc --noEmit && npx vitest run` — Expected: PASS.

```bash
git add src/core/autoapply.ts src/cli.ts src/ui/server.ts src/ui/panel.html scripts/run.ps1 .claude/skills/jobs/SKILL.md docs/superpowers/specs/2026-08-27-job-autoapply-design.md tests/autoapply.test.ts tests/ui-server.test.ts tests/panel-browser.test.ts tests/cli.test.ts
git commit -m "feat: auto-apply toggle — search approves what passed the filters and sends it"
```

---

### Task 9: Живой прогон с владельцем

Не код — контрольная точка. Ничего здесь не делается без владельца.

- [ ] Владелец получает `api_id`/`api_hash` на my.telegram.org, кладёт в `.env` (`TG_API_ID=…`, `TG_API_HASH=…`) и сам запускает `npm run tg:login` в своём терминале.
- [ ] Панель → «Настройки» → «Выбрать из моих чатов»: владелец отмечает чаты. Поиск с Telegram на небольшую цель (`5`). Проверить: чаты прочитаны, в отчёте видно «без контакта / не вакансия / репостов», карточки показывают контакт и ссылку на пост, письма режима `dm` осмысленны. Если разбор ошибается на живых постах — новые случаи в фикстуру (вымаранными) и правка `parse.ts` тестом.
- [ ] Первая живая отправка — одна вакансия, которую выберет владелец, после его явного «да» в чате. Проверить: текст и PDF дошли, строка `sent`, повторная отправка тому же контакту откладывается.
- [ ] Автоотклик — включает только владелец, в панели, через окно подтверждения.
