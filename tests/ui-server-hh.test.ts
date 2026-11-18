import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startPanel, type PanelDeps } from '../src/ui/server.js';
import { Queue } from '../src/core/queue.js';
import type { HhInboxReport, HhPanelStatus } from '../src/hh/inbox.js';

let q: Queue;
let panel: { port: number; close(): Promise<void> } | null = null;

beforeEach(() => { q = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-uihh-')), 'test.db')); });
afterEach(async () => {
  vi.useRealTimers();
  await panel?.close();
  panel = null;
  q.close();
});

const report = (over: Partial<HhInboxReport> = {}): HhInboxReport => ({
  at: 1, outcome: 'ok', topics: 20, newReplies: 1, invites: 0, rejects: 0, repliesSent: 0, replyIssues: [], blockedWrites: [], error: null,
  ...over,
});

const status = (over: Partial<HhPanelStatus> = {}): HhPanelStatus => ({
  enabled: true, replyEnabled: false, intervalMinutes: 30, report: report(), probeAt: null, chatProbeOkAt: null, chatProbeFresh: false,
  ...over,
});

interface Fake {
  due: boolean;
  calls: number;
  stopSeen: boolean[];
  release: (() => void) | null;
}

function fake(over: Partial<Fake> = {}): { deps: NonNullable<PanelDeps['hh']>; state: Fake } {
  const state: Fake = { due: false, calls: 0, stopSeen: [], release: null, ...over };
  const deps: NonNullable<PanelDeps['hh']> = {
    status: () => status(),
    due: () => state.due,
    check: async (stop) => {
      state.calls += 1;
      await new Promise<void>((done) => { state.release = done; });
      state.stopSeen.push(stop());
      return report();
    },
  };
  return { deps, state };
}

const open = async (deps: PanelDeps): Promise<string> => {
  panel = await startPanel(q, 0, deps);
  return `http://127.0.0.1:${panel.port}`;
};
const post = (url: string, body: unknown = {}): Promise<Response> =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const until = async (check: () => Promise<boolean> | boolean): Promise<void> => {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((r) => { setTimeout(r, 20); });
  }
  throw new Error('не дождались');
};
const getStatus = async (base: string): Promise<Record<string, unknown>> =>
  (await (await fetch(`${base}/api/hh/status`)).json()) as Record<string, unknown>;

describe('панель — ящик откликов hh.ru', () => {
  it('без зависимости ручки отвечают 409', async () => {
    const base = await open({});
    expect((await fetch(`${base}/api/hh/status`)).status).toBe(409);
    expect((await post(`${base}/api/hh/check`)).status).toBe(409);
    expect((await post(`${base}/api/hh/stop`)).status).toBe(409);
  });

  it('status отдаёт настройки, отчёт и состояние запуска', async () => {
    const { deps } = fake();
    const base = await open({ hh: deps });
    const s = await getStatus(base);
    expect(s).toMatchObject({ running: false, enabled: true, replyEnabled: false, intervalMinutes: 30, chatProbeFresh: false });
    expect((s['report'] as HhInboxReport).topics).toBe(20);
  });

  it('check отвечает 202 сразу, status показывает running до конца проверки', async () => {
    const { deps, state } = fake();
    const base = await open({ hh: deps });
    const res = await post(`${base}/api/hh/check`);
    expect(res.status).toBe(202);
    await until(() => state.release !== null);
    expect((await getStatus(base))['running']).toBe(true);
    state.release!();
    await until(async () => (await getStatus(base))['running'] === false);
    expect(state.calls).toBe(1);
  });

  it('вторая проверка поверх идущей — 409', async () => {
    const { deps, state } = fake();
    const base = await open({ hh: deps });
    await post(`${base}/api/hh/check`);
    await until(() => state.release !== null);
    const second = await post(`${base}/api/hh/check`);
    expect(second.status).toBe(409);
    state.release!();
    await until(async () => (await getStatus(base))['running'] === false);
    expect(state.calls).toBe(1);
  });

  it('stop поднимает флаг, проверка видит его', async () => {
    const { deps, state } = fake();
    const base = await open({ hh: deps });
    expect((await post(`${base}/api/hh/stop`)).status).toBe(409); // нечего останавливать
    await post(`${base}/api/hh/check`);
    await until(() => state.release !== null);
    expect((await post(`${base}/api/hh/stop`)).status).toBe(200);
    state.release!();
    await until(async () => (await getStatus(base))['running'] === false);
    expect(state.stopSeen).toEqual([true]);
  });

  it('сбой проверки попадает в status.error, а не роняет панель', async () => {
    const deps: NonNullable<PanelDeps['hh']> = {
      status: () => status(), due: () => false, check: async () => { throw new Error('браузер не запустился'); },
    };
    const base = await open({ hh: deps });
    await post(`${base}/api/hh/check`);
    await until(async () => (await getStatus(base))['running'] === false);
    expect((await getStatus(base))['error']).toBe('браузер не запустился');
  });

  it('проверка держит профиль: поиск, отправка и дожимы получают 409', async () => {
    const { deps, state } = fake();
    const followups: NonNullable<PanelDeps['followups']> = {
      enabled: () => true, waiting: () => 0, list: () => [],
      prepare: async () => ({ created: 0, fromModel: 0, fromTemplate: 0 }),
      send: async () => ({ sent: 0, cancelled: 0, failed: 0, skipped: 0, halted: null, reason: null }),
      setText: () => 'ok', cancel: () => true,
    };
    const base = await open({
      hh: deps, followups, startSearch: async () => ({ found: 0 } as never),
      adapters: [], config: {} as never,
    });
    await post(`${base}/api/hh/check`);
    await until(() => state.release !== null);
    expect((await post(`${base}/api/search/start`, { limit: 5 })).status).toBe(409);
    expect((await post(`${base}/api/send/start`)).status).toBe(409);
    expect((await post(`${base}/api/followups/prepare`)).status).toBe(409);
    state.release!();
    await until(async () => (await getStatus(base))['running'] === false);
  });

  it('плановая проверка: таймер раз в минуту зовёт check, когда due()', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { deps, state } = fake({ due: true });
    const base = await open({ hh: deps });
    vi.advanceTimersByTime(60_000);
    await until(() => state.calls === 1);
    expect((await getStatus(base))['origin']).toBe('timer');
    state.release!();
    await until(async () => (await getStatus(base))['running'] === false);
  });

  it('плановая проверка не стартует, когда due() ложно или уже идёт другая работа', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { deps, state } = fake({ due: false });
    await open({ hh: deps });
    vi.advanceTimersByTime(5 * 60_000);
    expect(state.calls).toBe(0);
  });
});
