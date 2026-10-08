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
 * С 2026-10-08 резюме берётся только из того, что прикреплено в настройках
 * (см. resumeTextFor): прежний запасной resume.md убран.
 */

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

/**
 * Текст резюме, прикреплённого к специальности в настройках, и больше ничего:
 * решение владельца 2026-10-08. Запасного резюме нет — ни resume.md, ни
 * «резюме БА»: письмо по резюме, о котором владелец не знает, хуже отсутствия
 * письма. Нет PDF или текст не извлёкся — ошибка с названием специальности;
 * вызывающий превращает её в пустое письмо с причиной (письмо допишет человек).
 * Поиск перед стартом зовёт refreshResumeCache, панель — при сохранении
 * настроек, так что кеш к этому моменту свежий.
 */
export function resumeTextFor(specialty: Specialty, opts: { cacheDir?: string } = {}): string {
  if (specialty.resumePdf === null) {
    throw new Error(
      `К специальности «${specialty.name}» не прикреплено резюме — добавь PDF во вкладке «Настройки»`,
    );
  }
  const cached = cachePath(specialty, opts.cacheDir ?? RESUME_CACHE_DIR);
  if (!existsSync(cached)) {
    throw new Error(
      `Текст резюме специальности «${specialty.name}» не извлечён из ${specialty.resumePdf} — `
      + 'проверь, что файл на месте и в нём есть текст',
    );
  }
  return readFileSync(cached, 'utf8');
}
