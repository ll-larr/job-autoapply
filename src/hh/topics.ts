/**
 * Список откликов со страницы /applicant/negotiations (спека 2026-10-09, 6.10).
 * Страница кладёт его JSON-ом в разметку: `"topicList":[{…},…]`. Подтверждено
 * настоящей фикстурой tests/fixtures/hh-negotiations.html (20 откликов).
 * Тексты сообщений работодателя здесь недоступны — только факты: состояние,
 * число сообщений, есть ли новые. Этого хватает для воронки и для «ответил».
 */

export interface HhTopic {
  /** Номер отклика (топика) — он же номер чата chatik.hh.ru/chat/<id>. */
  topicId: number;
  chatId: number | null;
  /** Номер вакансии строкой: так он хранится в очереди (source_id). */
  vacancyId: string;
  /** RESPONSE | INTERVIEW | DISCARD | … — как отдаёт hh. */
  lastState: string;
  /** AVAILABLE | DISABLED_BY_EMPLOYER | WITHOUT_INVITATION | … Может отсутствовать. */
  inboxState: string | null;
  messagesCount: number;
  hasNew: boolean;
  lastModified: number | null;
}

/**
 * Массив после маркера, вырезанный сканером с учётом строк и экранирования:
 * скобка внутри строки («…]…») не закрывает массив. null — маркера нет или
 * скобки не сошлись.
 */
export function extractJsonArray(html: string, marker: string): string | null {
  const at = html.indexOf(marker);
  if (at === -1) return null;
  const start = at + marker.length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '[') depth += 1;
    else if (c === ']') {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/**
 * null — разметка изменилась (нет списка или JSON битый): вызывающий не трогает
 * базу и называет причину. Пустой массив — откликов нет, это не ошибка.
 */
export function parseTopicList(html: string): HhTopic[] | null {
  const json = extractJsonArray(html, '"topicList":[');
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const out: HhTopic[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    const topicId = num(item['id']);
    const vacancyId = item['vacancyId'];
    if (topicId === null || (typeof vacancyId !== 'number' && typeof vacancyId !== 'string')) continue;
    out.push({
      topicId,
      chatId: num(item['chatId']),
      vacancyId: String(vacancyId),
      lastState: typeof item['lastState'] === 'string' ? item['lastState'] : 'UNKNOWN',
      inboxState: typeof item['inboxAvailabilityState'] === 'string' ? item['inboxAvailabilityState'] : null,
      messagesCount: num(item['conversationMessagesCount']) ?? 0,
      hasNew: item['hasNewMessages'] === true,
      lastModified: num(item['lastModifiedMillis']),
    });
  }
  return out;
}
