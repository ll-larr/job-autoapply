import { describe, it, expect } from 'vitest';
import {
  isFetchableLink, fetchLinkText, sniffFileKind, isObviouslyUnsupported,
  buildVacancy, assessVacancy, MAX_VACANCY_CHARS,
} from '../src/bot/intake.js';
import { seedSettings } from '../src/core/settings.js';

describe('белый список ссылок', () => {
  it('площадки и онлайн-документы разрешены', () => {
    expect(isFetchableLink('https://hh.ru/vacancy/123')).toBe(true);
    expect(isFetchableLink('https://docs.google.com/document/d/abc/edit')).toBe(true);
    expect(isFetchableLink('https://telegra.ph/x')).toBe(true);
    expect(isFetchableLink('https://my-page.notion.site/vacancy')).toBe(true);
  });

  it('локальные адреса и чужие хосты — нет', () => {
    expect(isFetchableLink('http://127.0.0.1:3000/api/queue')).toBe(false);
    expect(isFetchableLink('http://localhost:3000/')).toBe(false);
    expect(isFetchableLink('https://192.168.0.5/')).toBe(false);
    expect(isFetchableLink('https://evil.example.com/x')).toBe(false);
    expect(isFetchableLink('file:///C:/Users/lar/.env')).toBe(false);
    expect(isFetchableLink('не ссылка вовсе')).toBe(false);
  });

  it('похожий хост не проходит: hh.ru.evil.com — чужой', () => {
    expect(isFetchableLink('https://hh.ru.evil.com/x')).toBe(false);
  });

  it('google docs тянется через export?format=txt', async () => {
    let asked = '';
    const text = await fetchLinkText('https://docs.google.com/document/d/ABC/edit', async (u) => {
      asked = String(u);
      return new Response(`Вакансия: аналитик. ${'подробности '.repeat(30)}`);
    });
    expect(asked).toBe('https://docs.google.com/document/d/ABC/export?format=txt');
    expect(text).toContain('Вакансия: аналитик');
  });

  it('html чистится от разметки, скрипты выбрасываются', async () => {
    const text = await fetchLinkText('https://hh.ru/vacancy/1', async () =>
      new Response(
        `<html><script>bad()</script><body><h1>Аналитик</h1><p>SQL и BPMN. ${'опыт '.repeat(60)}</p></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      ));
    expect(text).toContain('Аналитик');
    expect(text).toContain('SQL');
    expect(text).not.toContain('bad()');
  });

  it('короткий ответ (заглушка, страница логина) — как будто ничего не прочитали', async () => {
    const text = await fetchLinkText('https://hh.ru/vacancy/1', async () => new Response('войдите'));
    expect(text).toBeNull();
  });

  it('не разрешённый хост не запрашивается вовсе', async () => {
    let called = false;
    const text = await fetchLinkText('https://evil.example.com/x', async () => {
      called = true;
      return new Response('что угодно');
    });
    expect(called).toBe(false);
    expect(text).toBeNull();
  });
});

describe('распознавание файла', () => {
  const pdfHead = new TextEncoder().encode('%PDF-1.7 ...');
  const zipHead = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  const exeHead = new Uint8Array([0x4d, 0x5a, 0x90, 0]);

  it('pdf по сигнатуре', () => {
    expect(sniffFileKind('v.pdf', 'application/pdf', pdfHead)).toBe('pdf');
  });

  it('docx по сигнатуре zip и расширению', () => {
    expect(sniffFileKind(
      'v.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      zipHead,
    )).toBe('docx');
  });

  it('exe, переименованный в pdf, отклоняется', () => {
    expect(sniffFileKind('вакансия.pdf.exe', 'application/pdf', exeHead)).toBeNull();
    expect(sniffFileKind('вакансия.pdf', 'application/pdf', exeHead)).toBeNull();
  });

  it('doc, docm, архивы — нет', () => {
    expect(sniffFileKind('v.doc', 'application/msword', new Uint8Array([0xd0, 0xcf]))).toBeNull();
    expect(sniffFileKind('v.docm', 'application/vnd.ms-word.document.macroEnabled.12', zipHead)).toBeNull();
    expect(sniffFileKind('v.zip', 'application/zip', zipHead)).toBeNull();
  });

  it('txt и md — текст', () => {
    const head = new TextEncoder().encode('Вакансия');
    expect(sniffFileKind('v.txt', 'text/plain', head)).toBe('text');
    expect(sniffFileKind('v.md', 'text/markdown', head)).toBe('text');
  });

  it('по расширению видно до скачивания, что файл не наш', () => {
    expect(isObviouslyUnsupported('x.exe')).toBe(true);
    expect(isObviouslyUnsupported('x.zip')).toBe(true);
    expect(isObviouslyUnsupported(undefined)).toBe(true);
    expect(isObviouslyUnsupported('вакансия.pdf')).toBe(false);
  });
});

describe('сборка и оценка вакансии', () => {
  const settings = seedSettings(undefined, null);
  const now = new Date(2026, 8, 20);

  it('ссылка на hh делает строку обычной hh-вакансией', () => {
    const v = buildVacancy({
      text: 'Бизнес-аналитик\nhttps://hh.ru/vacancy/98765\nТребования: BPMN, SQL',
      chatId: 5, messageId: 9, username: 'rec', titleWords: ['аналитик'], now,
    });
    expect(v.source).toBe('hh');
    expect(v.sourceId).toBe('98765');
  });

  it('без ссылки на площадку — источник tg-bot и контакт рекрутёра', () => {
    const v = buildVacancy({
      text: 'Бизнес-аналитик\nТребования: BPMN, SQL, интеграции',
      chatId: 5, messageId: 9, username: 'Rec', titleWords: ['аналитик'], now,
    });
    expect(v.source).toBe('tg-bot');
    expect(v.sourceId).toBe('5:9');
    expect(v.contact).toBe('rec');
    expect(v.contentHash).not.toBeNull();
  });

  it('текст обрезается по потолку', () => {
    const v = buildVacancy({
      text: `Аналитик\n${'очень длинно '.repeat(2000)}`,
      chatId: 1, messageId: 1, username: null, titleWords: ['аналитик'], now,
    });
    expect(v.description.length).toBeLessThanOrEqual(MAX_VACANCY_CHARS);
  });

  it('assessVacancy даёт специальность по заголовку и скор', () => {
    const v = buildVacancy({
      text: 'Бизнес-аналитик\nBPMN, требования, интеграции, SQL',
      chatId: 1, messageId: 1, username: null, titleWords: ['аналитик'], now,
    });
    const r = assessVacancy(v, settings);
    expect(r.specialty.id).toBeTruthy();
    expect(r.score).toBeGreaterThan(0);
    expect(r.screen.passed).toBe(true);
  });

  it('стоп-слово отсеивает вакансию', () => {
    const v = buildVacancy({
      text: 'Бизнес-аналитик 1С\nРабота с 1С, доработка 1С, SQL',
      chatId: 1, messageId: 2, username: null, titleWords: ['аналитик'], now,
    });
    expect(assessVacancy(v, settings).screen.passed).toBe(false);
  });

  it('требуемый опыт выше заданного отсеивает вакансию', () => {
    const v = buildVacancy({
      text: 'Бизнес-аналитик\nОпыт работы: от 6 лет. BPMN, SQL',
      chatId: 1, messageId: 3, username: null, titleWords: ['аналитик'], now,
    });
    const r = assessVacancy(v, settings);
    expect(r.screen.passed).toBe(false);
    if (!r.screen.passed) expect(r.screen.reason).toBe('experience');
  });
});
