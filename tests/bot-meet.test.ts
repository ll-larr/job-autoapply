import { describe, it, expect } from 'vitest';
import { parseMeetTime } from '../src/bot/meet.js';

const now = new Date(2026, 8, 20, 12, 0); // 20 сентября 2026, локальное время

describe('parseMeetTime', () => {
  it('основной формат дд.мм;чч:мм', () => {
    const r = parseMeetTime('07.10;15:30', now);
    expect(r?.at.getFullYear()).toBe(2026);
    expect(r?.at.getMonth()).toBe(9);
    expect(r?.at.getDate()).toBe(7);
    expect(r?.at.getHours()).toBe(15);
    expect(r?.at.getMinutes()).toBe(30);
    expect(r?.pretty).toBe('07.10 в 15:30');
  });

  it('пробел вместо точки с запятой и точка вместо двоеточия', () => {
    expect(parseMeetTime('7.10 15.30', now)?.pretty).toBe('07.10 в 15:30');
    expect(parseMeetTime('07.10, 15:30', now)?.pretty).toBe('07.10 в 15:30');
  });

  it('дата уже прошла в этом году — значит следующий год', () => {
    const r = parseMeetTime('05.01;10:00', now);
    expect(r?.at.getFullYear()).toBe(2027);
  });

  it('сегодняшний день позже текущего часа берётся сегодня', () => {
    const r = parseMeetTime('20.09;18:00', now);
    expect(r?.at.getFullYear()).toBe(2026);
    expect(r?.at.getDate()).toBe(20);
  });

  it('несуществующая дата — отказ', () => {
    expect(parseMeetTime('31.02;10:00', now)).toBeNull();
    expect(parseMeetTime('31.04;10:00', now)).toBeNull();
  });

  it('29 февраля високосного года принимается', () => {
    expect(parseMeetTime('29.02;10:00', new Date(2027, 11, 1))?.at.getFullYear()).toBe(2028);
  });

  it('мусор и время за пределами суток — отказ', () => {
    expect(parseMeetTime('давайте в среду', now)).toBeNull();
    expect(parseMeetTime('07.10;25:00', now)).toBeNull();
    expect(parseMeetTime('07.13;10:00', now)).toBeNull();
    expect(parseMeetTime('', now)).toBeNull();
  });

  it('лишний текст вокруг даты не мешает', () => {
    expect(parseMeetTime('можно 07.10;15:30 ?', now)?.pretty).toBe('07.10 в 15:30');
  });
});
