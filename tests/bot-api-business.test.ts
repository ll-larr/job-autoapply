import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotApi, ALLOWED_UPDATES } from '../src/bot/api.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Seen { url: string; body: string; headers: Record<string, string> }
const spy = (response: () => Response) => {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    seen.push({
      url: String(url),
      body: init?.body === undefined ? '' : Buffer.from(init.body as Uint8Array | string).toString('utf8'),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return response();
  };
  return { api: new BotApi('T', { fetchImpl }), seen };
};

describe('BotApi — секретарь', () => {
  it('getUpdates просит четыре типа апдейтов', async () => {
    const { api, seen } = spy(() => json({ ok: true, result: [] }));
    await api.getUpdates(5, 12);
    const payload = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    expect(payload['allowed_updates']).toEqual(['message', 'business_connection', 'business_message', 'edited_business_message']);
    expect(ALLOWED_UPDATES).toContain('business_message');
    expect(payload['timeout']).toBe(12);
  });

  it('sendMessage с соединением: business_connection_id в теле, клавиатуры нет даже если её просили', async () => {
    const { api, seen } = spy(() => json({ ok: true, result: { message_id: 4 } }));
    const r = await api.sendMessage(77, 'привет', { keyboard: true, businessConnectionId: 'c1' });
    expect(r).toEqual({ ok: true, value: 4 });
    const payload = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    expect(payload).toMatchObject({ chat_id: 77, text: 'привет', business_connection_id: 'c1' });
    expect(payload).not.toHaveProperty('reply_markup');
  });

  it('sendMessage без соединения — как раньше: клавиатура есть, business_connection_id нет', async () => {
    const { api, seen } = spy(() => json({ ok: true, result: { message_id: 4 } }));
    await api.sendMessage(5, 'привет', { keyboard: true });
    const payload = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    expect(payload['reply_markup']).toBeDefined();
    expect(payload).not.toHaveProperty('business_connection_id');
  });

  it('sendDocument по file_id и с диска несёт business_connection_id (JSON и multipart)', async () => {
    const byId = spy(() => json({ ok: true, result: { document: { file_id: 'F' } } }));
    await byId.api.sendDocumentByFileId(77, 'F', 'подпись', 'c1');
    expect(JSON.parse(byId.seen[0]!.body)).toMatchObject({ chat_id: 77, document: 'F', business_connection_id: 'c1' });

    const path = join(mkdtempSync(join(tmpdir(), 'jaa-api-')), 'cv.pdf');
    writeFileSync(path, '%PDF-1.4 тест');
    const file = spy(() => json({ ok: true, result: { document: { file_id: 'G' } } }));
    const r = await file.api.sendDocumentByPath(77, path, 'cv.pdf', 'подпись', 'c1');
    expect(r).toEqual({ ok: true, value: 'G' });
    expect(file.seen[0]!.body).toContain('name="business_connection_id"\r\n\r\nc1\r\n');
    expect(file.seen[0]!.body).toContain('name="chat_id"\r\n\r\n77\r\n');

    const plain = spy(() => json({ ok: true, result: { document: { file_id: 'G' } } }));
    await plain.api.sendDocumentByPath(77, path, 'cv.pdf', 'подпись');
    expect(plain.seen[0]!.body).not.toContain('business_connection_id');
  });

  it('400 и 403 на вызове с business_connection_id — kind business; без него — обычный http', async () => {
    const refused = (status: number) => spy(() => json({ ok: false, description: 'Bad Request: BUSINESS_PEER_USAGE_MISSING' }, status));
    for (const status of [400, 403]) {
      const r = await refused(status).api.sendMessage(77, 'x', { businessConnectionId: 'c1' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.kind).toBe('business');
    }
    const plain = await refused(400).api.sendMessage(77, 'x');
    if (!plain.ok) expect(plain.failure.kind).toBe('http');
    const doc = await refused(403).api.sendDocumentByFileId(77, 'F', 'c', 'c1');
    if (!doc.ok) expect(doc.failure.kind).toBe('business');
  });

  it('429 на business-вызове остаётся flood, 401 — auth', async () => {
    const flood = spy(() => json({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 3 } }, 429));
    const r = await flood.api.sendMessage(77, 'x', { businessConnectionId: 'c1' });
    if (!r.ok) expect(r.failure).toMatchObject({ kind: 'flood', retryAfterMs: 3000 });
    const auth = spy(() => json({ ok: false, description: 'Unauthorized' }, 401));
    const a = await auth.api.sendMessage(77, 'x', { businessConnectionId: 'c1' });
    if (!a.ok) expect(a.failure.kind).toBe('auth');
  });

  it('getBusinessConnection, getMe и sendChatAction', async () => {
    const conn = spy(() => json({ ok: true, result: { id: 'c1', user: { id: 5, is_bot: false }, user_chat_id: 5, date: 1, is_enabled: true } }));
    const r = await conn.api.getBusinessConnection('c1');
    expect(r.ok && r.value.user.id).toBe(5);
    expect(JSON.parse(conn.seen[0]!.body)).toEqual({ business_connection_id: 'c1' });
    expect(conn.seen[0]!.url).toContain('/getBusinessConnection');

    const me = spy(() => json({ ok: true, result: { id: 1, is_bot: true, can_connect_to_business: true } }));
    const m = await me.api.getMe();
    expect(m.ok && m.value.can_connect_to_business).toBe(true);

    const typing = spy(() => json({ ok: true, result: true }));
    await typing.api.sendChatAction(77, 'typing', 'c1');
    expect(JSON.parse(typing.seen[0]!.body)).toEqual({ chat_id: 77, action: 'typing', business_connection_id: 'c1' });
  });
});
