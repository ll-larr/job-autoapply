import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock, pidAlive } from '../src/core/interview-lock.js';

describe('блокировка одного экземпляра', () => {
  const lockIn = (): string => join(mkdtempSync(join(tmpdir(), 'lock-')), 'interview.lock');

  it('свободна — захватывается, в файле наш pid', () => {
    const path = lockIn();
    expect(acquireLock(path, 4242, () => true)).toEqual({ ok: true, stale: null });
    expect(readFileSync(path, 'utf8')).toBe('4242');
  });

  it('держит живой pid — отказ, файл не тронут', () => {
    const path = lockIn();
    writeFileSync(path, '999', 'utf8');
    expect(acquireLock(path, 4242, (pid) => pid === 999)).toEqual({ ok: false, holder: 999 });
    expect(readFileSync(path, 'utf8')).toBe('999');
  });

  it('pid мёртв — перехватывается', () => {
    const path = lockIn();
    writeFileSync(path, '999', 'utf8');
    expect(acquireLock(path, 4242, () => false)).toEqual({ ok: true, stale: '999' });
    expect(readFileSync(path, 'utf8')).toBe('4242');
  });

  it('мусор в файле — перехватывается, а не блокирует навсегда', () => {
    const path = lockIn();
    writeFileSync(path, '', 'utf8');
    expect(acquireLock(path, 4242, () => true).ok).toBe(true);
  });

  it('снимается только своя блокировка', () => {
    const path = lockIn();
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
