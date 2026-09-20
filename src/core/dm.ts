import type { Vacancy } from './vacancy.js';
import { complete, type ChatMessage, type CompletionOptions } from './openrouter.js';
import { COMMON_WRITING_RULES, findForbiddenClaim } from './letter.js';

/**
 * Первое личное сообщение рекрутёру в Telegram (спека 2026-09-18, 5.1). Не
 * сопроводительное письмо: у рекрутёра десятки вакансий, поэтому сначала —
 * какая именно и ссылка на пост, дальше коротко, почему подходишь. Часть
 * правил письма здесь неверна («не начинай с вакансии», «не заканчивай
 * „резюме прикреплено“») и не передаётся; запреты на выдумки и обороты —
 * общие.
 */

export const DM_MAX_LENGTH = 1200;

const INSTRUCTION = (role: string): string => `Ты помогаешь кандидату написать первое личное сообщение
рекрутёру в Telegram по вакансии (специальность «${role}»).
Сообщение короткое:
- первой фразой назови вакансию и дай ссылку на пост — у рекрутёра их много;
- потом 2–3 предложения о том, почему он подходит: конкретный проект, инструмент или цифра из резюме,
  привязанные к тому, что просит вакансия;
- в конце — что резюме во вложении, и короткий вопрос или просьба.
Обращение «Здравствуйте!» без имени. Подпись «Артём». Не длиннее ${DM_MAX_LENGTH} символов.
Опирайся только на факты из резюме — ничего не выдумывай. Верни только текст сообщения.

${COMMON_WRITING_RULES}`;

export function buildDmMessages(input: { vacancy: Vacancy; resume: string; role: string }): ChatMessage[] {
  const v = input.vacancy;
  return [
    { role: 'system', content: `${INSTRUCTION(input.role)}\n\n=== РЕЗЮМЕ ===\n${input.resume}` },
    {
      role: 'user',
      content: [
        `Вакансия: ${v.title}`,
        `Ссылка на пост: ${v.url}`,
        v.channel === null ? '' : `Чат: ${v.channel}`,
        '',
        '=== ТЕКСТ ПОСТА ===',
        v.description,
      ].filter((s) => s !== '').join('\n'),
    },
  ];
}

export function isUsableDm(text: string, vacancy: Vacancy): string | null {
  const t = text.trim();
  if (t === '') return 'пустой ответ';
  if (t.length > DM_MAX_LENGTH) return `длиннее ${DM_MAX_LENGTH} символов`;
  if (!t.includes(vacancy.url)) return 'нет ссылки на пост';
  const claim = findForbiddenClaim(t);
  if (claim !== null) return `выдуман навык: ${claim}`;
  return null;
}

export async function generateDm(
  input: { vacancy: Vacancy; resume: string; role: string },
  options: CompletionOptions,
): Promise<{ letter: string; mode: 'dm' | 'none'; failure?: string }> {
  const r = await complete(buildDmMessages(input), options, (text) => isUsableDm(text, input.vacancy));
  return r.ok ? { letter: r.text.trim(), mode: 'dm' } : { letter: '', mode: 'none', failure: r.failure };
}
