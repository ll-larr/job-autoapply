import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startPanel, type PanelDeps } from '../src/ui/server.js';
import { Queue } from '../src/core/queue.js';
import type { FollowupRunReport, FollowupView } from '../src/core/followups.js';
import type { Config } from '../src/core/config.js';

let q: Queue;
let panel: { port: number; close(): Promise<void> } | null = null;

beforeEach(() => { q = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-uif-')), 'test.db')); });
afterEach(async () => { await panel?.close(); panel = null; q.close(); });

const item = (over: Partial<FollowupView> = {}): FollowupView => ({
  id: 1, queueId: 5, contact: 'rec', status: 'draft', text: 'Привет! Напоминаю про вакансию.', textMode: 'template',
  reason: null, createdAt: 1, sentAt: null, title: 'Аналитик', firstSentAt: Date.now() - 6 * 86_400_000, ...over,
});

interface Fake {
  enabled: boolean;
  items: FollowupView[];
  sendCalls: Array<{ ids: number[] | 'all' }>;
  release: (() => void) | null;
  stopSeen: boolean[];
}

function fake(over: Partial<Fake> = {}): { deps: NonNullable<PanelDeps['followups']>; state: Fake } {
  const state: Fake = { enabled: true, items: [item()], sendCalls: [], release: null, stopSeen: [], ...over };
  const deps: NonNullable<PanelDeps['followups']> = {
    enabled: () => state.enabled,
    waiting: () => 3,
    list: () => state.items,
    prepare: async () => ({ created: 2, fromModel: 1, fromTemplate: 1 }),
    send: async (ids, stop) => {
      state.sendCalls.push({ ids });
      await new Promise<void>((done) => { state.release = done; });
      state.stopSeen.push(stop());
      return { sent: 1, cancelled: 0, failed: 0, skipped: 0, halted: null, reason: null } satisfies FollowupRunReport;
    },
    setText: (id, text) => (id === 1 && text !== '' ? 'ok' : 'not_draft'),
    cancel: (id) => id === 1,
  };
  return { deps, state };
}

const open = async (deps: PanelDeps): Promise<string> => {
  panel = await startPanel(q, 0, deps);
  return `http://127.0.0.1:${panel.port}`;
};
const post = (url: string, body: unknown = {}): Promise<Response> =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const until = async (check: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((r) => { setTimeout(r, 20); });
  }
  throw new Error('не дождались');
};

describe('панель — дожимы', () => {
  it('без зависимости все ручки отвечают 409', async () => {
    const base = await open({});
    for (const [method, path] of [['GET', '/api/followups'], ['GET', '/api/followups/status'], ['POST', '/api/followups/prepare'], ['POST', '/api/followups/send']]) {
      const res = await fetch(base + path, { method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}) });
      expect(res.status, path).toBe(409);
    }
  });

  it('GET /api/followups: тумблер, число ждущих текста и карточки', async () => {
    const { deps } = fake();
    const base = await open({ followups: deps });
    const body = await (await fetch(`${base}/api/followups`)).json() as { enabled: boolean; waiting: number; items: FollowupView[] };
    expect(body).toMatchObject({ enabled: true, waiting: 3 });
    expect(body.items[0]).toMatchObject({ contact: 'rec', title: 'Аналитик', status: 'draft' });
  });

  it('подготовка идёт в фоне: 202, статус running → результат; повторный запуск пока идёт — 409', async () => {
    const { deps } = fake();
    let release!: () => void;
    deps.prepare = () => new Promise((done) => { release = () => done({ created: 2, fromModel: 1, fromTemplate: 1 }); });
    const base = await open({ followups: deps });
    expect((await post(`${base}/api/followups/prepare`)).status).toBe(202);
    const status = async () => (await fetch(`${base}/api/followups/status`)).json() as Promise<{ running: boolean; kind: string | null; result: unknown }>;
    expect(await status()).toMatchObject({ running: true, kind: 'prepare' });
    expect((await post(`${base}/api/followups/prepare`)).status).toBe(409);
    release();
    await until(async () => !(await status()).running);
    expect((await status()).result).toEqual({ created: 2, fromModel: 1, fromTemplate: 1 });
  });

  it('отправка при выключенном тумблере — 409 с причиной, send не зовётся', async () => {
    const { deps, state } = fake({ enabled: false });
    const base = await open({ followups: deps });
    const res = await post(`${base}/api/followups/send`);
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toContain('выключены');
    expect(state.sendCalls).toEqual([]);
  });

  it('отправка: ids передаются, вторая параллельная — 409, «Стоп» доходит до прогона', async () => {
    const { deps, state } = fake();
    const base = await open({ followups: deps });
    expect((await post(`${base}/api/followups/send`, { ids: [1] })).status).toBe(202);
    await until(async () => state.release !== null);
    expect(state.sendCalls).toEqual([{ ids: [1] }]);
    expect((await post(`${base}/api/followups/send`, {})).status).toBe(409);
    expect((await post(`${base}/api/followups/stop`)).status).toBe(202);
    state.release!();
    await until(async () => !((await (await fetch(`${base}/api/followups/status`)).json()) as { running: boolean }).running);
    expect(state.stopSeen).toEqual([true]);
  });

  it('«Стоп» без отправки — 409; пустое тело отправки — все черновики', async () => {
    const { deps, state } = fake();
    const base = await open({ followups: deps });
    expect((await post(`${base}/api/followups/stop`)).status).toBe(409);
    await post(`${base}/api/followups/send`, {});
    await until(async () => state.release !== null);
    expect(state.sendCalls).toEqual([{ ids: 'all' }]);
    state.release!();
  });

  it('правка текста: длина 1–400, только черновик; отмена только черновика', async () => {
    const { deps } = fake();
    const base = await open({ followups: deps });
    expect((await post(`${base}/api/followups/text`, { id: 1, text: '' })).status).toBe(400);
    expect((await post(`${base}/api/followups/text`, { id: 1, text: 'я'.repeat(401) })).status).toBe(400);
    expect((await post(`${base}/api/followups/text`, { id: 'x', text: 'ок' })).status).toBe(400);
    expect((await post(`${base}/api/followups/text`, { id: 1, text: 'Новый текст' })).status).toBe(200);
    expect((await post(`${base}/api/followups/text`, { id: 2, text: 'Новый текст' })).status).toBe(409);
    expect((await post(`${base}/api/followups/cancel`, { id: 1 })).status).toBe(200);
    expect((await post(`${base}/api/followups/cancel`, { id: 2 })).status).toBe(409);
  });

  it('пока идут дожимы, поиск и отправка очереди отвечают 409', async () => {
    const { deps, state } = fake();
    const base = await open({
      followups: deps,
      startSearch: async () => ({ report: {}, emptyLetters: 0 }),
      adapters: [],
      config: {} as Config,
    });
    await post(`${base}/api/followups/send`, {});
    await until(async () => state.release !== null);
    const search = await post(`${base}/api/search/start`, { limit: 5 });
    expect(search.status).toBe(409);
    expect((await search.json() as { error: string }).error).toContain('дожим');
    const send = await post(`${base}/api/send/start`, {});
    expect(send.status).toBe(409);
    state.release!();
  });

  it('когда ничего не идёт, подготовка стартует даже при настроенных поиске и отправке', async () => {
    const { deps } = fake();
    const base = await open({
      followups: deps,
      startSearch: async () => ({ report: {}, emptyLetters: 0 }),
      adapters: [],
      config: {} as Config,
    });
    expect((await post(`${base}/api/followups/prepare`)).status).toBe(202);
  });
});
