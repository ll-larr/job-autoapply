import { createHash } from 'node:crypto';
import { normalizeVacancy, type Vacancy } from '../core/vacancy.js';
import { parseExperienceFromText, hasTitleWord } from '../core/screening.js';
import { containsTerm } from '../core/matching.js';
import type { TgChat, TgMessage } from './types.js';

/**
 * Пост Telegram → вакансия, правилами, без LLM (спека 2026-09-18, 4.6;
 * выбор владельца — «подход A»). Снято на живых каналах 2026-09-19:
 * контакт стоит в строке «📩 Отклик: @…», «Контакты: @…», «tg:@…», а
 * каналы-агрегаторы вставляют в пост рекламу себя («Больше вакансий: @…»),
 * которую за контакт принимать нельзя.
 */

export const MIN_POST_LENGTH = 200;

/**
 * Признаки вакансии. Расширяется одной строкой.
 *
 * Одного маркера мало, нужны два разных: пост «Ищем героев для подкаста»
 * (снят 2026-09-19) говорит «парсер вакансий» и «Hello New Job», а вакансией
 * не является. Настоящие вакансии на снятых каналах дают два маркера и больше
 * («Требования» + «ЗП», «Зарплатная вилка» + «Чем предстоит заниматься»).
 */
export const VACANCY_MARKERS: readonly string[] = [
  'ваканси*', 'требовани*', 'обязанност*', 'зп', 'зарплат*', 'оклад', 'vacancy',
  'что предстоит', 'чем предстоит', 'что делать', 'мы ожидаем', 'условия', 'формат работы',
];
const MIN_MARKERS = 2;

/** Признаки поста-резюме или дайджеста резюме: это не вакансия, писать некому. */
export const RESUME_MARKERS: readonly string[] = ['резюме недели', 'ищу работу', 'ищу вакансию'];

export function isVacancyPost(text: string): boolean {
  if (text.length < MIN_POST_LENGTH) return false;
  if (/#резюме|#resume|#ищу/i.test(text)) return false;
  if (RESUME_MARKERS.some((m) => containsTerm(text, m))) return false;
  // Хэштег вакансии канал ставит сам — ему достаточно.
  if (/#(вакансия|vacancy|job)(?![\p{L}\p{N}_])/iu.test(text)) return true;
  return VACANCY_MARKERS.filter((m) => containsTerm(text, m)).length >= MIN_MARKERS;
}

const USERNAME = /(?<![\w@.])@([A-Za-z][A-Za-z0-9_]{3,31})\b/g;
/** Строка, где стоит контакт. */
const CONTACT_LINE = /отклик|контакт|писать|пишите|напиши|связь|связаться|tg\s*:|telegram|телеграм|резюме|cv|hr\b|📩|✉️|👉/i;
/** Строка с рекламой канала — её @ контактом не бывает. */
const PROMO_LINE = /больше ваканси|подпис|наш канал|канал[е]? с|чат[е]? с|рекомендац|реклам/i;

export function pickContact(text: string, ownUsername: string | null): string | null {
  const own = ownUsername?.toLowerCase() ?? null;
  const candidates: Array<{ name: string; strong: boolean }> = [];
  for (const line of text.split('\n')) {
    if (PROMO_LINE.test(line)) continue;
    for (const m of line.matchAll(USERNAME)) {
      const name = m[1]!;
      if (own !== null && name.toLowerCase() === own) continue;
      candidates.push({ name, strong: CONTACT_LINE.test(line) });
    }
  }
  return (candidates.find((c) => c.strong) ?? candidates[0])?.name ?? null;
}

const HH_RE = /(?:^|[^\w.])(?:[a-z-]+\.)?hh\.ru\/vacancy\/(\d+)/i;
const CAREERIST_RE = /careerist\.ru\/vakansii\/[\w-]*?-(\d+)\.html/i;

export function platformLink(urls: string[], text: string)
  : { source: 'hh' | 'careerist'; sourceId: string; url: string } | null {
  for (const s of [...urls, text]) {
    const hh = HH_RE.exec(s);
    if (hh) return { source: 'hh', sourceId: hh[1]!, url: `https://hh.ru/vacancy/${hh[1]!}` };
    const c = CAREERIST_RE.exec(s);
    if (c) {
      const url = /https?:\/\/[^\s]+/.exec(s)?.[0] ?? `https://${c[0]}`;
      return { source: 'careerist', sourceId: c[1]!, url };
    }
  }
  return null;
}

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const HASHTAG = /#[\p{L}\p{N}_]+/gu;
const TITLE_MAX = 120;

function cleanLine(line: string): string {
  return line.replace(EMOJI, '').replace(HASHTAG, '').replace(/\s+/g, ' ').replace(/^[\s\-–—:|•*]+|[\s\-–—:|•*]+$/g, '');
}

export function postTitle(text: string, titleWords: readonly string[]): string {
  const lines = text.split('\n');
  const cleaned = lines.map(cleanLine);
  let title = cleaned.find((c, i) => c !== '' && hasTitleWord(c, titleWords) && hasTitleWord(lines[i]!, titleWords));
  title ??= cleaned.find((c) => c !== '') ?? '';
  return title.slice(0, TITLE_MAX);
}

export function contentHash(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(HASHTAG, '')
    .replace(EMOJI, '')
    .replace(/[^\p{L}\p{N}@]+/gu, '');
  return createHash('sha1').update(normalized).digest('hex');
}

export function postUrl(chat: TgChat, messageId: number): string {
  if (chat.username !== null) return `https://t.me/${chat.username}/${messageId}`;
  return `https://t.me/c/${chat.id.replace(/^-100/, '').replace(/^-/, '')}/${messageId}`;
}

export type PostVerdict =
  | { ok: true; vacancy: Vacancy }
  | { ok: false; reason: 'not_vacancy' | 'no_contact' };

/**
 * Черновик вакансии из поста. Специальность здесь не выбирается: слова
 * заголовка всех включённых специальностей нужны только чтобы найти строку
 * заголовка. Какая специальность оценит пост — решает конвейер (pipeline.ts).
 */
export function postToVacancy(chat: TgChat, m: TgMessage, allTitleWords: readonly string[]): PostVerdict {
  if (!isVacancyPost(m.text)) return { ok: false, reason: 'not_vacancy' };
  const link = platformLink(m.urls, m.text);
  const contact = pickContact(m.text, chat.username);
  if (contact === null && link === null) return { ok: false, reason: 'no_contact' };

  const vacancy = normalizeVacancy({
    source: link?.source ?? 'tg',
    sourceId: link?.sourceId ?? `${chat.id}:${m.id}`,
    title: postTitle(m.text, allTitleWords),
    company: '',
    url: link?.url ?? postUrl(chat, m.id),
    description: m.text,
    geo: '',
    postedAt: m.date,
    experience: parseExperienceFromText(m.text),
    contact: link === null ? contact : null,
    contentHash: contentHash(m.text),
    channel: chat.title,
  });
  return { ok: true, vacancy };
}
