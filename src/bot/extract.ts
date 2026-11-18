import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

/**
 * Чтение присланного файла. Разбор идёт в ДОЧЕРНЕМ процессе: unpdf/pdf.js на
 * чужом файле — единственное место, где враждебные байты вообще что-то
 * исполняют, пусть и в песочнице JS (спека 2026-09-20, 5.5). Зависший или
 * взорвавшийся разбор убивается по таймауту и роняет ровно себя, а не бота.
 *
 * txt и md читаются на месте: там нет ни парсера, ни формата — только
 * декодирование в UTF-8.
 */

const TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export type ExtractResult = { ok: true; text: string } | { ok: false; error: string };

export function extractDocxText(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' });
  const doc = files['word/document.xml'];
  if (doc === undefined) throw new Error('в docx нет word/document.xml');
  return strFromU8(doc)
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractFileText(path: string, kind: 'pdf' | 'docx' | 'text'): Promise<ExtractResult> {
  if (kind === 'text') {
    try {
      return Promise.resolve({ ok: true, text: readFileSync(path, 'utf8') });
    } catch (e) {
      return Promise.resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'scripts/extract-file.ts', path, kind],
      { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (error !== null) {
          const killed = error.killed === true || error.signal !== null;
          const reason = killed ? 'разбор занял больше 10 секунд' : (stderr.trim() || error.message);
          resolve({ ok: false, error: reason });
          return;
        }
        resolve({ ok: true, text: stdout.trim() });
      },
    );
  });
}
