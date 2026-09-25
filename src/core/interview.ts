import { extractNumbers } from './facts.js';
import { findForbiddenClaim } from './letter.js';
import { findLeak } from '../bot/reply.js';

/**
 * Ответ ГигаРекрутёру (спека 2026-09-25). Здесь нет ни Telegram, ни знания о
 * том, кому уходит текст: только сборка промпта, валидатор и генерация.
 *
 * Политика отказа сюда не входит намеренно. У ГигаРекрутёра она «молчим и
 * повторяем», у будущего автоответчика в личке — «шлём отписку»; решает
 * вызывающая сторона (спека, 1.1).
 */

export const MAX_ANSWER_LENGTH = 1500;

/** Всё, что модели разрешено называть цифрами: резюме, факты, текст вопроса. */
export function allowedNumbers(parts: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of parts) for (const n of extractNumbers(p)) out.add(n);
  return out;
}

const ROBOT_MARKERS = /как языковая модель|как ии\b|я бот\b|не могу ответить|уточните вопрос/i;

/** null — ответ годен. Строка — причина отбраковки, она же уходит в журнал. */
export function validateAnswer(
  answer: string,
  input: { allowed: Set<string>; maxLength?: number },
): string | null {
  const t = answer.trim();
  const max = input.maxLength ?? MAX_ANSWER_LENGTH;
  if (t === '') return 'пустой ответ';
  if (t.length > max) return `длиннее ${max} символов`;
  if (ROBOT_MARKERS.test(t)) return 'маркер автомата';
  const leak = findLeak(t);
  if (leak !== null) return `в ответе ${leak}`;
  const claim = findForbiddenClaim(t);
  if (claim !== null) return `выдуман навык: ${claim}`;
  for (const n of extractNumbers(t)) {
    if (!input.allowed.has(n)) return `выдуманное число: ${n}`;
  }
  return null;
}
