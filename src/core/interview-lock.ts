import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Один экземпляр автоответа ГигаРекрутёру (R10): триггер отклика и поллинг
 * по расписанию могут стартовать одновременно и ответить дважды.
 */

export const LOCK_PATH = 'data/interview.lock';

/** Жив ли процесс. EPERM — процесс есть, просто чужой. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Один экземпляр (R10): файл с pid. Живой владелец — отказ. Мёртвый, мусор в
 * файле или наш же pid (переиспользован после падения) — перехват.
 */
export function acquireLock(
  path: string,
  pid: number,
  isAlive: (pid: number) => boolean = pidAlive,
): { ok: true; stale: string | null } | { ok: false; holder: number } {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, String(pid), { encoding: 'utf8', flag: 'wx' });
    return { ok: true, stale: null };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  let raw = '';
  try { raw = readFileSync(path, 'utf8').trim(); } catch { /* сняли между попытками */ }
  const holder = Number(raw);
  if (/^\d+$/.test(raw) && holder !== pid && isAlive(holder)) return { ok: false, holder };
  writeFileSync(path, String(pid), 'utf8');
  return { ok: true, stale: raw };
}

/** Снимает только свою блокировку: чужую, перехваченную у нас, не трогаем. */
export function releaseLock(path: string, pid: number): void {
  try {
    if (readFileSync(path, 'utf8').trim() === String(pid)) rmSync(path);
  } catch { /* файла уже нет */ }
}
