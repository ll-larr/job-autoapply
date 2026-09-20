import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { extractFileText, extractDocxText } from '../src/bot/extract.js';

const dir = mkdtempSync(join(tmpdir(), 'jaa-extract-'));

const docx = (paragraphs: string[]): Uint8Array => zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
  'word/document.xml': strToU8(
    `<?xml version="1.0"?><w:document><w:body>${
      paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')
    }</w:body></w:document>`,
  ),
});

describe('extractDocxText', () => {
  it('склеивает абзацы и снимает теги', () => {
    const text = extractDocxText(docx(['Бизнес-аналитик', 'Требования: SQL, BPMN']));
    expect(text).toContain('Бизнес-аналитик');
    expect(text).toContain('SQL');
    expect(text).not.toContain('<w:t>');
  });

  it('zip без word/document.xml — внятная ошибка', () => {
    const notDocx = zipSync({ 'readme.txt': strToU8('просто архив') });
    expect(() => extractDocxText(notDocx)).toThrow(/word\/document\.xml/);
  });
});

describe('extractFileText — разбор в отдельном процессе', () => {
  it('читает настоящий PDF', async () => {
    const r = await extractFileText('tests/fixtures/resume-sample.pdf', 'pdf');
    expect(r.ok).toBe(true);
    // Фикстура короткая — проверяем именно её текст, а не абстрактную длину.
    if (r.ok) expect(r.text).toContain('менеджер продукта');
  }, 30_000);

  it('читает docx', async () => {
    const path = join(dir, 'v.docx');
    writeFileSync(path, docx(['Аналитик данных', 'Опыт работы: от 2 лет, SQL, Python']));
    const r = await extractFileText(path, 'docx');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain('Аналитик данных');
  }, 30_000);

  it('читает txt', async () => {
    const path = join(dir, 'v.txt');
    writeFileSync(path, 'Системный аналитик, интеграции, REST');
    const r = await extractFileText(path, 'text');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain('Системный аналитик');
  }, 30_000);

  it('битый pdf — отказ с причиной, а не падение бота', async () => {
    const path = join(dir, 'broken.pdf');
    writeFileSync(path, '%PDF-1.7\nне pdf вовсе');
    const r = await extractFileText(path, 'pdf');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  }, 30_000);

  it('несуществующий файл — отказ, а не исключение', async () => {
    const r = await extractFileText(join(dir, 'нет-такого.txt'), 'text');
    expect(r.ok).toBe(false);
  });
});
