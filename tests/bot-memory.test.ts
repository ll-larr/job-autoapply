import { describe, it, expect } from 'vitest';
import { ChatMemory } from '../src/bot/memory.js';

const H = 3_600_000;

describe('ChatMemory', () => {
  it('держит последние N реплик моложе TTL, от старых к новым', () => {
    const m = new ChatMemory({ turns: 3, ttlMs: 2 * H });
    for (let i = 1; i <= 5; i += 1) m.add(1, { who: 'recruiter', text: `реплика ${i}`, at: i * 1000 });
    expect(m.recent(1, 6000).map((t) => t.text)).toEqual(['реплика 3', 'реплика 4', 'реплика 5']);
    expect(m.recent(1, 2 * H + 4500).map((t) => t.text)).toEqual(['реплика 5']);
    expect(m.recent(1, 3 * H)).toEqual([]);
    expect(m.recent(2, 0)).toEqual([]);
  });

  it('пустые реплики и нулевое окно ничего не хранят; длинная реплика режется', () => {
    const none = new ChatMemory({ turns: 0, ttlMs: H });
    none.add(1, { who: 'agent', text: 'привет', at: 1 });
    expect(none.recent(1, 1)).toEqual([]);
    const m = new ChatMemory({ turns: 2, ttlMs: H });
    m.add(1, { who: 'agent', text: '   ', at: 1 });
    m.add(1, { who: 'agent', text: 'а'.repeat(900), at: 2 });
    const [t] = m.recent(1, 3);
    expect(t!.text).toHaveLength(800);
    expect(t!.text.endsWith('…')).toBe(true);
  });

  it('ответы считаются отдельно от окна реплик', () => {
    const m = new ChatMemory({ turns: 1, ttlMs: H });
    for (let i = 0; i < 5; i += 1) m.noteReply(1, 1000 * i);
    expect(m.repliesSince(1, 0)).toBe(5);
    expect(m.repliesSince(1, 3000)).toBe(2);
    expect(m.repliesSince(2, 0)).toBe(0);
  });

  it('социальные отметки по видам; повтор текста возвращает прежний', () => {
    const m = new ChatMemory({ turns: 1, ttlMs: H });
    expect(m.lastSocialAt(1, 'greeting')).toBeNull();
    m.noteSocial(1, 'greeting', 500);
    expect(m.lastSocialAt(1, 'greeting')).toBe(500);
    expect(m.lastSocialAt(1, 'thanks')).toBeNull();
    expect(m.swapIncoming(1, 'привет', 10)).toBeNull();
    expect(m.swapIncoming(1, 'как дела', 20)).toEqual({ norm: 'привет', at: 10 });
  });

  it('число чатов в памяти ограничено', () => {
    const m = new ChatMemory({ turns: 1, ttlMs: H });
    for (let k = 1; k <= 600; k += 1) m.add(k, { who: 'recruiter', text: 'x', at: 1 });
    expect(m.recent(1, 1)).toEqual([]);
    expect(m.recent(600, 1)).toHaveLength(1);
  });
});
