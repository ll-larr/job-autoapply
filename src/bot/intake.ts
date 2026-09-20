import { platformLink, postTitle, contentHash } from '../telegram/parse.js';
import { normalizeVacancy, type Vacancy } from '../core/vacancy.js';
import { parseExperienceFromText, screenVacancy, hasTitleWord, type ScreenResult } from '../core/screening.js';
import { scoreVacancy } from '../core/scorer.js';
import { enabledSpecialties, type Settings } from '../core/settings.js';
import type { Specialty } from '../core/specialty.js';
import { createProxiedFetch } from '../core/proxy.js';

/** Потолок текста вакансии: всё сверх обрезается ещё до промпта (спека 5.4). */
export const MAX_VACANCY_CHARS = 6000;
/** Потолок файла: больше не качаем вовсе (спека 5.5). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Минимум текста, чтобы считать прочитанное вакансией, а не сканом или заглушкой. */
export const MIN_VACANCY_CHARS = 200;
const LINK_TIMEOUT_MS = 15_000;

/**
 * Белый список хостов. Без него рекрутёр присылает
 * http://127.0.0.1:3000/api/queue, и бот вычитывает панель владельца сам себе
 * в ответ (спека 5.6). Список — разрешительный: всё, чего тут нет, не
 * открывается вовсе.
 */
const ALLOWED_HOSTS = new Set([
  'hh.ru', 'www.hh.ru', 'hh.kz', 'www.hh.kz', 'careerist.ru', 'www.careerist.ru',
  'hr.ge', 'www.hr.ge', 't.me', 'docs.google.com', 'notion.so', 'www.notion.so', 'telegra.ph',
]);

export function isFetchableLink(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (ALLOWED_HOSTS.has(host)) return true;
  // notion.site — поддомен на каждую публикацию, поэтому отдельной строкой.
  return host.endsWith('.notion.site');
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Google Docs отдаёт текст только через export; обычный /edit вернёт страницу редактора. */
function toFetchUrl(url: string): string {
  const doc = /^https:\/\/docs\.google\.com\/document\/d\/([\w-]+)/.exec(url);
  return doc === null ? url : `https://docs.google.com/document/d/${doc[1]!}/export?format=txt`;
}

export async function fetchLinkText(url: string, fetchImpl?: typeof fetch): Promise<string | null> {
  if (!isFetchableLink(url)) return null;
  const doFetch = fetchImpl ?? createProxiedFetch();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS);
  try {
    // redirect: 'manual' — редирект с разрешённого хоста на чужой не должен
    // становиться обходом белого списка.
    const res = await doFetch(toFetchUrl(url), { signal: controller.signal, redirect: 'manual' });
    if (!res.ok) return null;
    const body = await res.text();
    const looksHtml = /html/i.test(res.headers.get('content-type') ?? '') || /^\s*<(!doctype|html)/i.test(body);
    const text = looksHtml ? stripHtml(body) : body.trim();
    return text.length < MIN_VACANCY_CHARS ? null : text.slice(0, MAX_VACANCY_CHARS);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Тип файла по трём признакам сразу: расширение, MIME и сигнатура первых
 * байтов. Расхождение — отказ: так ловится «вакансия.pdf.exe» и просто
 * переименованный исполняемый файл (спека 5.5). Всё, что не pdf/docx/txt/md,
 * не скачивается вовсе.
 */
export function sniffFileKind(
  name: string | undefined, mime: string | undefined, head: Uint8Array,
): 'pdf' | 'docx' | 'text' | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name ?? '')?.[1]?.toLowerCase() ?? '';
  const startsWith = (sig: number[]): boolean => sig.every((b, i) => head[i] === b);
  const isPdf = startsWith([0x25, 0x50, 0x44, 0x46]); // %PDF
  const isZip = startsWith([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04

  if (ext === 'pdf' && isPdf && (mime === undefined || mime.includes('pdf'))) return 'pdf';
  if (ext === 'docx' && isZip && (mime === undefined || mime.includes('wordprocessingml'))) return 'docx';
  if ((ext === 'txt' || ext === 'md') && !isPdf && !isZip) return 'text';
  return null;
}

/** Расширения, по которым видно сразу: качать нечего. Проверяется до getFile. */
export function isObviouslyUnsupported(name: string | undefined): boolean {
  const ext = /\.([a-z0-9]+)$/i.exec(name ?? '')?.[1]?.toLowerCase() ?? '';
  return ext !== 'pdf' && ext !== 'docx' && ext !== 'txt' && ext !== 'md';
}

/**
 * Вакансия из сообщения рекрутёра. Ссылка на площадку разбирается тем же
 * platformLink, что и посты каналов: прислали ссылку на hh — строка становится
 * обычной hh-вакансией, по которой можно откликнуться из панели.
 */
export function buildVacancy(input: {
  text: string; chatId: number; messageId: number; username: string | null;
  titleWords: readonly string[]; now: Date;
}): Vacancy {
  const text = input.text.slice(0, MAX_VACANCY_CHARS);
  const urls = text.match(/https?:\/\/\S+/g) ?? [];
  const link = platformLink(urls, text);
  return normalizeVacancy({
    source: link?.source ?? 'tg-bot',
    sourceId: link?.sourceId ?? `${input.chatId}:${input.messageId}`,
    title: postTitle(text, input.titleWords),
    company: '',
    url: link?.url ?? '',
    description: text,
    geo: '',
    postedAt: input.now,
    experience: parseExperienceFromText(text),
    contact: input.username?.toLowerCase() ?? null,
    contentHash: contentHash(text),
    channel: null,
  });
}

/** Специальность — первая включённая, чьи заголовочные слова нашлись; иначе первая включённая. */
export function assessVacancy(vacancy: Vacancy, settings: Settings): {
  specialty: Specialty; screen: ScreenResult; score: number; matched: string[];
} {
  const specialties = enabledSpecialties(settings);
  const first = specialties[0];
  if (first === undefined) throw new Error('assessVacancy: в настройках нет включённых специальностей');
  const specialty = specialties.find((s) => hasTitleWord(vacancy.title, s.titleWords)) ?? first;
  const screen = screenVacancy(vacancy, {
    titleWords: specialty.titleWords,
    experienceYears: specialty.experienceYears,
    stopWords: settings.stopWords,
    // Заголовок из свободного текста рекрутёра ненадёжен: гейт заголовка
    // отсекал бы нормальные вакансии, присланные одним абзацем.
    skipTitleGate: true,
  });
  const { score, matched } = scoreVacancy(vacancy, specialty.skills);
  return { specialty, screen, score, matched };
}
