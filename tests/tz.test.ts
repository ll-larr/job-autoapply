import { describe, it, expect } from 'vitest';
import {
  wallClockOf, instantOf, isValidTimeZone, formatInZone, tzLabel, asLocalDate, instantOfLocalDate,
} from '../src/bot/tz.js';

const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi);

describe('часовые пояса', () => {
  it('isValidTimeZone: имена IANA — да, мусор — нет', () => {
    expect(isValidTimeZone('Europe/Moscow')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Base')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(5)).toBe(false);
  });

  it('Москва без переходов: UTC+3 круглый год', () => {
    expect(wallClockOf(utc(2026, 10, 9, 9, 0), 'Europe/Moscow')).toEqual({
      year: 2026, month: 10, day: 9, hour: 12, minute: 0, weekday: 5,
    });
    expect(instantOf({ year: 2026, month: 10, day: 10, hour: 15, minute: 0 }, 'Europe/Moscow')).toBe(utc(2026, 10, 10, 12, 0));
    expect(instantOf({ year: 2026, month: 1, day: 10, hour: 15, minute: 0 }, 'Europe/Moscow')).toBe(utc(2026, 1, 10, 12, 0));
  });

  it('полночь — час 0, а не 24; день недели ISO (воскресенье — 7)', () => {
    const w = wallClockOf(utc(2026, 10, 10, 21, 0), 'Europe/Moscow');
    expect(w).toMatchObject({ day: 11, hour: 0, weekday: 7 });
  });

  it('Берлин: перевод вперёд 2026-03-29 — несуществующее 02:30 даёт 03:30 (первый момент после пропуска)', () => {
    const t = instantOf({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, 'Europe/Berlin');
    expect(wallClockOf(t, 'Europe/Berlin')).toMatchObject({ day: 29, hour: 3, minute: 30 });
    expect(t).toBe(utc(2026, 3, 29, 1, 30));
  });

  it('Берлин: перевод назад 2026-10-25 — повторяющееся 02:30 даёт первое вхождение (летнее)', () => {
    const t = instantOf({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, 'Europe/Berlin');
    expect(t).toBe(utc(2026, 10, 25, 0, 30));
    expect(wallClockOf(t, 'Europe/Berlin')).toMatchObject({ hour: 2, minute: 30 });
  });

  it('Берлин: обычное время зимой и летом', () => {
    expect(instantOf({ year: 2026, month: 1, day: 15, hour: 10, minute: 0 }, 'Europe/Berlin')).toBe(utc(2026, 1, 15, 9, 0));
    expect(instantOf({ year: 2026, month: 7, day: 15, hour: 10, minute: 0 }, 'Europe/Berlin')).toBe(utc(2026, 7, 15, 8, 0));
  });

  it('instantOf и wallClockOf взаимно обратны на сетке часов', () => {
    for (const tz of ['Europe/Moscow', 'Europe/Berlin', 'Asia/Kolkata', 'America/New_York']) {
      for (const d of [utc(2026, 3, 1), utc(2026, 7, 4), utc(2026, 11, 20)]) {
        for (let h = 0; h < 24; h += 5) {
          const t = d + h * 3_600_000;
          const w = wallClockOf(t, tz);
          const back = instantOf(w, tz);
          expect(wallClockOf(back, tz)).toEqual(w);
        }
      }
    }
  });

  it('formatInZone: тот же вид, что у formatMeetTime; чужой год называется', () => {
    const now = utc(2026, 10, 9, 9, 0);
    expect(formatInZone(utc(2026, 10, 10, 12, 0), now, 'Europe/Moscow')).toBe('10 октября (суббота), 15:00');
    expect(formatInZone(utc(2027, 1, 5, 7, 0), now, 'Europe/Moscow')).toBe('5 января 2027 (вторник), 10:00');
  });

  it('tzLabel', () => {
    expect(tzLabel('Europe/Moscow')).toBe('по Москве');
    expect(tzLabel('Europe/Berlin')).toBe('по Europe/Berlin');
  });

  it('asLocalDate / instantOfLocalDate: стенные часы пояса читаются как местные поля Date и обратно', () => {
    const now = utc(2026, 10, 9, 9, 0);
    const local = asLocalDate(now, 'Europe/Moscow');
    expect([local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes()]).toEqual([2026, 9, 9, 12, 0]);
    expect(instantOfLocalDate(local, 'Europe/Moscow')).toBe(now);
  });
});
