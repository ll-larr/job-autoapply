import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock, releaseLock, refreshLock, pidAlive, LOCK_MAX_AGE_MS,
} from '../src/core/interview-lock.js';

const HOUR = 60 * 60_000;
const NOW = 1_790_000_000_000;
const lockIn = (): string => join(mkdtempSync(join(tmpdir(), 'lock-')), 'interview.lock');
const record = (pid: number, at: number): string => JSON.stringify({ pid, at });
const readLock = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

describe('блокировка одного экземпляра', () => {
  it('свободна — захватывается, в файле наш pid и время захвата', () => {
    const path = lockIn();
    expect(acquireLock(path, 4242, () => true, NOW)).toEqual({ ok: true, stale: null });
    expect(readLock(path)).toEqual({ pid: 4242, at: NOW });
  });

  it('держит живой pid, метке меньше трёх часов — отказ, файл не тронут', () => {
    const path = lockIn();
    const held = record(999, NOW - 3 * HOUR + 60_000);
    writeFileSync(path, held, 'utf8');
    expect(acquireLock(path, 4242, (pid) => pid === 999, NOW)).toEqual({ ok: false, holder: 999 });
    expect(readFileSync(path, 'utf8')).toBe(held);
  });

  it('метка старше трёх часов — перехват, даже если pid занят живым процессом (D1)', () => {
    const path = lockIn();
    const held = record(999, NOW - LOCK_MAX_AGE_MS - 1);
    writeFileSync(path, held, 'utf8');
    expect(acquireLock(path, 4242, () => true, NOW)).toEqual({ ok: true, stale: held });
    expect(readLock(path)).toEqual({ pid: 4242, at: NOW });
  });

  it('свежая метка, но pid мёртв — перехват', () => {
    const path = lockIn();
    writeFileSync(path, record(999, NOW - 60_000), 'utf8');
    expect(acquireLock(path, 4242, () => false, NOW).ok).toBe(true);
    expect(readLock(path)).toEqual({ pid: 4242, at: NOW });
  });

  it('старый формат, только pid: живой — отказ, как раньше', () => {
    const path = lockIn();
    writeFileSync(path, '999', 'utf8');
    expect(acquireLock(path, 4242, (pid) => pid === 999, NOW)).toEqual({ ok: false, holder: 999 });
    expect(readFileSync(path, 'utf8')).toBe('999');
  });

  it('старый формат, только pid: мёртвый — перехват', () => {
    const path = lockIn();
    writeFileSync(path, '999', 'utf8');
    expect(acquireLock(path, 4242, () => false, NOW)).toEqual({ ok: true, stale: '999' });
    expect(readLock(path)).toEqual({ pid: 4242, at: NOW });
  });

  it('мусор в файле — перехватывается, а не блокирует навсегда', () => {
    const path = lockIn();
    writeFileSync(path, '', 'utf8');
    expect(acquireLock(path, 4242, () => true, NOW).ok).toBe(true);
    writeFileSync(path, '{"pid":"999"}', 'utf8');
    expect(acquireLock(path, 4242, () => true, NOW).ok).toBe(true);
  });

  it('снимается только своя блокировка — в обоих форматах', () => {
    const path = lockIn();
    writeFileSync(path, record(999, NOW), 'utf8');
    releaseLock(path, 4242);
    expect(existsSync(path)).toBe(true);
    releaseLock(path, 999);
    expect(existsSync(path)).toBe(false);

    writeFileSync(path, '999', 'utf8');
    releaseLock(path, 4242);
    expect(existsSync(path)).toBe(true);
    releaseLock(path, 999);
    expect(existsSync(path)).toBe(false);
  });

  it('pidAlive: свой процесс жив, заведомо несуществующий — нет', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 30 + 12344)).toBe(false);
  });
});

describe('refreshLock: живой владелец продлевает метку', () => {
  it('своя блокировка — метка сдвигается, true', () => {
    const path = lockIn();
    acquireLock(path, 4242, () => true, NOW);
    expect(refreshLock(path, 4242, NOW + 5 * HOUR)).toBe(true);
    expect(readLock(path)).toEqual({ pid: 4242, at: NOW + 5 * HOUR });
  });

  it('продлённая блокировка живого не считается брошенной и через пять часов работы', () => {
    const path = lockIn();
    acquireLock(path, 4242, () => true, NOW);
    refreshLock(path, 4242, NOW + 5 * HOUR);
    expect(acquireLock(path, 7, (pid) => pid === 4242, NOW + 5 * HOUR + 60_000)).toEqual({ ok: false, holder: 4242 });
  });

  it('блокировку перехватили — false, чужой файл не тронут', () => {
    const path = lockIn();
    const other = record(7, NOW);
    writeFileSync(path, other, 'utf8');
    expect(refreshLock(path, 4242, NOW + 60_000)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(other);
  });

  it('файла нет — false', () => {
    expect(refreshLock(lockIn(), 4242, NOW)).toBe(false);
  });
});
