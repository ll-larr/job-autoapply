import type { Meeting } from './state.js';
import type { QueueRow } from '../core/queue.js';

/**
 * Файл .ics для владельца (спека 2026-10-09, 6.8): собеседование одним кликом
 * попадает в любой календарь. RFC 5545: CRLF, время в UTC с «Z», экранирование
 * «\ , ; перевод строки», строки не длиннее 75 октетов (перенос с пробелом в
 * начале продолжения). Слов рекрутёра в файле нет — только то, что бот знает
 * сам: кто, какая вакансия, откуда.
 */

export interface IcsOptions {
  slotMinutes: number;
  /** За сколько минут сработает сигнал календаря; null — без сигнала. */
  remindMinutes: number | null;
  /** Аккаунт, к которому подключён секретарь, для строки «Канал». */
  account?: string | null;
  /** Момент создания файла (DTSTAMP). */
  now: number;
}

const escapeText = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

function utc(ms: number): string {
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}`
    + `T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
}

/** Строка длиннее 75 октетов режется; продолжение начинается с пробела. Многобайтовый символ не рвётся. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > limit) {
      out.push(current);
      current = ' ';
      bytes = 1;
      limit = 75;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n');
}

export function meetingIcs(m: Meeting, row: QueueRow | null, opts: IcsOptions): { name: string; content: string } {
  const who = m.username === null ? 'рекрутёр' : `@${m.username}`;
  const title = row?.vacancy.title ?? '';
  const description = [
    `Рекрутёр: ${who}`,
    ...(m.queueId === null ? [] : [`Вакансия #${m.queueId}${title === '' ? '' : `: ${title}`}`]),
    ...(row?.vacancy.url ? [`Ссылка: ${row.vacancy.url}`] : []),
    `Канал: ${m.channel === 'hh' ? 'чат отклика hh.ru' : `личка @${opts.account ?? 'аккаунта'}`}`,
  ].join('\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//job-autoapply//secretary//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:meeting-${m.id}@job-autoapply`,
    `DTSTAMP:${utc(opts.now)}`,
    `DTSTART:${utc(m.meetAt)}`,
    `DTEND:${utc(m.meetAt + opts.slotMinutes * 60_000)}`,
    `SUMMARY:${escapeText(`Собеседование: ${title === '' ? who : title}`)}`,
    `DESCRIPTION:${escapeText(description)}`,
    ...(opts.remindMinutes === null ? [] : [
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Собеседование',
      `TRIGGER:-PT${opts.remindMinutes}M`,
      'END:VALARM',
    ]),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return { name: `meeting-${m.id}.ics`, content: `${lines.map(foldLine).join('\r\n')}\r\n` };
}
