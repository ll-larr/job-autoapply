import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractText, getDocumentProxy } from 'unpdf';
import type { Specialty } from './specialty.js';

/**
 * Текст резюме, по которому пишутся письма специальности (спека 3.7).
 *
 * У специальности есть PDF — он уходит вложением в Telegram, и из него же
 * извлекается текст для писем. Извлечение небыстрое, поэтому текст кешируется
 * в data/resumes/<id>.txt и обновляется, только когда PDF новее кеша.
 *
 * Засеянные специальности (legacyLetters) пишут по прежнему .md: письма БА не
 * должны поменяться от того, что текст теперь можно брать из PDF.
 */

export const LEGACY_RESUME_MD = 'CV кандидат Бизнес-аналитик.md';
export const RESUME_CACHE_DIR = 'data/resumes';

export async function extractPdfText(path: string): Promise<string> {
  let data: Uint8Array;
  try {
    data = new Uint8Array(readFileSync(path));
  } catch (e) {
    throw new Error(`${path}: не читается (${e instanceof Error ? e.message : String(e)})`);
  }
  // verbosity 0: pdf.js иначе сыплет в консоль «TT: undefined function» на
  // шрифтах, собранных генератором резюме, — шум, а не ошибка.
  const pdf = await getDocumentProxy(data, { verbosity: 0 });
  const { text } = await extractText(pdf, { mergePages: true });
  return text.trim();
}

function cachePath(specialty: Specialty, cacheDir: string): string {
  return join(cacheDir, `${specialty.id}.txt`);
}

export async function refreshResumeCache(
  specialty: Specialty,
  cacheDir: string = RESUME_CACHE_DIR,
): Promise<{ ok: true; chars: number } | { ok: false; error: string }> {
  if (specialty.resumePdf === null) return { ok: true, chars: 0 };
  const target = cachePath(specialty, cacheDir);
  try {
    if (existsSync(target) && statSync(target).mtimeMs >= statSync(specialty.resumePdf).mtimeMs) {
      return { ok: true, chars: readFileSync(target, 'utf8').length };
    }
    const text = await extractPdfText(specialty.resumePdf);
    if (text.length < 20) {
      return { ok: false, error: `${specialty.resumePdf}: текста почти нет — похоже, PDF из картинок` };
    }
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(target, text, 'utf8');
    return { ok: true, chars: text.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function resumeTextFor(
  specialty: Specialty,
  opts: { cacheDir?: string; legacyMdPath?: string } = {},
): string {
  const legacy = opts.legacyMdPath ?? LEGACY_RESUME_MD;
  if (specialty.legacyLetters || specialty.resumePdf === null) return readFileSync(legacy, 'utf8');
  const cached = cachePath(specialty, opts.cacheDir ?? RESUME_CACHE_DIR);
  // Кеша нет — резюме БА, как у специальности без PDF (спека 3.7). Поиск
  // перед стартом зовёт refreshResumeCache, так что сюда попадает только
  // PDF, который не извлёкся; панель об этом уже сказала при сохранении.
  return existsSync(cached) ? readFileSync(cached, 'utf8') : readFileSync(legacy, 'utf8');
}
