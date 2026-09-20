import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractPdfText, refreshResumeCache, resumeTextFor } from '../src/core/resume.js';
import { DEFAULT_SPECIALTY } from '../src/core/specialty-defaults.js';
import type { Specialty } from '../src/core/specialty.js';

const PDF = 'tests/fixtures/resume-sample.pdf';

function pm(resumePdf: string | null): Specialty {
  return { ...DEFAULT_SPECIALTY, id: 'pm', name: 'Менеджер продукта', legacyLetters: false, resumePdf };
}

describe('extractPdfText', () => {
  it('достаёт кириллицу из PDF', async () => {
    const text = await extractPdfText(PDF);
    expect(text).toContain('менеджер продукта');
    expect(text).toContain('Роадмап');
  });

  it('несуществующий файл — ошибка с путём', async () => {
    await expect(extractPdfText('нет/такого.pdf')).rejects.toThrow('нет/такого.pdf');
  });
});

describe('refreshResumeCache + resumeTextFor', () => {
  it('кеш создаётся, и письма берут текст из него', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaa-cv-'));
    const r = await refreshResumeCache(pm(PDF), dir);
    expect(r.ok && r.chars).toBeGreaterThan(20);
    expect(resumeTextFor(pm(PDF), { cacheDir: dir })).toContain('Роадмап');
  });

  it('кеш свежее PDF — повторно не извлекает', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaa-cv-'));
    await refreshResumeCache(pm(PDF), dir);
    const cache = join(dir, 'pm.txt');
    writeFileSync(cache, 'ПОМЕТКА', 'utf8');
    const future = new Date(Date.now() + 60_000);
    utimesSync(cache, future, future);
    await refreshResumeCache(pm(PDF), dir);
    expect(readFileSync(cache, 'utf8')).toBe('ПОМЕТКА');
  });

  it('битый путь — отказ с причиной, кеш не создаётся', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaa-cv-'));
    const r = await refreshResumeCache(pm('нет.pdf'), dir);
    expect(r.ok).toBe(false);
    expect(existsSync(join(dir, 'pm.txt'))).toBe(false);
  });

  it('legacyLetters — всегда .md БА, даже если PDF задан', () => {
    const md = join(mkdtempSync(join(tmpdir(), 'jaa-md-')), 'cv.md');
    writeFileSync(md, 'РЕЗЮМЕ БА', 'utf8');
    expect(resumeTextFor({ ...DEFAULT_SPECIALTY, resumePdf: PDF }, { legacyMdPath: md })).toBe('РЕЗЮМЕ БА');
  });

  it('PDF не задан или кеша нет — .md БА', () => {
    const md = join(mkdtempSync(join(tmpdir(), 'jaa-md-')), 'cv.md');
    writeFileSync(md, 'РЕЗЮМЕ БА', 'utf8');
    const empty = mkdtempSync(join(tmpdir(), 'jaa-cv-'));
    expect(resumeTextFor(pm(null), { legacyMdPath: md, cacheDir: empty })).toBe('РЕЗЮМЕ БА');
    expect(resumeTextFor(pm(PDF), { legacyMdPath: md, cacheDir: empty })).toBe('РЕЗЮМЕ БА');
  });
});
