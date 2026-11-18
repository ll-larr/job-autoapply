import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Один экземпляр автоответа ГигаРекрутёру (R10): триггер отклика и поллинг
 * по расписанию могут стартовать одновременно и ответить дважды.
 *
 * В файле — pid и метка времени (D1): `{"pid":4242,"at":1790000000000}`.
 * Живой цикл продлевает метку на каждом шаге, поэтому метка старше
 * LOCK_MAX_AGE_MS значит «владелец давно не подаёт признаков жизни», а не
 * «сессия идёт долго». Такая блокировка брошена, даже если её pid занят:
 * Windows быстро отдаёт pid другим процессам, а EPERM считается «жив», и без
 * срока годности выключение машины посреди сессии останавливало бы
 * автоответ навсегда и молча.
 */

export const LOCK_PATH = 'data/interview.lock';
/** Метка старше трёх часов — блокировка брошена (D1). */
export const LOCK_MAX_AGE_MS = 3 * 60 * 60_000;

/** at: null — старый формат, в файле только pid; срока годности у него нет. */
interface LockRecord {
  pid: number;
  at: number | null;
}

function parseLock(raw: string): LockRecord | null {
  if (/^\d+$/.test(raw)) return { pid: Number(raw), at: null };
  try {
    const j = JSON.parse(raw) as { pid?: unknown; at?: unknown };
    if (typeof j.pid === 'number' && Number.isInteger(j.pid) && j.pid > 0
      && typeof j.at === 'number' && Number.isFinite(j.at)) {
      return { pid: j.pid, at: j.at };
    }
  } catch { /* мусор */ }
  return null;
}

const lockText = (pid: number, now: number): string => JSON.stringify({ pid, at: now });

function readRaw(path: string): string | null {
  try { return readFileSync(path, 'utf8').trim(); } catch { return null; }
}

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
 * Один экземпляр (R10, D1). Живой владелец со свежей меткой — отказ. Мёртвый
 * pid, метка старше LOCK_MAX_AGE_MS, мусор в файле или наш же pid
 * (переиспользован после падения) — перехват. Файл старого формата (только
 * pid) судится, как раньше, по одному pid.
 */
export function acquireLock(
  path: string,
  pid: number,
  isAlive: (pid: number) => boolean = pidAlive,
  now: number = Date.now(),
): { ok: true; stale: string | null } | { ok: false; holder: number } {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, lockText(pid, now), { encoding: 'utf8', flag: 'wx' });
    return { ok: true, stale: null };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const raw = readRaw(path) ?? ''; // сняли между попытками — перехватываем пустое
  const held = parseLock(raw);
  const fresh = held !== null && (held.at === null || now - held.at < LOCK_MAX_AGE_MS);
  if (held !== null && held.pid !== pid && fresh && isAlive(held.pid)) return { ok: false, holder: held.pid };
  writeFileSync(path, lockText(pid, now), 'utf8');
  return { ok: true, stale: raw };
}

/**
 * Продлевает свою блокировку: метка сдвигается на `now`. false — блокировка
 * уже не наша (её сняли или перехватили как брошенную), работать дальше
 * нельзя: в чате оказались бы два цикла.
 */
export function refreshLock(path: string, pid: number, now: number): boolean {
  const raw = readRaw(path);
  if (raw === null || parseLock(raw)?.pid !== pid) return false;
  try {
    writeFileSync(path, lockText(pid, now), 'utf8');
  } catch { /* метка не продлилась — не повод бросать разговор, попробуем на следующем шаге */ }
  return true;
}

/** Снимает только свою блокировку: чужую, перехваченную у нас, не трогаем. */
export function releaseLock(path: string, pid: number): void {
  const raw = readRaw(path);
  if (raw === null || parseLock(raw)?.pid !== pid) return;
  try { rmSync(path); } catch { /* файла уже нет */ }
}
