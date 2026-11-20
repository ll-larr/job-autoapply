import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CAREERIST_CABINET_URL, CAREERIST_LOGIN_URL, cabinetSaysLoggedIn, isCareeristLoggedIn,
} from '../src/core/careerist-login.js';
import { createHhLogin, type LoginPage } from '../src/core/hh-login.js';

const resp = (ok: boolean, url: string) => ({ ok: () => ok, url: () => url });

describe('вход на careerist: признак «вошёл»', () => {
  it('кабинет открылся на своём адресе — вошёл', () => {
    expect(cabinetSaysLoggedIn(resp(true, 'https://careerist.ru/responds/'))).toBe(true);
  });

  it.each([
    ['гостя увело на /no-access (200)', resp(true, 'https://careerist.ru/no-access')],
    ['гостя увело на вход', resp(true, 'https://careerist.ru/login.html')],
    ['гостя увело на регистрацию', resp(true, 'https://careerist.ru/register.html')],
    ['кабинет ответил ошибкой', resp(false, 'https://careerist.ru/responds/')],
  ])('%s — не вошёл', (_name, r) => {
    expect(cabinetSaysLoggedIn(r)).toBe(false);
  });

  it('спрашивает именно личный кабинет', async () => {
    const asked: string[] = [];
    const ok = await isCareeristLoggedIn({
      get: async (url) => { asked.push(url); return resp(true, url); },
    });
    expect(ok).toBe(true);
    expect(asked).toEqual([CAREERIST_CABINET_URL]);
  });
});

class FakePage implements LoginPage {
  visited: string[] = [];
  closed = false;
  async goto(url: string): Promise<void> { this.visited.push(url); }
  async close(): Promise<void> { this.closed = true; }
  isClosed(): boolean { return this.closed; }
  async bringToFront(): Promise<void> {}
  once(): void {}
}

const tick = (): Promise<void> => new Promise((r) => { setTimeout(r, 5); });
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i += 1) await tick();
  expect(cond()).toBe(true);
}

describe('окно входа с другой страницей и действием после открытия', () => {
  it('открывает loginUrl, зовёт afterOpen, а его ошибка вход не ломает', async () => {
    const page = new FakePage();
    let afterOpenCalls = 0;
    let logged = false;
    const login = createHhLogin({
      openPage: async () => page,
      loginUrl: CAREERIST_LOGIN_URL,
      afterOpen: async () => { afterOpenCalls += 1; throw new Error('ссылка «Войти» не нашлась'); },
      isLoggedIn: async () => logged,
      markerPath: join(mkdtempSync(join(tmpdir(), 'jaa-cl-')), 'careerist-login.json'),
      now: () => 7, pollMs: 1, closeDelayMs: 1,
    });
    login.start();
    await until(() => login.status().state === 'waiting');
    expect(page.visited).toEqual([CAREERIST_LOGIN_URL]);
    expect(afterOpenCalls).toBe(1);
    logged = true;
    await until(() => page.closed);
    expect(login.status()).toEqual({ state: 'done', lastLoginAt: 7, error: null });
  });
});
