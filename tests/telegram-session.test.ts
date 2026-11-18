import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readTelegramKeys, readSession, writeSession, parseLoginArgs, isWorkSession, loginRefusal, SESSION_PATH,
} from '../src/telegram/session.js';

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
    expect(parseLoginArgs([])).toEqual({ sessionPath: SESSION_PATH, force: false });
    expect(SESSION_PATH).toBe('data/telegram.session');
  });

  it('--session путь и --session=путь — указанный файл', () => {
    expect(parseLoginArgs(['--session', 'data/telegram-interview.session']))
      .toEqual({ sessionPath: 'data/telegram-interview.session', force: false });
    expect(parseLoginArgs(['--session=data/telegram-interview.session']))
      .toEqual({ sessionPath: 'data/telegram-interview.session', force: false });
  });

  it('--force — разрешение перезаписать непустую рабочую сессию (I1)', () => {
    expect(parseLoginArgs(['--force'])).toEqual({ sessionPath: SESSION_PATH, force: true });
    expect(parseLoginArgs(['--session', 'x.session', '--force'])).toEqual({ sessionPath: 'x.session', force: true });
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

describe('isWorkSession', () => {
  it('тот же файл, что data/telegram.session, в любом написании; другой файл — нет', () => {
    for (const p of ['data/telegram.session', './data/telegram.session', 'data\\telegram.session', 'DATA/Telegram.session',
      resolve('data/telegram.session')]) {
      expect(isWorkSession(p)).toBe(true);
    }
    expect(isWorkSession('data/telegram-interview.session')).toBe(false);
    expect(isWorkSession('other/telegram.session')).toBe(false);
  });
});

describe('loginRefusal (I1: вход не перезаписывает рабочую сессию молча)', () => {
  const work = { sessionPath: SESSION_PATH, force: false };
  const personal = { sessionPath: 'data/telegram-interview.session', force: false };
  const has = (): boolean => true;
  const none = (): boolean => false;

  it('npm проглотил --session без «--» (npm_config_session) — отказ с правильной командой', () => {
    // `npm run tg:login --session=data/telegram-interview.session`: npm 11 берёт флаг себе,
    // скрипт аргументов не получает и писал бы рабочую сессию.
    const r = loginRefusal(work, { npm_config_session: 'data/telegram-interview.session' }, none);
    expect(r).toMatch(/npm run tg:login -- --session/);
    expect(r).toMatch(/npm_config_session/);
    expect(loginRefusal(personal, { npm_config_session: 'true' }, none)).not.toBeNull();
  });

  it('рабочая сессия уже есть и непустая — без --force отказ, с --force можно', () => {
    const r = loginRefusal(work, {}, has);
    expect(r).toMatch(/data\/telegram\.session/);
    expect(r).toMatch(/-- --force/);
    expect(r).toMatch(/-- --session data\/telegram-interview\.session/);
    expect(loginRefusal({ sessionPath: './data/telegram.session', force: false }, {}, has)).not.toBeNull();
    expect(loginRefusal({ ...work, force: true }, {}, has)).toBeNull();
  });

  it('рабочей сессии нет — вход в неё разрешён; сессию интервью можно перезаписывать', () => {
    expect(loginRefusal(work, {}, none)).toBeNull();
    expect(loginRefusal(personal, {}, has)).toBeNull();
  });
});
