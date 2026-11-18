import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHhLogin, HH_LOGIN_URL, type LoginPage } from '../src/core/hh-login.js';

/** Подставная вкладка: никакого браузера, только то, что нужно createHhLogin. */
class FakePage implements LoginPage {
  visited: string[] = [];
  closed = false;
  fronted = 0;
  private onClose: Array<() => void> = [];
  async goto(url: string): Promise<void> { this.visited.push(url); }
  async close(): Promise<void> { this.closed = true; for (const f of this.onClose) f(); }
  isClosed(): boolean { return this.closed; }
  async bringToFront(): Promise<void> { this.fronted += 1; }
  once(_e: 'close', fn: () => void): void { this.onClose.push(fn); }
  /** Человек закрыл окно руками. */
  userCloses(): void { void this.close(); }
}

const tick = (): Promise<void> => new Promise((r) => { setTimeout(r, 5); });
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i += 1) await tick();
  expect(cond()).toBe(true);
}
const marker = (): string => join(mkdtempSync(join(tmpdir(), 'jaa-login-')), 'hh-login.json');

describe('вход на hh.ru из панели', () => {
  it('открывает страницу входа, ждёт сессию, запоминает время входа и закрывает вкладку', async () => {
    const page = new FakePage();
    let logged = false;
    const path = marker();
    const login = createHhLogin({
      openPage: async () => page, isLoggedIn: async () => logged,
      markerPath: path, now: () => 1_000, pollMs: 1, closeDelayMs: 1,
    });
    expect(login.status()).toEqual({ state: 'idle', lastLoginAt: null, error: null });
    expect(login.start()).toEqual({ ok: true });
    await until(() => login.status().state === 'waiting');
    expect(page.visited).toEqual([HH_LOGIN_URL]);
    expect(login.running()).toBe(true);

    logged = true;
    await until(() => page.closed);
    expect(login.status()).toEqual({ state: 'done', lastLoginAt: 1_000, error: null });
    expect(login.running()).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ at: 1_000 });
  });

  it('время прошлого входа читается из файла после перезапуска панели', () => {
    const path = marker();
    writeFileSync(path, JSON.stringify({ at: 42 }));
    const login = createHhLogin({ openPage: async () => new FakePage(), isLoggedIn: async () => false, markerPath: path });
    expect(login.status().lastLoginAt).toBe(42);
  });

  it('повторное нажатие, пока окно открыто, не открывает второе, а показывает первое', async () => {
    const page = new FakePage();
    let opened = 0;
    const login = createHhLogin({
      openPage: async () => { opened += 1; return page; }, isLoggedIn: async () => false,
      markerPath: marker(), pollMs: 1,
    });
    login.start();
    await until(() => login.status().state === 'waiting');
    login.start();
    await until(() => page.fronted === 1);
    expect(opened).toBe(1);
    page.userCloses();
    await until(() => login.status().state === 'closed');
  });

  it('окно закрыли руками до входа — состояние «закрыто», отметка не пишется', async () => {
    const page = new FakePage();
    const path = marker();
    const login = createHhLogin({ openPage: async () => page, isLoggedIn: async () => false, markerPath: path, pollMs: 1 });
    login.start();
    await until(() => login.status().state === 'waiting');
    page.userCloses();
    await until(() => login.status().state === 'closed');
    expect(existsSync(path)).toBe(false);
  });

  it('не дождались входа — таймаут, вкладка закрывается', async () => {
    const page = new FakePage();
    let t = 0;
    const login = createHhLogin({
      openPage: async () => page, isLoggedIn: async () => false, markerPath: marker(),
      now: () => t, pollMs: 1, timeoutMs: 100, sleep: async () => { t += 60; await tick(); },
    });
    login.start();
    await until(() => login.status().state === 'timeout');
    expect(page.closed).toBe(true);
  });

  it('профиль занят другим процессом — понятная причина вместо стека', async () => {
    const login = createHhLogin({
      openPage: async () => { throw new Error('browserType.launchPersistentContext: Failed to create a ProcessSingleton for your profile directory'); },
      isLoggedIn: async () => false, markerPath: marker(),
    });
    login.start();
    await until(() => login.status().state === 'error');
    expect(login.status().error).toMatch(/профиль занят/);
  });
});
