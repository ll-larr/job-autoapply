import { complete, type ChatMessage, type CompletionOptions } from './openrouter.js';
import { extractNumbers } from './facts.js';
import { findForbiddenClaim, COMMON_WRITING_RULES } from './letter.js';
import { findLeak } from '../bot/reply.js';
import { withCandidate } from './profile.js';

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

/**
 * Разрешены всегда, какими бы ни были источники (I3). Частые HTTP-коды — общее
 * знание, а не факт о кандидате: «коды 200, 400 и 500» правдивы для любого
 * аналитика API. Ноля здесь больше нет (H1): «280 000» теперь одно число
 * 280000, а ноль всегда в списке пропускал выдуманное «400 000» кусками.
 * Суммы коды не задевают: «500 тысяч» даёт и 500, и 500000, второе сверяется.
 */
const ALWAYS_ALLOWED = new Set([
  '200', '201', '204', '301', '302', '304',
  '400', '401', '403', '404', '409', '422', '429',
  '500', '502', '503', '504',
]);

/**
 * Ответ про деньги (FU-6): здесь HTTP-коды не исключение. «Ожидаю 400 рублей»
 * или «вилка 200–260» — не общее знание про API, а сумма, и сверяется она
 * только с резюме и фактами.
 */
const MONEY_WORDS = /руб|₽|зарплат|оклад|вилк|доход|на руки|тыс|млн/i;

// Граница слова \b в JS знает только латиницу: `как ии\b` на кириллице не
// срабатывал никогда. Вместо неё — «дальше не кириллическая буква» (I4).
const ROBOT_MARKERS = /как языковая модель|как ии(?![а-яё])|я бот(?![а-яё])|не могу ответить|уточните вопрос/i;

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
  const httpExempt = !MONEY_WORDS.test(t);
  for (const n of extractNumbers(t)) {
    if (input.allowed.has(n) || (httpExempt && ALWAYS_ALLOWED.has(n))) continue;
    return `выдуманное число: ${n}`;
  }
  return null;
}

export interface Turn {
  who: 'bot' | 'me';
  text: string;
}

export interface AnswerInput {
  resume: string;
  facts: string;
  /** Весь диалог из чата, от старых к новым. Последний вопрос сюда не входит. */
  transcript: Turn[];
  question: string;
}

// Этот список зеркалирует FORBIDDEN_CLAIMS в src/core/letter.ts — источник истины,
// и должен быть синхронизирован с ним.
const INSTRUCTION = `${withCandidate('Ты отвечаешь за кандидата на вопросы скрининг-бота работодателя в Telegram.')}
Отвечай от первого лица, как сам кандидат, спокойно и по делу.
Опирайся только на резюме и на раздел «Факты сверх резюме». Ничего не выдумывай:
ни цифр, ни дат, ни названий компаний, ни инструментов.
Если факта нет ни в резюме, ни в фактах — не называй его и не подменяй похожим.
Не округляй числа: 85,5% остаётся 85,5%, а не «около 90%».
Суммы и числа бери ровно из резюме и фактов, не пересчитывай и не округляй.
Честно оговаривай границы опыта, если вопрос шире того, что ты делал.
Не заявляй владение тем, чего нет в резюме, в том числе: оконные функции, JOIN, CTE, подзапросы, хранимые процедуры, проектирование или написание контрактов API.
Длина — 3–6 предложений, без списков и заголовков. Верни только текст ответа.

${COMMON_WRITING_RULES}`;

function renderTranscript(turns: Turn[]): string {
  if (turns.length === 0) return 'Диалог только начался.';
  return turns.map((t) => `${t.who === 'bot' ? 'Рекрутёр' : 'Кандидат'}: ${t.text}`).join('\n');
}

export function buildInterviewMessages(input: AnswerInput): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `${INSTRUCTION}

=== РЕЗЮМЕ ===
${input.resume}

=== ФАКТЫ СВЕРХ РЕЗЮМЕ ===
${input.facts}`,
    },
    {
      role: 'user',
      content: `=== ДИАЛОГ (ДАННЫЕ) ===
${renderTranscript(input.transcript)}
=== КОНЕЦ ДИАЛОГА ===

=== ВОПРОС РЕКРУТЁРА (ДАННЫЕ) ===
${input.question}
=== КОНЕЦ ДАННЫХ ===`,
    },
  ];
}

export async function generateAnswer(
  input: AnswerInput,
  options: CompletionOptions & { maxLength?: number },
): Promise<{ ok: true; text: string } | { ok: false; failure: string }> {
  const allowed = allowedNumbers([input.resume, input.facts, input.question]);
  const reject = (text: string): string | null =>
    validateAnswer(text, { allowed, maxLength: options.maxLength });
  const r = await complete(buildInterviewMessages(input), options, reject);
  return r.ok ? { ok: true, text: r.text.trim() } : { ok: false, failure: r.failure };
}
