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

/**
 * Аргументы `npm run tg:login` (G1). Без них — рабочая сессия, как раньше;
 * `--session <путь>` или `--session=<путь>` — другой файл, например сессия
 * личного аккаунта для интервью. Незнакомое — ошибка: опечатка во флаге иначе
 * молча перезаписала бы рабочую сессию личным аккаунтом.
 */
export function parseLoginArgs(argv: string[]): { sessionPath: string } | { error: string } {
  const usage = 'использование: npm run tg:login [-- --session <путь к файлу сессии>]';
  let sessionPath = SESSION_PATH;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    let value: string | undefined;
    if (a === '--session') {
      value = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--session=')) {
      value = a.slice('--session='.length);
    } else {
      return { error: `непонятный аргумент «${a}» — ${usage}` };
    }
    if (value === undefined || value.trim() === '' || value.startsWith('--')) {
      return { error: `после --session нужен путь к файлу — ${usage}` };
    }
    sessionPath = value.trim();
  }
  return { sessionPath };
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
