import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Dialogs } from '../src/core/dialogs.js';
import { BotStore, businessKey, hhKey } from '../src/bot/state.js';
import { Queue } from '../src/core/queue.js';
import { normalizeVacancy } from '../src/core/vacancy.js';

const H = 3_600_000;
const DAY = 24 * H;
/** Вторник 6 октября 2026, 12:00 по местному времени машины — «сейчас»; его неделя начинается в понедельник 5-го. */
const NOW = new Date(2026, 9, 6, 12, 0).getTime();
const local = (mo: number, d: number, h = 12): number => new Date(2026, mo - 1, d, h).getTime();

let path: string;
let queue: Queue;
let store: BotStore;
let dialogs: Dialogs;
let raw: DatabaseSync;
let seq = 0;

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), 'jaa-dlg-')), 'queue.db');
  queue = new Queue(path);
  store = new BotStore(path);
  dialogs = new Dialogs(path);
  raw = new DatabaseSync(path);
});

/** Строка очереди со статусом sent и заданным временем отправки. */
function sent(source: string, contact: string | null, at: number, title = 'Аналитик'): number {
  seq += 1;
  const v = normalizeVacancy({
    source, sourceId: `s${seq}`, title, company: 'Компания', url: `https://example.org/${seq}`,
    description: 'd', geo: '', postedAt: new Date(at), contact,
  });
  queue.insertPending(v, 10, [], 'письмо', 'hybrid');
  const id = queue.idOf(source, `s${seq}`)!;
  queue.approve(id);
  queue.markSent(id);
  raw.prepare('UPDATE applications SET sent_at = ? WHERE id = ?').run(at, id);
  return id;
}

const ref = (username = 'rec', peer = 77) => ({ channel: 'business' as const, peerKey: String(peer), username });

describe('события диалога', () => {
  it('счётчики, статус «ответил», подпись «@username», сброс причины молчания новым входящим', () => {
    const id = sent('tg', 'rec', NOW - 2 * DAY, 'Системный аналитик');
    dialogs.outgoing(ref(), NOW - 2 * DAY);
    dialogs.incoming(ref(), NOW - DAY, id);
    dialogs.silenced(ref(), 'limit', NOW - DAY + 10);
    dialogs.botReply(ref(), NOW - DAY + 20);
    const [d] = dialogs.list(NOW);
    expect(d).toMatchObject({
      channel: 'business', who: '@rec', username: 'rec', queueId: id, inCount: 1, outCount: 1, botCount: 1,
      status: 'replied', silenced: 'limit',
    });
    expect(d!.vacancy).toEqual({ title: 'Системный аналитик', url: expect.stringContaining('example.org') });
    expect(d!.repliedAfterMs).toBe(DAY);
    dialogs.incoming(ref(), NOW - 1000, null);
    expect(dialogs.list(NOW)[0]).toMatchObject({ silenced: null, inCount: 2, queueId: id });
  });

  it('без username — «id <собеседник>»; пустой диалог — «ждём»', () => {
    dialogs.outgoing({ channel: 'business', peerKey: '55', username: null }, NOW - H);
    expect(dialogs.list(NOW)[0]).toMatchObject({ who: 'id 55', status: 'waiting' });
  });

  it('встреча превращает статус в «собеседование», перенесённая — нет', () => {
    const meetingId = store.saveMeeting({ chatId: businessKey(77), username: 'rec', queueId: null, meetAt: NOW + DAY, raw: '', createdAt: NOW });
    dialogs.incoming(ref(), NOW - H, null);
    dialogs.meeting(ref(), meetingId, NOW);
    expect(dialogs.list(NOW)[0]).toMatchObject({ status: 'meeting', meetingAt: NOW + DAY });
    store.supersedeMeeting(meetingId, NOW + 1);
    expect(dialogs.list(NOW)[0]).toMatchObject({ status: 'replied', meetingAt: null });
  });

  it('hh: приглашение и отказ в статусе; старые диалоги за окно не попадают', () => {
    dialogs.hhEvent(501, 'invite', NOW - H, null);
    dialogs.hhEvent(502, 'reject', NOW - H, null);
    dialogs.hhEvent(503, 'in', NOW - 40 * DAY, null);
    const statuses = dialogs.list(NOW).map((d) => `${d.who}:${d.status}`).sort();
    expect(statuses).toEqual(['чат отклика:invite', 'чат отклика:reject']);
    expect(dialogs.activeCount(NOW)).toBe(2);
  });

  it('в представлениях нет ни одного поля с текстом переписки', () => {
    dialogs.incoming(ref(), NOW - H, null);
    sent('tg', 'rec', NOW - 2 * H);
    const dump = JSON.stringify({ list: dialogs.list(NOW), funnel: dialogs.funnel(NOW) });
    expect(dump).not.toMatch(/"(text|raw|body|message)"/);
  });
});

describe('воронка', () => {
  const row = (rows: ReturnType<Dialogs['funnel']>, week: string, source: string) =>
    rows.find((r) => r.week === week && r.source === source);

  it('ответ в окне между двумя отправками одному контакту засчитывается только первой', () => {
    const first = sent('tg', 'rec', local(10, 1, 12));
    sent('tg', 'rec', local(10, 3, 12));
    // входящие: до первой отправки (не считается), на 2-й день (первой), на 4-й (второй)
    dialogs.incoming(ref(), local(9, 30, 12), first);
    dialogs.incoming(ref(), local(10, 2, 12), first);
    dialogs.incoming(ref(), local(10, 4, 12), first);
    const f = dialogs.funnel(NOW);
    const total = row(f, 'total', 'tg')!;
    expect(total).toMatchObject({ sent: 2, replied: 2 });
    // первая — через 24 ч, вторая — через 24 ч
    expect(total.medianHours).toBe(24);
  });

  it('ответ до отправки не считается', () => {
    const id = sent('tg', 'late', local(10, 5, 12));
    dialogs.incoming(ref('late', 90), local(10, 4, 12), id);
    expect(row(dialogs.funnel(NOW), 'total', 'tg')).toMatchObject({ sent: 1, replied: 0, meetings: 0, medianHours: null });
  });

  it('собеседование: по queue_id встречи и по окну времени в чате; перенесённая не считается; неделя — понедельник', () => {
    const a = sent('tg', 'a', local(9, 28, 12)); // понедельник 28 сентября
    const b = sent('tg', 'b', local(9, 29, 12));
    dialogs.incoming(ref('a', 11), local(9, 29, 12), a);
    dialogs.incoming(ref('b', 12), local(9, 30, 12), b);
    store.saveMeeting({ chatId: businessKey(11), username: 'a', queueId: a, meetAt: NOW + DAY, raw: '', createdAt: local(10, 1) });
    const moved = store.saveMeeting({ chatId: businessKey(12), username: 'b', queueId: null, meetAt: NOW + DAY, raw: '', createdAt: local(10, 1) });
    store.supersedeMeeting(moved, local(10, 2));
    const f = dialogs.funnel(NOW);
    expect(row(f, '2026-09-28', 'tg')).toMatchObject({ sent: 2, replied: 2, meetings: 1 });
  });

  it('по окну времени: встреча в чате без queue_id, созданная после отправки, засчитывается', () => {
    const a = sent('tg', 'a', local(10, 1, 12));
    dialogs.incoming(ref('a', 11), local(10, 1, 14), a);
    store.saveMeeting({ chatId: businessKey(11), username: 'a', queueId: null, meetAt: NOW + DAY, raw: '', createdAt: local(10, 2) });
    expect(row(dialogs.funnel(NOW), 'total', 'tg')).toMatchObject({ meetings: 1 });
  });

  it('hh: приглашение — и ответ, и собеседование; hr.ge и careerist — только «отправлено»', () => {
    const a = sent('hh', null, local(10, 1, 12));
    const b = sent('hh', null, local(10, 1, 13));
    dialogs.hhEvent(701, 'invite', local(10, 2, 12), a);
    dialogs.hhEvent(702, 'in', local(10, 1, 17), b);
    sent('hrge', null, local(10, 1));
    sent('careerist', null, local(10, 1));
    const f = dialogs.funnel(NOW);
    expect(row(f, 'total', 'hh')).toMatchObject({ sent: 2, replied: 2, meetings: 1 });
    expect(row(f, 'total', 'hrge')).toEqual({ week: 'total', source: 'hrge', sent: 1, replied: null, meetings: null, medianHours: null });
    expect(row(f, 'total', 'careerist')?.replied).toBeNull();
  });

  it('медиана — по четному числу ответов это среднее двух средних; один знак после запятой', () => {
    for (const [i, hours] of [1, 2, 4, 9].entries()) {
      const at = local(10, 1, 6) + i * 60_000;
      const id = sent('tg', `m${i}`, at);
      dialogs.incoming(ref(`m${i}`, 100 + i), at + hours * H, id);
    }
    expect(row(dialogs.funnel(NOW), 'total', 'tg')?.medianHours).toBe(3);
  });

  it('за пределами восьми недель не считается; сортировка: недели от новых к старым, итог в конце, внутри недели tg перед hh', () => {
    sent('tg', 'old', NOW - 70 * DAY);
    sent('hh', null, local(10, 1, 9));
    sent('tg', 'x', local(10, 1, 10));
    sent('tg', 'y', local(9, 20, 10));
    const f = dialogs.funnel(NOW);
    expect(f.map((r) => `${r.week}|${r.source}`)).toEqual([
      '2026-09-28|tg', '2026-09-28|hh', '2026-09-14|tg', 'total|tg', 'total|hh',
    ]);
  });

  it('пустая база — пустая воронка', () => {
    expect(dialogs.funnel(NOW)).toEqual([]);
    expect(dialogs.list(NOW)).toEqual([]);
  });

  it('ключи hh и лички не пересекаются в расчёте встреч', () => {
    expect(hhKey(11)).not.toBe(businessKey(11));
  });
});
