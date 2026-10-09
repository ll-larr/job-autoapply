import { describe, it, expect } from 'vitest';
import { meetingPing } from '../src/bot/ping.js';
import type { Meeting } from '../src/bot/state.js';

const at = (d: number, h: number): number => new Date(2026, 9, d, h, 0).getTime();
const base: Meeting = {
  id: 1, chatId: -77, username: 'rec', queueId: null, meetAt: at(10, 15), raw: 'давай завтра в 15', createdAt: at(9, 12),
};

describe('meetingPing — секретарь', () => {
  it('без опций и без канала вывод прежний', () => {
    const p = meetingPing({ ...base, chatId: 77 }, null);
    expect(p.text.split('\n')).toEqual([
      'Собеседование: 10 октября (суббота), 15:00',
      'Рекрутёр: @rec',
      'Он написал: «давай завтра в 15»',
      'вакансию он не присылал',
    ]);
  });

  it('личка аккаунта: «Рекрутёр: @user (личка @HIRE_agent)»', () => {
    const p = meetingPing({ ...base, channel: 'business', peerChatId: 77 }, null, { account: 'HIRE_agent' });
    expect(p.text.split('\n')[1]).toBe('Рекрутёр: @rec (личка @HIRE_agent)');
  });

  it('рекрутёр без username — id собеседника, а не отрицательный ключ чата', () => {
    const p = meetingPing({ ...base, username: null, channel: 'business', peerChatId: 77 }, null, { account: 'HIRE_agent' });
    expect(p.text).toContain('Рекрутёр: id 77 (личка @HIRE_agent)');
  });

  it('перенос: первой строкой «Перенос: было …»', () => {
    const previous: Meeting = { ...base, id: 0, meetAt: at(11, 12), createdAt: at(9, 11) };
    const p = meetingPing({ ...base, channel: 'business', peerChatId: 77, replacesId: 0 }, null, { account: 'HIRE_agent', previous });
    expect(p.text.split('\n').slice(0, 2)).toEqual(['Перенос: было 11 октября (воскресенье), 12:00', 'Собеседование: 10 октября (суббота), 15:00']);
  });

  it('hh: «Работодатель: компания (чат отклика hh.ru)», строки «Он написал» нет', () => {
    const p = meetingPing({ ...base, channel: 'hh', raw: '' }, null);
    expect(p.text).toContain('Работодатель: не названа (чат отклика hh.ru)');
    expect(p.text).not.toContain('Он написал');
  });

  it('слова рекрутёра по-прежнему режутся по длине', () => {
    const p = meetingPing({ ...base, channel: 'business', peerChatId: 77, raw: 'ж'.repeat(500) }, null);
    expect(p.text.length).toBeLessThan(700);
  });
});
