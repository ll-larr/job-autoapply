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

  // Решение владельца 2026-10-08: резюме берётся только из того, что прикреплено
  // в настройках. Прежний запасной resume.md (у засеянных специальностей он был
  // главным, у остальных — запасным) убран: письмо уходит по резюме, о котором
  // владелец не знает, что оно в игре.
  it('засеянная специальность (legacyLetters) читает текст своего PDF, а не resume.md', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaa-cv-'));
    const ba = { ...DEFAULT_SPECIALTY, resumePdf: PDF };
    await refreshResumeCache(ba, dir);
    expect(resumeTextFor(ba, { cacheDir: dir })).toContain('Роадмап');
  });

  it('PDF не прикреплён — отказ с названием специальности, а не молчаливое резюме БА', () => {
    expect(() => resumeTextFor(pm(null))).toThrow(/Менеджер продукта.*не прикреплено/);
  });

  it('PDF прикреплён, но текст не извлечён — отказ с путём к файлу', () => {
    const empty = mkdtempSync(join(tmpdir(), 'jaa-cv-'));
    expect(() => resumeTextFor(pm(PDF), { cacheDir: empty })).toThrow(PDF);
  });

  it('у каждой специальности своё резюме: вакансия получает то, что прикреплено к её специальности', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaa-cv-'));
    writeFileSync(join(dir, 'pm.txt'), 'РЕЗЮМЕ МЕНЕДЖЕРА ПРОДУКТА', 'utf8');
    writeFileSync(join(dir, 'business-analyst.txt'), 'РЕЗЮМЕ БИЗНЕС-АНАЛИТИКА', 'utf8');
    const ba = { ...DEFAULT_SPECIALTY, resumePdf: 'ba.pdf' };
    expect(resumeTextFor(pm('pm.pdf'), { cacheDir: dir })).toBe('РЕЗЮМЕ МЕНЕДЖЕРА ПРОДУКТА');
    expect(resumeTextFor(ba, { cacheDir: dir })).toBe('РЕЗЮМЕ БИЗНЕС-АНАЛИТИКА');
  });
});
