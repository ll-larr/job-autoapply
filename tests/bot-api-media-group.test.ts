import { describe, it, expect } from 'vitest';
import { BotApi } from '../src/bot/api.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const spy = (response: () => Response) => {
  const seen: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    seen.push({ url: String(url), body: Buffer.from(init?.body as Uint8Array).toString('utf8') });
    return response();
  };
  return { api: new BotApi('T', { fetchImpl }), seen };
};

describe('sendDocumentsFromText (sendMediaGroup)', () => {
  it('альбом из двух файлов: подпись только на последнем, файлы вложены частями f0 и f1', async () => {
    const { api, seen } = spy(() => json({ ok: true, result: [{}, {}] }));
    const r = await api.sendDocumentsFromText(999, [
      { name: 'vacancy-1.txt', content: 'Вакансия' },
      { name: 'meeting-1.ics', content: 'BEGIN:VCALENDAR' },
    ], 'Собеседование: завтра');
    expect(r).toEqual({ ok: true, value: 2 });
    expect(seen[0]!.url).toContain('/sendMediaGroup');
    const body = seen[0]!.body;
    expect(body).toContain('name="chat_id"\r\n\r\n999\r\n');
    const media = JSON.parse(/name="media"\r\n\r\n(.*)\r\n/.exec(body)![1]!) as Array<Record<string, unknown>>;
    expect(media).toEqual([
      { type: 'document', media: 'attach://f0' },
      { type: 'document', media: 'attach://f1', caption: 'Собеседование: завтра' },
    ]);
    expect(body).toContain('name="f0"; filename="vacancy-1.txt"');
    expect(body).toContain('name="f1"; filename="meeting-1.ics"');
    expect(body).toContain('BEGIN:VCALENDAR');
  });

  it('отказ Telegram возвращается значением, а не исключением', async () => {
    const { api } = spy(() => json({ ok: false, description: 'Bad Request' }, 400));
    const r = await api.sendDocumentsFromText(999, [{ name: 'a', content: 'b' }, { name: 'c', content: 'd' }], 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('http');
  });

  it('обрыв связи — kind network', async () => {
    const api = new BotApi('T', { fetchImpl: async () => { throw new Error('socket hang up'); } });
    const r = await api.sendDocumentsFromText(999, [{ name: 'a', content: 'b' }, { name: 'c', content: 'd' }], 'x');
    if (!r.ok) expect(r.failure.kind).toBe('network');
    expect(r.ok).toBe(false);
  });
});
