import { describe, it, expect } from 'vitest';
import { fakeDialog } from '../src/telegram/interview-session.js';

describe('fakeDialog', () => {
  it('history отдаёт только сообщения новее minId, от старых к новым', async () => {
    const d = fakeDialog([
      { id: 1, date: new Date(), text: 'первое', urls: [], out: false, hasButtons: false },
      { id: 5, date: new Date(), text: 'второе', urls: [], out: false, hasButtons: false },
      { id: 9, date: new Date(), text: 'третье', urls: [], out: false, hasButtons: false },
    ]);
    const got = await d.history(5);
    expect(got.map((m) => m.id)).toEqual([9]);
  });

  it('send копит отправленное', async () => {
    const d = fakeDialog();
    await d.send('привет');
    expect(d.sent).toEqual(['привет']);
  });

  it('send появляется в history с out: true', async () => {
    const d = fakeDialog();
    await d.send('привет');
    const got = await d.history(0);
    expect(got).toEqual([expect.objectContaining({ text: 'привет', out: true })]);
  });

  it('onMessage получает новые сообщения и отписывается', () => {
    const d = fakeDialog();
    const seen: string[] = [];
    const off = d.onMessage((m) => seen.push(m.text));
    d.push('раз');
    off();
    d.push('два');
    expect(seen).toEqual(['раз']);
  });

  it('push с hasButtons: true отдаётся с этим признаком', async () => {
    const d = fakeDialog();
    d.push('вопрос', { hasButtons: true });
    const got = await d.history(0);
    expect(got[0]?.hasButtons).toBe(true);
    expect(got[0]?.out).toBe(false);
  });
});
