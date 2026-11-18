import { createHash } from 'node:crypto';
import { CHAT_MESSAGE_CANDIDATES, CHAT_MESSAGE_ID_ATTRS, SYSTEM_MESSAGE_RE } from './inbox-selectors.js';

/**
 * Сообщения чата отклика hh.ru (спека 2026-10-09, 6.10, шаги R2–R3). Фрейм и
 * локаторы Playwright сюда приходят через узкие интерфейсы — тесты подставляют
 * свои. Селекторы не проверены вживую (см. inbox-selectors.ts), поэтому разбор
 * устроен так, чтобы разметка, которую он не понял, давала «ноль сообщений», а
 * не выдуманные ответы.
 */

export interface ItemLike {
  innerText(opts?: { timeout?: number }): Promise<string>;
  getAttribute(name: string, opts?: { timeout?: number }): Promise<string | null>;
}
export interface LocatorLike {
  count(): Promise<number>;
  nth(index: number): ItemLike;
}
export interface FrameLike {
  locator(selector: string): LocatorLike;
}

export type MessageDirection = 'incoming' | 'ours' | 'system';

export interface ChatMessageRead {
  key: string;
  text: string;
  direction: MessageDirection;
}

/** Что мы сами писали в этот чат: письмо отклика и ответы, отправленные этим процессом. */
export interface OwnTexts {
  letter: string | null;
  replies: readonly string[];
}

const HEAD = 80;
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** «Наше» — текст начинается с начала нашего письма или нашего ответа; служебное — по шаблону; остальное — входящее. */
export function classifyMessage(text: string, own: OwnTexts): MessageDirection {
  const t = norm(text);
  const heads = [own.letter, ...own.replies]
    .filter((x): x is string => x !== null && x.trim() !== '')
    .map((x) => norm(x).slice(0, HEAD));
  if (heads.some((h) => t.startsWith(h))) return 'ours';
  if (SYSTEM_MESSAGE_RE.test(text)) return 'system';
  return 'incoming';
}

/** Ключ сообщения: id из разметки, а без него — sha1 от номера чата и нормализованного текста (хэш, не текст). */
export function messageKey(topicId: number, text: string, idAttr: string | null): string {
  if (idAttr !== null && idAttr.trim() !== '') return `id:${idAttr.trim()}`;
  return `h:${createHash('sha1').update(`${topicId}|${norm(text)}`).digest('hex')}`;
}

/**
 * Последние `limit` сообщений фрейма. Первый селектор-кандидат с совпадениями
 * выигрывает; `selector` называет его (проба кладёт это в отчёт). Пустые
 * сообщения (иконки, разделители дат) пропускаются.
 */
export async function readChatMessages(
  frame: FrameLike, topicId: number, own: OwnTexts, limit = 10,
): Promise<{ selector: string | null; messages: ChatMessageRead[] }> {
  for (const selector of CHAT_MESSAGE_CANDIDATES) {
    const loc = frame.locator(selector);
    const total = await loc.count().catch(() => 0);
    if (total === 0) continue;
    const messages: ChatMessageRead[] = [];
    for (let i = Math.max(0, total - limit); i < total; i += 1) {
      const item = loc.nth(i);
      const text = (await item.innerText({ timeout: 3000 }).catch(() => '')).trim();
      if (text === '') continue;
      let idAttr: string | null = null;
      for (const attr of CHAT_MESSAGE_ID_ATTRS) {
        idAttr = await item.getAttribute(attr, { timeout: 1000 }).catch(() => null);
        if (idAttr !== null && idAttr.trim() !== '') break;
      }
      messages.push({ key: messageKey(topicId, text, idAttr), text, direction: classifyMessage(text, own) });
    }
    return { selector, messages };
  }
  return { selector: null, messages: [] };
}
