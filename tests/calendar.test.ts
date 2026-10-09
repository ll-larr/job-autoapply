import { describe, it, expect } from 'vitest';
import { freeSlots, pickOffer, checkSlot, formatSlot, formatSlotList } from '../src/bot/calendar.js';
import { DEFAULT_CALENDAR, type CalendarSettings } from '../src/core/settings.js';
import { instantOf, wallClockOf } from '../src/bot/tz.js';

const TZ = 'Europe/Moscow';
const cal = (over: Partial<CalendarSettings> = {}): CalendarSettings => ({
  ...DEFAULT_CALENDAR, slotsEnabled: true, timeZone: TZ, minLeadHours: 0, ...over,
});
/** Момент по московским часам. */
const msk = (d: number, h: number, m = 0, month = 10): number => instantOf({ year: 2026, month, day: d, hour: h, minute: m }, TZ);
/** Пятница 9 октября 2026, 12:00 по Москве. */
const NOW = msk(9, 12);
const dayOf = (t: number): number => wallClockOf(t, TZ).day;

describe('freeSlots', () => {
  it('только рабочие дни (выходные пропущены) и только внутри рабочего окна', () => {
    const slots = freeSlots(NOW, cal({ horizonDays: 5 }), []);
    const days = new Set(slots.map(dayOf));
    expect([...days].sort((a, b) => a - b)).toEqual([9, 12, 13, 14]); // пт 9, пн 12, вт 13, ср 14 (суббота-воскресенье нет)
    for (const t of slots) {
      const w = wallClockOf(t, TZ);
      expect(w.hour * 60 + w.minute).toBeGreaterThanOrEqual(10 * 60);
      expect(w.hour * 60 + w.minute + 60).toBeLessThanOrEqual(19 * 60);
    }
  });

  it('не раньше minLeadHours от «сейчас»', () => {
    const slots = freeSlots(NOW, cal({ minLeadHours: 18, horizonDays: 3 }), []);
    expect(Math.min(...slots)).toBeGreaterThanOrEqual(NOW + 18 * 3_600_000);
  });

  it('встреча с отступом вокруг себя вычёркивает пересекающиеся слоты', () => {
    const meeting = { meetAt: msk(12, 12) }; // пн 12:00; слот 60 мин, отступ 30
    const slots = freeSlots(NOW, cal({ horizonDays: 5 }), [meeting]);
    const monday = slots.filter((t) => dayOf(t) === 12).map((t) => wallClockOf(t, TZ)).map((w) => w.hour * 60 + w.minute);
    // занято [11:30; 13:30): слот [10:30; 11:30) ещё свободен, слоты со стартом с 11:00 до 13:00 включительно пересекаются
    for (const minute of [11 * 60, 11 * 60 + 30, 12 * 60, 12 * 60 + 30, 13 * 60]) expect(monday).not.toContain(minute);
    expect(monday).toContain(10 * 60 + 30);
    expect(monday).toContain(13 * 60 + 30);
  });

  it('горизонт ограничивает выборку; пустой список — когда окон нет', () => {
    expect(freeSlots(NOW, cal({ horizonDays: 0, workDays: [1] }), [])).toEqual([]);
    const near = freeSlots(NOW, cal({ horizonDays: 1 }), []);
    expect(new Set(near.map(dayOf))).toEqual(new Set([9]));
  });
});

describe('pickOffer', () => {
  it('первый свободный в каждый из трёх ближайших дней', () => {
    const slots = freeSlots(NOW, cal({ minLeadHours: 1, horizonDays: 7 }), []);
    const offer = pickOffer(slots, TZ);
    expect(offer).toHaveLength(3);
    expect(offer.map(dayOf)).toEqual([9, 12, 13]);
  });

  it('дней меньше трёх — добираем слотами тех же дней не ближе двух часов', () => {
    const slots = freeSlots(NOW, cal({ minLeadHours: 1, horizonDays: 1 }), []); // только пятница
    const offer = pickOffer(slots, TZ);
    expect(offer.length).toBeGreaterThanOrEqual(2);
    expect(offer.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < offer.length; i += 1) expect(offer[i]! - offer[i - 1]!).toBeGreaterThanOrEqual(2 * 3_600_000);
  });

  it('пусто — пусто', () => {
    expect(pickOffer([], TZ)).toEqual([]);
  });
});

describe('checkSlot', () => {
  it('ok / outside (выходной, до начала, конец выходит за окно) / busy', () => {
    const c = cal();
    expect(checkSlot(msk(12, 15), c, [])).toBe('ok');
    expect(checkSlot(msk(10, 15), c, [])).toBe('outside'); // суббота
    expect(checkSlot(msk(12, 9, 30), c, [])).toBe('outside'); // до начала
    expect(checkSlot(msk(12, 18, 30), c, [])).toBe('outside'); // 18:30 + 60 > 19:00
    expect(checkSlot(msk(12, 18), c, [])).toBe('ok');
    expect(checkSlot(msk(12, 15), c, [{ meetAt: msk(12, 15, 30) }])).toBe('busy');
    expect(checkSlot(msk(12, 15), c, [{ meetAt: msk(12, 17) }])).toBe('ok'); // 17:00 − 30 = 16:30 ≥ 16:00
  });

  it('учитывает пояс владельца, а не пояс машины', () => {
    const berlin = cal({ timeZone: 'Europe/Berlin' });
    // 15:00 по Москве в октябре — 14:00 по Берлину: внутри окна 10–19
    expect(checkSlot(msk(12, 15), berlin, [])).toBe('ok');
    // 08:00 по Москве — 07:00 по Берлину: до начала
    expect(checkSlot(msk(12, 8), berlin, [])).toBe('outside');
  });
});

describe('форматирование слотов', () => {
  it('«• ср, 15 октября — 11:00»', () => {
    expect(formatSlot(msk(14, 11), TZ)).toBe('• ср, 14 октября — 11:00');
    expect(formatSlotList([msk(12, 10), msk(13, 15, 30)], TZ)).toBe('• пн, 12 октября — 10:00\n• вт, 13 октября — 15:30');
  });
});
