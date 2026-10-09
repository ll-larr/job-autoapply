import type { CalendarSettings } from '../core/settings.js';
import { instantOf, wallClockOf, MONTH_NAMES_GEN } from './tz.js';

/**
 * Локальный календарь секретаря (спека 2026-10-09, 6.8): рабочие окна владельца
 * из настроек минус уже записанные встречи. Никакого Google и OAuth — только то,
 * что знает бот. Чистые функции: «сейчас» и список встреч приходят аргументами.
 */

export interface BusyMeeting {
  meetAt: number;
}

const MIN = 60_000;
const SHORT_WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const STEP_MIN = 30;

const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Занятость встречи: сама встреча с отступом до и после. */
function busyInterval(m: BusyMeeting, cal: CalendarSettings): [number, number] {
  return [m.meetAt - cal.bufferMinutes * MIN, m.meetAt + (cal.slotMinutes + cal.bufferMinutes) * MIN];
}

function overlapsBusy(start: number, meetings: readonly BusyMeeting[], cal: CalendarSettings): boolean {
  const end = start + cal.slotMinutes * MIN;
  return meetings.some((m) => {
    const [from, to] = busyInterval(m, cal);
    return start < to && end > from;
  });
}

/** Дата (в поясе владельца) через `plusDays` дней от сегодняшней и её ISO-день недели. */
function dayAt(nowMs: number, plusDays: number, tz: string): { year: number; month: number; day: number; weekday: number } {
  const today = wallClockOf(nowMs, tz);
  const d = new Date(Date.UTC(today.year, today.month - 1, today.day + plusDays));
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    weekday: ((d.getUTCDay() + 6) % 7) + 1,
  };
}

/**
 * Свободные начала встреч: рабочие дни горизонта, шаг 30 минут внутри рабочего
 * окна, не раньше `minLeadHours` от «сейчас» и не пересекающие занятость.
 */
export function freeSlots(nowMs: number, cal: CalendarSettings, meetings: readonly BusyMeeting[]): number[] {
  const out: number[] = [];
  const from = minutesOf(cal.workStart);
  const to = minutesOf(cal.workEnd) - cal.slotMinutes;
  const earliest = nowMs + cal.minLeadHours * 3_600_000;
  for (let plus = 0; plus <= cal.horizonDays; plus += 1) {
    const day = dayAt(nowMs, plus, cal.timeZone);
    if (!cal.workDays.includes(day.weekday)) continue;
    for (let t = from; t <= to; t += STEP_MIN) {
      const start = instantOf({ ...day, hour: Math.floor(t / 60), minute: t % 60 }, cal.timeZone);
      if (start < earliest) continue;
      if (overlapsBusy(start, meetings, cal)) continue;
      out.push(start);
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * 2–3 слота для рекрутёра: первый свободный в каждый из трёх ближайших дней, где
 * они есть. Дней меньше трёх — добираем слотами тех же дней не ближе двух часов к
 * уже выбранным. Не больше трёх; пусто — предлагать нечего.
 */
export function pickOffer(slots: readonly number[], tz: string): number[] {
  const dayOf = (ms: number): string => {
    const w = wallClockOf(ms, tz);
    return `${w.year}-${w.month}-${w.day}`;
  };
  const picked: number[] = [];
  const seenDays = new Set<string>();
  for (const s of slots) {
    const d = dayOf(s);
    if (seenDays.has(d)) continue;
    seenDays.add(d);
    picked.push(s);
    if (picked.length === 3) return picked;
  }
  for (const s of slots) {
    if (picked.length >= 3) break;
    if (picked.includes(s)) continue;
    if (!seenDays.has(dayOf(s))) continue;
    if (picked.every((p) => Math.abs(p - s) >= 2 * 3_600_000)) picked.push(s);
  }
  return picked.sort((a, b) => a - b);
}

export type SlotCheck = 'ok' | 'outside' | 'busy';

/**
 * Годится ли время, которое назвал рекрутёр. outside — вне рабочего дня или
 * окна, busy — пересекается с другой встречей. Запас «не раньше чем через час»
 * проверяет вызывающий: рекрутёр вправе позвать завтра утром, minLeadHours к
 * его выбору не применяется.
 */
export function checkSlot(at: number, cal: CalendarSettings, meetings: readonly BusyMeeting[]): SlotCheck {
  const w = wallClockOf(at, cal.timeZone);
  const minutes = w.hour * 60 + w.minute;
  if (!cal.workDays.includes(w.weekday)
    || minutes < minutesOf(cal.workStart) || minutes + cal.slotMinutes > minutesOf(cal.workEnd)) {
    return 'outside';
  }
  return overlapsBusy(at, meetings, cal) ? 'busy' : 'ok';
}

const two = (n: number): string => String(n).padStart(2, '0');

/** «• ср, 15 октября — 11:00» — строка списка слотов. */
export function formatSlot(at: number, tz: string): string {
  const w = wallClockOf(at, tz);
  return `• ${SHORT_WEEKDAYS[w.weekday - 1]}, ${w.day} ${MONTH_NAMES_GEN[w.month - 1]} — ${two(w.hour)}:${two(w.minute)}`;
}

export function formatSlotList(slots: readonly number[], tz: string): string {
  return slots.map((s) => formatSlot(s, tz)).join('\n');
}
