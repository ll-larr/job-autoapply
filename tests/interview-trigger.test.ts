import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { isSberVacancy, triggerInterview, spawnInterview, type SpawnFn } from '../src/core/interview-trigger.js';
import type { GigarecruiterConfig } from '../src/core/config.js';

const CONFIG: GigarecruiterConfig = {
  username: 'Giga_recruiter_bot',
  windowMinutes: 120,
  idleMinutes: 10,
  pollHours: 4,
  replyDelaySec: [40, 120],
  maxReplyLength: 1500,
  maxRepliesPerSession: 12,
  vpnService: 'HappService',
  vpnApp: 'D:\\Happ\\Happ.exe',
};

describe('isSberVacancy', () => {
  it('узнаёт «ПАО Сбербанк» в компании', () => {
    expect(isSberVacancy({ company: 'ПАО Сбербанк', title: 'Аналитик' })).toBe(true);
  });

  it('узнаёт «SberTech» в компании — латиница', () => {
    expect(isSberVacancy({ company: 'SberTech', title: 'Аналитик' })).toBe(true);
  });

  it('узнаёт «Сбер» в заголовке, если компания не совпала', () => {
    expect(isSberVacancy({ company: 'ООО Рога и копыта', title: 'Аналитик — Сбер' })).toBe(true);
  });

  it('не путает с «Озон Банк»', () => {
    expect(isSberVacancy({ company: 'Озон Банк', title: 'Аналитик' })).toBe(false);
  });

  it('не путает с «Тинькофф»', () => {
    expect(isSberVacancy({ company: 'Тинькофф', title: 'Аналитик' })).toBe(false);
  });
});

describe('triggerInterview', () => {
  it('блока gigarecruiter нет — false, окно не открывается, процесс не запускается', () => {
    const openWindow = vi.fn();
    const spawn = vi.fn();
    const result = triggerInterview(
      { company: 'ПАО Сбербанк', title: 'Аналитик' },
      { config: undefined, now: () => 1_000, openWindow, spawnInterview: spawn },
    );
    expect(result).toBe(false);
    expect(openWindow).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('вакансия не Сбер — false, ничего не делает', () => {
    const openWindow = vi.fn();
    const spawn = vi.fn();
    const result = triggerInterview(
      { company: 'Тинькофф', title: 'Аналитик' },
      { config: CONFIG, now: () => 1_000, openWindow, spawnInterview: spawn },
    );
    expect(result).toBe(false);
    expect(openWindow).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('вакансия Сбера и блок настроен — окно открыто, процесс запущен, true', () => {
    const openWindow = vi.fn();
    const spawn = vi.fn();
    const result = triggerInterview(
      { company: 'ПАО Сбербанк', title: 'Аналитик' },
      { config: CONFIG, now: () => 1_000, openWindow, spawnInterview: spawn },
    );
    expect(result).toBe(true);
    expect(openWindow).toHaveBeenCalledWith(1_000, 120);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('spawnInterview (боевой запуск)', () => {
  it('поднимает npm run interview отсоединённым процессом через cmd.exe', () => {
    const calls: unknown[] = [];
    const fakeSpawn: SpawnFn = (command, args, options) => {
      calls.push([command, args, options]);
      return Object.assign(new EventEmitter(), { unref: () => { calls.push('unref'); } });
    };

    spawnInterview('C:\\repo', { spawn: fakeSpawn });

    expect(calls[0]).toEqual([
      'cmd.exe',
      ['/c', 'npm', 'run', 'interview'],
      { cwd: 'C:\\repo', detached: true, stdio: 'ignore', windowsHide: true },
    ]);
    expect(calls[1]).toBe('unref');
  });
});

describe('spawnInterview: асинхронный сбой запуска (M2)', () => {
  it('событие error отсоединённого процесса не роняет вызывающий процесс и уходит в onError', () => {
    const child = Object.assign(new EventEmitter(), { unref: () => {} });
    const errors: string[] = [];
    spawnInterview('C:\\repo', { spawn: () => child, onError: (e) => { errors.push(e.message); } });
    // Без слушателя EventEmitter бросает 'error' наружу — `npm run send` упал бы
    // уже после того, как хук вернулся и его try/catch в Sender остался позади.
    expect(() => child.emit('error', new Error('spawn cmd.exe ENOENT'))).not.toThrow();
    expect(errors).toEqual(['spawn cmd.exe ENOENT']);
  });

  it('без onError ошибка просто проглатывается', () => {
    const child = Object.assign(new EventEmitter(), { unref: () => {} });
    spawnInterview('C:\\repo', { spawn: () => child });
    expect(() => child.emit('error', new Error('EACCES'))).not.toThrow();
  });
});
