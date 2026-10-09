import { describe, it, expect } from 'vitest';
import { meetingIcs, foldLine } from '../src/bot/ics.js';
import type { Meeting } from '../src/bot/state.js';
import type { QueueRow } from '../src/core/queue.js';
import { normalizeVacancy } from '../src/core/vacancy.js';

const meeting: Meeting = {
  id: 7, chatId: -77, username: 'rec', queueId: 12, meetAt: Date.UTC(2026, 9, 10, 12, 0), raw: 'СЕКРЕТНАЯ ФРАЗА рекрутёра',
  createdAt: Date.UTC(2026, 9, 9, 9, 0), channel: 'business', peerChatId: 77,
};
const row = {
  id: 12,
  vacancy: normalizeVacancy({
    source: 'tg', sourceId: '1', title: 'Системный аналитик, ЖКХ; Москва', company: '', url: 'https://t.me/jobs/5',
    description: 'd', geo: '', postedAt: new Date(0),
  }),
} as unknown as QueueRow;
const NOW = Date.UTC(2026, 9, 9, 9, 5);

describe('meetingIcs', () => {
  const ics = meetingIcs(meeting, row, { slotMinutes: 60, remindMinutes: 30, account: 'HIRE_agent', now: NOW });

  it('имя файла и каркас RFC 5545: CRLF везде, UTC с «Z»', () => {
    expect(ics.name).toBe('meeting-7.ics');
    expect(ics.content.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.content.endsWith('END:VEVENT\r\nEND:VCALENDAR\r\n')).toBe(true);
    expect(ics.content.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(ics.content).toContain('PRODID:-//job-autoapply//secretary//RU');
    expect(ics.content).toContain('METHOD:PUBLISH');
    expect(ics.content).toContain('UID:meeting-7@job-autoapply');
    expect(ics.content).toContain('DTSTAMP:20261009T090500Z');
    expect(ics.content).toContain('DTSTART:20261010T120000Z');
    expect(ics.content).toContain('DTEND:20261010T130000Z');
  });

  it('запятая и точка с запятой в названии экранированы, слов рекрутёра в файле нет', () => {
    const unfolded = ics.content.replace(/\r\n /g, '');
    expect(unfolded).toContain('SUMMARY:Собеседование: Системный аналитик\\, ЖКХ\\; Москва');
    expect(unfolded).toContain('Рекрутёр: @rec\\nВакансия #12: Системный аналитик\\, ЖКХ\\; Москва\\nСсылка: https://t.me/jobs/5\\nКанал: личка @HIRE_agent');
    expect(ics.content).not.toContain('СЕКРЕТНАЯ');
  });

  it('сигнал календаря — только когда напоминание включено', () => {
    expect(ics.content).toContain('BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Собеседование\r\nTRIGGER:-PT30M\r\nEND:VALARM');
    const quiet = meetingIcs(meeting, row, { slotMinutes: 60, remindMinutes: null, now: NOW });
    expect(quiet.content).not.toContain('VALARM');
  });

  it('вакансии нет — в заголовке @username; hh — канал «чат отклика»', () => {
    const bare = meetingIcs({ ...meeting, queueId: null, channel: 'hh' }, null, { slotMinutes: 45, remindMinutes: null, now: NOW });
    expect(bare.content).toContain('SUMMARY:Собеседование: @rec');
    expect(bare.content).toContain('Канал: чат отклика hh.ru');
    expect(bare.content).toContain('DTEND:20261010T124500Z');
  });
});

describe('foldLine', () => {
  const unfold = (s: string): string => s.replace(/\r\n /g, '');

  it('короткая строка не меняется', () => {
    expect(foldLine('SUMMARY:ok')).toBe('SUMMARY:ok');
  });

  it('длинная режется на куски не длиннее 75 октетов, продолжение начинается с пробела, склейка возвращает исходную', () => {
    const long = `DESCRIPTION:${'Собеседование по вакансии аналитика '.repeat(6)}`;
    const folded = foldLine(long);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(75);
    for (const p of parts.slice(1)) expect(p.startsWith(' ')).toBe(true);
    expect(unfold(folded)).toBe(long);
  });

  it('многобайтовый символ на границе не рвётся', () => {
    const line = `X:${'я'.repeat(80)}`;
    for (const p of foldLine(line).split('\r\n')) expect(Buffer.from(p, 'utf8').toString('utf8')).toBe(p);
  });
});
