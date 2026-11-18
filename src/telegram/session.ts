import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
 * Тот же файл, что рабочая сессия `data/telegram.session`? Путь сравнивается
 * целиком (resolve от текущего каталога), без регистра и с любыми косыми:
 * на Windows «DATA\Telegram.session» — тот же файл. Сомнение — «тот же».
 */
export function isWorkSession(path: string): boolean {
  const norm = (p: string): string => resolve(p.replace(/\\/g, '/')).replace(/\\/g, '/').toLowerCase();
  return norm(path) === norm(SESSION_PATH);
}

/**
 * Аргументы `npm run tg:login` (G1). Без них — рабочая сессия, как раньше;
 * `--session <путь>` или `--session=<путь>` — другой файл, например сессия
 * личного аккаунта для интервью; `--force` — разрешение перезаписать непустую
 * рабочую сессию (I1). Незнакомое — ошибка: опечатка во флаге иначе молча
 * перезаписала бы рабочую сессию личным аккаунтом.
 */
export function parseLoginArgs(argv: string[]): { sessionPath: string; force: boolean } | { error: string } {
  const usage = 'использование: npm run tg:login [-- --session <путь к файлу сессии>] [--force]';
  let sessionPath = SESSION_PATH;
  let force = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    let value: string | undefined;
    if (a === '--force') {
      force = true;
      continue;
    }
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
  return { sessionPath, force };
}

/**
 * Почему вход нельзя начинать (I1); null — можно. Два способа молча записать
 * личный аккаунт в рабочую сессию:
 * - `npm run tg:login --session=…` без «--»: npm 11 берёт флаг себе
 *   (`npm_config_session` в окружении), скрипт аргументов не получает и пишет
 *   `data/telegram.session`;
 * - вход без аргументов поверх живой рабочей сессии.
 * Первое — отказ всегда; второе — отказ, пока не сказано `-- --force`.
 */
export function loginRefusal(
  args: { sessionPath: string; force: boolean },
  env: NodeJS.ProcessEnv,
  hasSession: (path: string) => boolean,
): string | null {
  const swallowed = env['npm_config_session'];
  if (swallowed !== undefined) {
    return `npm принял --session как свой параметр (npm_config_session=${swallowed}), скрипт его не получил. `
      + 'Перед флагом нужен «--»: npm run tg:login -- --session <путь к файлу сессии>. Ничего не записано.';
  }
  if (!args.force && isWorkSession(args.sessionPath) && hasSession(args.sessionPath)) {
    return `${SESSION_PATH} уже есть — это рабочий аккаунт (поиск по каналам, письма рекрутёрам), перезаписывать его не буду. `
      + 'Вход в личный аккаунт для интервью: npm run tg:login -- --session data/telegram-interview.session. '
      + 'Если рабочая сессия протухла и входишь заново рабочим аккаунтом: npm run tg:login -- --force. Ничего не записано.';
  }
  return null;
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
