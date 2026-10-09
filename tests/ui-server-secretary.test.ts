import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startPanel, type PanelDeps } from '../src/ui/server.js';
import { Queue } from '../src/core/queue.js';
import { Dialogs } from '../src/core/dialogs.js';

let path: string;
let q: Queue;
let panel: { port: number; close(): Promise<void> } | null = null;

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), 'jaa-uis-')), 'test.db');
  q = new Queue(path);
});
afterEach(async () => {
  await panel?.close();
  panel = null;
  q.close();
});

const open = async (deps: PanelDeps = {}): Promise<string> => {
  panel = await startPanel(q, 0, deps);
  return `http://127.0.0.1:${panel.port}`;
};

describe('панель — диалоги', () => {
  it('без зависимости /api/dialogs отвечает 409 с объяснением', async () => {
    const base = await open();
    const res = await fetch(`${base}/api/dialogs`);
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toContain('npm run panel');
  });

  it('с зависимостью отдаёт диалоги, воронку и счётчик — без текстов', async () => {
    const dialogs = new Dialogs(path);
    dialogs.incoming({ channel: 'business', peerKey: '77', username: 'rec' }, Date.now() - 1000, null);
    const base = await open({
      dialogs: { snapshot: (now) => ({ dialogs: dialogs.list(now), funnel: dialogs.funnel(now), active: dialogs.activeCount(now) }) },
    });
    const res = await fetch(`${base}/api/dialogs`);
    const body = await res.json() as { dialogs: Array<Record<string, unknown>>; funnel: unknown[]; active: number };
    expect(res.status).toBe(200);
    expect(body.active).toBe(1);
    expect(body.dialogs[0]).toMatchObject({ who: '@rec', status: 'replied', inCount: 1 });
    expect(JSON.stringify(body)).not.toMatch(/"(text|raw)"/);
    dialogs.close();
  });
});

describe('страница панели', () => {
  const html = readFileSync('src/ui/panel.html', 'utf8');

  it('есть вкладка «Диалоги» и блоки настроек секретаря, календаря, дожимов и ящика hh', async () => {
    const base = await open();
    const served = await (await fetch(`${base}/`)).text();
    for (const id of ['tab-dialogs', 'pane-dialogs', 'funnel', 'dialogList', 'secretaryBlock', 'calendarBlock', 'followupsBlock', 'hhInboxBlock']) {
      expect(served).toContain(`id="${id}"`);
    }
  });

  it('встроенный скрипт разбирается без ошибок', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
    expect(() => new Function(script)).not.toThrow();
  });

  it('collectSettings знает все новые разделы, а тумблеры дожимов и hh подтверждаются', () => {
    for (const key of ['secretary:', 'calendar:', 'followups:', 'hhInbox:', 'replyEnabled']) expect(html).toContain(key);
    expect(html).toContain("document.getElementById('fuEnabled').onchange");
    expect(html).toContain("document.getElementById('hhReply').onchange");
  });
});
