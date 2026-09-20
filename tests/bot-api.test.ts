import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotApi } from '../src/bot/api.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('BotApi — разбор ответов Telegram', () => {
  it('getUpdates возвращает апдейты', async () => {
    const api = new BotApi('T', { fetchImpl: async () => json({ ok: true, result: [{ update_id: 7 }] }) });
    const r = await api.getUpdates(0);
    expect(r.ok && r.value[0]?.update_id).toBe(7);
  });

  it('401 — токен негоден, это не повод повторять', async () => {
    const api = new BotApi('T', { fetchImpl: async () => json({ ok: false, description: 'Unauthorized' }, 401) });
    const r = await api.getUpdates(0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('auth');
  });

  it('409 — рядом второй getUpdates или вебхук', async () => {
    const api = new BotApi('T', { fetchImpl: async () => json({ ok: false, description: 'Conflict' }, 409) });
    const r = await api.getUpdates(0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('conflict');
  });

  it('429 отдаёт retry_after в миллисекундах', async () => {
    const api = new BotApi('T', {
      fetchImpl: async () => json(
        { ok: false, description: 'Too Many Requests', parameters: { retry_after: 7 } },
        429,
      ),
    });
    const r = await api.sendMessage(1, 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.retryAfterMs).toBe(7000);
  });

  it('обрыв сети — kind network, а не исключение наружу', async () => {
    const api = new BotApi('T', { fetchImpl: async () => { throw new Error('socket hang up'); } });
    const r = await api.sendMessage(1, 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('network');
  });

  it('sendMessage с клавиатурой кладёт четыре кнопки', async () => {
    let body: unknown;
    const api = new BotApi('T', {
      fetchImpl: async (_u, init) => {
        body = JSON.parse(String(init?.body));
        return json({ ok: true, result: { message_id: 3 } });
      },
    });
    await api.sendMessage(1, 'привет', { keyboard: true });
    const kb = (body as { reply_markup?: { keyboard?: string[][] } }).reply_markup?.keyboard;
    expect(kb?.flat()).toEqual(['Резюме', 'Профиль', 'Прикрепить вакансию', 'Назначить собеседование']);
  });

  it('без keyboard разметка не шлётся — клавиатура не мигает на каждом ответе', async () => {
    let body: Record<string, unknown> = {};
    const api = new BotApi('T', {
      fetchImpl: async (_u, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ ok: true, result: { message_id: 3 } });
      },
    });
    await api.sendMessage(1, 'привет');
    expect(body['reply_markup']).toBeUndefined();
  });

  it('getFile без file_path — отказ, а не пустая строка пути', async () => {
    const api = new BotApi('T', { fetchImpl: async () => json({ ok: true, result: { file_size: 10 } }) });
    const r = await api.getFile('F');
    expect(r.ok).toBe(false);
  });

  it('download не пишет файл больше лимита', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaa-dl-'));
    const api = new BotApi('T', { fetchImpl: async () => new Response(new Uint8Array(1024)) });
    const r = await api.download('doc/x.pdf', join(dir, 'x.bin'), 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.message).toMatch(/больше/i);
  });

  it('download в пределах лимита пишет файл и отдаёт размер', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaa-dl2-'));
    const api = new BotApi('T', { fetchImpl: async () => new Response(new Uint8Array(64)) });
    const r = await api.download('doc/x.pdf', join(dir, 'x.bin'), 1024);
    expect(r.ok && r.value).toBe(64);
  });
});
