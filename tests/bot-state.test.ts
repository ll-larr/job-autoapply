import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotStore } from '../src/bot/state.js';

const store = (): BotStore => new BotStore(join(mkdtempSync(join(tmpdir(), 'jaa-bot-')), 'queue.db'));

describe('BotStore', () => {
  it('новый чат создаётся в idle и запоминает username', () => {
    const s = store();
    const c = s.touch(42, 'recruiter', 1000);
    expect(c.mode).toBe('idle');
    expect(c.username).toBe('recruiter');
    s.close();
  });

  it('повторный touch без username не стирает уже известный', () => {
    const s = store();
    s.touch(42, 'recruiter', 1000);
    const c = s.touch(42, null, 2000);
    expect(c.username).toBe('recruiter');
    expect(c.lastMsgAt).toBe(2000);
    s.close();
  });

  it('режим ожидания живёт до mode_until, дальше чат снова idle', () => {
    const s = store();
    s.touch(1, null, 0);
    s.setMode(1, 'await_vacancy', 5000);
    expect(s.chat(1)?.mode).toBe('await_vacancy');
    expect(s.modeAt(1, 4999)).toBe('await_vacancy');
    expect(s.modeAt(1, 6000)).toBe('idle');
    s.close();
  });

  it('счётчик вызовов модели раздельный по чатам и по дням', () => {
    const s = store();
    s.countModelCall('2026-09-20', 1);
    s.countModelCall('2026-09-20', 1);
    s.countModelCall('2026-09-20', 0);
    expect(s.modelCalls('2026-09-20', 1)).toBe(2);
    expect(s.modelCalls('2026-09-20', 0)).toBe(1);
    expect(s.modelCalls('2026-09-21', 1)).toBe(0);
    s.close();
  });

  it('страйки копятся и обнуляются', () => {
    const s = store();
    s.touch(1, null, 0);
    expect(s.addStrike(1)).toBe(1);
    expect(s.addStrike(1)).toBe(2);
    s.resetStrikes(1);
    expect(s.chat(1)?.strikes).toBe(0);
    s.close();
  });

  it('молчание записывается и обнуляет страйки', () => {
    const s = store();
    s.touch(1, null, 0);
    s.addStrike(1);
    s.mute(1, 9999);
    expect(s.chat(1)?.mutedUntil).toBe(9999);
    expect(s.chat(1)?.strikes).toBe(0);
    s.close();
  });

  it('встреча сохраняется до пинга и остаётся в очереди уведомлений, пока не помечена', () => {
    const s = store();
    s.touch(1, 'rec', 0);
    const id = s.saveMeeting({ chatId: 1, username: 'rec', queueId: 17, meetAt: 111, raw: '07.10;15:30', createdAt: 5 });
    expect(s.pendingMeetings().map((m) => m.id)).toEqual([id]);
    expect(s.pendingMeetings()[0]?.queueId).toBe(17);
    s.markMeetingNotified(id, 9);
    expect(s.pendingMeetings()).toEqual([]);
    s.close();
  });

  it('счётчик встреч за день считает только этот чат', () => {
    const s = store();
    s.saveMeeting({
      chatId: 1, username: null, queueId: null, meetAt: 1, raw: 'x',
      createdAt: new Date(2026, 8, 20, 10, 0).getTime(),
    });
    s.saveMeeting({
      chatId: 2, username: null, queueId: null, meetAt: 1, raw: 'x',
      createdAt: new Date(2026, 8, 20, 11, 0).getTime(),
    });
    expect(s.meetingsToday(1, '2026-09-20')).toBe(1);
    expect(s.meetingsToday(1, '2026-09-21')).toBe(0);
    s.close();
  });

  it('kv переживает переоткрытие базы', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaa-bot-kv-'));
    const path = join(dir, 'queue.db');
    const a = new BotStore(path);
    a.kvSet('offset', '99');
    a.close();
    const b = new BotStore(path);
    expect(b.kvGet('offset')).toBe('99');
    b.kvSet('offset', '100');
    expect(b.kvGet('offset')).toBe('100');
    b.close();
  });

  it('последняя вакансия чата запоминается — к ней привяжется собеседование', () => {
    const s = store();
    s.touch(1, null, 0);
    s.setLastQueueId(1, 42);
    expect(s.chat(1)?.lastQueueId).toBe(42);
    s.close();
  });
});
