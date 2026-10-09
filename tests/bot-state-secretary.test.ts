import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BotStore, businessKey, hhKey, channelOfKey, peerOfKey, chatKeyOf, HH_KEY_BASE,
} from '../src/bot/state.js';

let store: BotStore;
beforeEach(() => {
  store = new BotStore(join(mkdtempSync(join(tmpdir(), 'jaa-st-')), 'queue.db'));
});

const meeting = (over: Partial<Parameters<BotStore['saveMeeting']>[0]> = {}) => store.saveMeeting({
  chatId: businessKey(77), username: 'rec', queueId: null, meetAt: 10_000_000, raw: 'x', createdAt: 1_000, ...over,
});

describe('ключи чатов', () => {
  it('чат с ботом > 0, личка ∈ (−2^52, 0), hh ≤ −2^52, 0 — общий счётчик', () => {
    expect(businessKey(77)).toBe(-77);
    expect(hhKey(5)).toBe(-(HH_KEY_BASE + 5));
    expect([5, 0, -77, hhKey(5)].map(channelOfKey)).toEqual(['bot', 'total', 'business', 'hh']);
    expect(peerOfKey(-77)).toBe(77);
  });
  it('границы: нуль, дробь, слишком большое — исключение', () => {
    expect(() => businessKey(0)).toThrow();
    expect(() => businessKey(1.5)).toThrow();
    expect(() => businessKey(HH_KEY_BASE)).toThrow();
    expect(() => hhKey(0)).toThrow();
    expect(() => hhKey(HH_KEY_BASE)).toThrow();
    expect(() => peerOfKey(5)).toThrow();
  });
  it('ключ сообщения: из лички секретаря отрицательный, из чата с ботом — chat_id', () => {
    const base = { message_id: 1, date: 0, chat: { id: 77, type: 'private' } };
    expect(chatKeyOf(base)).toBe(77);
    expect(chatKeyOf({ ...base, business_connection_id: 'c' })).toBe(-77);
  });
  it('счётчики модели лички и чата с ботом не смешиваются', () => {
    store.countModelCall('2026-10-09', businessKey(77));
    store.countModelCall('2026-10-09', 77);
    store.countModelCall('2026-10-09', 77);
    expect(store.modelCalls('2026-10-09', businessKey(77))).toBe(1);
    expect(store.modelCalls('2026-10-09', 77)).toBe(2);
  });
});

describe('соединения и дедупликация', () => {
  it('upsertConnection и connection; hasConnectionOf без учёта регистра и @', () => {
    store.upsertConnection({ id: 'c', userId: 1, username: 'hire_agent', userChatId: 1, canReply: true, isEnabled: true, updatedAt: 5 });
    store.upsertConnection({ id: 'c', userId: 1, username: 'hire_agent', userChatId: 1, canReply: false, isEnabled: true, updatedAt: 6 });
    expect(store.connection('c')).toMatchObject({ canReply: false, updatedAt: 6 });
    expect(store.connection('нет')).toBeNull();
    expect(store.hasConnectionOf('@HIRE_agent')).toBe(true);
    expect(store.hasConnectionOf('other')).toBe(false);
  });

  it('seen / markSeen / pruneSeen', () => {
    expect(store.seen(-77, 1)).toBeNull();
    store.markSeen(-77, [1, 2], 'answered', null, 1000);
    store.markSeen(-77, [3], 'meeting', 9, 2000);
    expect(store.seen(-77, 2)).toEqual({ outcome: 'answered', meetingId: null });
    expect(store.seen(-77, 3)).toEqual({ outcome: 'meeting', meetingId: 9 });
    expect(store.pruneSeen(1500)).toBe(2);
    expect(store.seen(-77, 1)).toBeNull();
    expect(store.seen(-77, 3)).not.toBeNull();
  });

  it('режимы ожидания: время для «да» и предложенные слоты', () => {
    store.touch(-77, 'rec', 1);
    expect(store.chatExtras(-77)).toEqual({ pendingMeetAt: null, offeredSlots: [] });
    store.setPendingMeet(-77, 5000);
    store.setOfferedSlots(-77, [1, 2, 3]);
    expect(store.chatExtras(-77)).toEqual({ pendingMeetAt: 5000, offeredSlots: [1, 2, 3] });
    store.setPendingMeet(-77, null);
    store.setOfferedSlots(-77, []);
    expect(store.chatExtras(-77)).toEqual({ pendingMeetAt: null, offeredSlots: [] });
    expect(store.chatExtras(-999)).toEqual({ pendingMeetAt: null, offeredSlots: [] });
  });

  it('новые режимы чата живут по сроку', () => {
    store.touch(-77, 'rec', 1);
    store.setMode(-77, 'await_time', 1000);
    expect(store.modeAt(-77, 500)).toBe('await_time');
    expect(store.modeAt(-77, 1000)).toBe('idle');
  });
});

describe('встречи секретаря', () => {
  it('поля секретаря сохраняются и читаются; старые вызовы без них работают', () => {
    const id = meeting({ channel: 'business', peerChatId: 77, sourceMsgId: 9, replacesId: 3 });
    expect(store.meetingById(id)).toMatchObject({
      channel: 'business', peerChatId: 77, sourceMsgId: 9, replacesId: 3, supersededAt: null, remindedAt: null, notifiedAt: null,
    });
    expect(store.meetingById(999)).toBeNull();
  });

  it('pendingMeetings пропускает перенесённые; перенесённая не мешает lastUpcomingMeeting', () => {
    const a = meeting({ meetAt: 50_000, createdAt: 1 });
    const b = meeting({ meetAt: 60_000, createdAt: 2 });
    store.supersedeMeeting(a, 3);
    expect(store.pendingMeetings().map((m) => m.id)).toEqual([b]);
    expect(store.lastUpcomingMeeting(businessKey(77), 10_000)?.id).toBe(b);
    expect(store.lastUpcomingMeeting(businessKey(77), 70_000)).toBeNull();
    expect(store.upcomingMeetings(0, 100_000).map((m) => m.id)).toEqual([b]);
  });

  it('dueReminders: владелец знает, не напомнено, не перенесено, встреча в окне', () => {
    const now = 1_000_000;
    const inWindow = meeting({ meetAt: now + 20 * 60_000 });
    const later = meeting({ meetAt: now + 90 * 60_000 });
    const unknownToOwner = meeting({ meetAt: now + 10 * 60_000 });
    const moved = meeting({ meetAt: now + 15 * 60_000 });
    const past = meeting({ meetAt: now - 60_000 });
    for (const id of [inWindow, later, moved, past]) store.markMeetingNotified(id, 5);
    store.supersedeMeeting(moved, 6);
    expect(store.dueReminders(now, 30).map((m) => m.id)).toEqual([inWindow]);
    store.markReminded(inWindow, now);
    expect(store.dueReminders(now, 30)).toEqual([]);
    void unknownToOwner;
  });
});
