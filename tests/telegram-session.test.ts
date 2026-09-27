import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readTelegramKeys, readSession, writeSession, parseLoginArgs, SESSION_PATH } from '../src/telegram/session.js';

describe('readTelegramKeys', () => {
  it('оба ключа — числовой id и hash', () => {
    expect(readTelegramKeys({ TG_API_ID: '12345', TG_API_HASH: ' abc ' })).toEqual({ apiId: 12345, apiHash: 'abc' });
  });

  it.each([
    [{}],
    [{ TG_API_ID: '12345' }],
    [{ TG_API_ID: 'abc', TG_API_HASH: 'h' }],
    [{ TG_API_ID: '0', TG_API_HASH: 'h' }],
  ])('%j — ошибка с подсказкой, где взять', (env) => {
    const r = readTelegramKeys(env);
    expect('error' in r && r.error).toMatch(/my\.telegram\.org/);
  });
});

describe('readSession / writeSession', () => {
  it('нет файла или он пустой — null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaa-tg-'));
    expect(readSession(join(dir, 'нет.session'))).toBeNull();
    writeFileSync(join(dir, 'empty.session'), '  \n');
    expect(readSession(join(dir, 'empty.session'))).toBeNull();
  });

  it('записанное читается обратно, каталог создаётся', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'jaa-tg-')), 'sub', 'telegram.session');
    writeSession('1BVtsOK…', path);
    expect(readSession(path)).toBe('1BVtsOK…');
  });
});

describe('parseLoginArgs (G1: tg:login пишет и отдельную сессию личного аккаунта)', () => {
  it('без аргументов — рабочая сессия, как раньше', () => {
    expect(parseLoginArgs([])).toEqual({ sessionPath: SESSION_PATH });
    expect(SESSION_PATH).toBe('data/telegram.session');
  });

  it('--session путь и --session=путь — указанный файл', () => {
    expect(parseLoginArgs(['--session', 'data/telegram-interview.session']))
      .toEqual({ sessionPath: 'data/telegram-interview.session' });
    expect(parseLoginArgs(['--session=data/telegram-interview.session']))
      .toEqual({ sessionPath: 'data/telegram-interview.session' });
  });

  it('--session без пути, пустой путь или флаг вместо пути — ошибка с подсказкой', () => {
    for (const argv of [['--session'], ['--session', ''], ['--session='], ['--session', '--other']]) {
      const r = parseLoginArgs(argv);
      expect('error' in r && r.error).toMatch(/--session/);
    }
  });

  it('незнакомый аргумент — ошибка, а не молчаливая запись в рабочую сессию', () => {
    const r = parseLoginArgs(['data/telegram-interview.session']);
    expect('error' in r && r.error).toMatch(/data\/telegram-interview\.session/);
    expect('error' in parseLoginArgs(['--sesion', 'x'])).toBe(true);
  });
});
