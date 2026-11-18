/**
 * Разбор чужого файла — отдельным процессом (см. src/bot/extract.ts).
 * Печатает текст в stdout; при ошибке — причину в stderr и код 1.
 *
 * Отдельный процесс именно здесь, потому что это единственное место бота, где
 * исполняется код над данными, присланными незнакомым человеком.
 */
import { readFileSync } from 'node:fs';
import { extractPdfText } from '../src/core/resume.js';
import { extractDocxText } from '../src/bot/extract.js';

const path = process.argv[2];
const kind = process.argv[3];

if (path === undefined || kind === undefined) {
  process.stderr.write('нужны аргументы: <путь> <pdf|docx>\n');
  process.exit(1);
}

try {
  const text = kind === 'pdf'
    ? await extractPdfText(path)
    : extractDocxText(new Uint8Array(readFileSync(path)));
  process.stdout.write(text);
} catch (e) {
  process.stderr.write(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
