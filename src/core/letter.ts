import type Anthropic from '@anthropic-ai/sdk';
import type { Vacancy } from './vacancy.js';
import type { LetterMode } from './queue.js';

export type TemplateName =
  | 'fullstack-analyst' | 'ai-llm-ba' | 'product-ba' | 'english-generic';

export interface LetterInput {
  vacancy: Vacancy;
  matched: string[];
  mode: LetterMode;
  resume: string;
  template: string;
}

export interface PromptParts {
  system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  messages: Array<{ role: 'user'; content: string }>;
}

export function pickMode(score: number, threshold: number): LetterMode {
  return score >= threshold ? 'full' : 'hybrid';
}

export function pickTemplate(v: Vacancy, matched: string[]): TemplateName {
  if (v.source === 'hrge') return 'english-generic';
  if (matched.includes('ai-llm')) return 'ai-llm-ba';
  if (matched.includes('product')) return 'product-ba';
  return 'fullstack-analyst';
}

const INSTRUCTION_HYBRID = `Ты помогаешь кандидату откликаться на вакансии бизнес-аналитика.
Тебе дан скелет письма с плейсхолдерами {{HOOK}} и {{FIT}}.
Замени {{TITLE}} и {{COMPANY}} на данные вакансии.
Вместо {{HOOK}} напиши одно-два предложения о том, что конкретно в этой компании
или продукте делает вакансию интересной. Опирайся только на текст вакансии.
Вместо {{FIT}} напиши одно-два предложения, связывающих опыт из резюме
с конкретными требованиями вакансии.
Не выдумывай фактов, которых нет в резюме. Верни только готовое письмо, без пояснений.`;

const INSTRUCTION_FULL = `Ты помогаешь кандидату откликаться на вакансии бизнес-аналитика.
Напиши сопроводительное письмо с нуля под конкретную вакансию.
Держи объём в 4–6 абзацев, деловой тон без канцелярита и без превосходных степеней.
Опирайся только на факты из резюме — ничего не выдумывай.
Начни с обращения, закончи подписью «кандидат».
Верни только письмо, без пояснений.`;

/**
 * Порядок блоков определяет попадание в кэш. Стабильное (инструкция + резюме)
 * идёт первым и помечается cache_control. Волатильное (текст вакансии)
 * идёт в messages, после последнего брейкпоинта.
 */
export function buildPrompt(input: LetterInput): PromptParts {
  const instruction = input.mode === 'full' ? INSTRUCTION_FULL : INSTRUCTION_HYBRID;
  const stable = input.mode === 'full'
    ? `${instruction}\n\n=== РЕЗЮМЕ ===\n${input.resume}`
    : `${instruction}\n\n=== РЕЗЮМЕ ===\n${input.resume}\n\n=== СКЕЛЕТ ===\n${input.template}`;

  const v = input.vacancy;
  const volatile = [
    `Вакансия: ${v.title}`,
    `Компания: ${v.company}`,
    `Локация: ${v.geo}`,
    input.matched.length > 0 ? `Совпавшие ключевые темы: ${input.matched.join(', ')}` : '',
    '',
    '=== ТЕКСТ ВАКАНСИИ ===',
    v.description,
  ].filter((s) => s !== '').join('\n');

  return {
    system: [{ type: 'text', text: stable, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: volatile }],
  };
}

export async function generateLetter(
  input: LetterInput,
  client: Anthropic,
): Promise<{ letter: string; mode: LetterMode }> {
  const prompt = buildPrompt(input);
  try {
    // The installed @anthropic-ai/sdk (0.70.1) types `thinking` as
    // `ThinkingConfigEnabled | ThinkingConfigDisabled`; `enabled` carries a
    // mandatory `budget_tokens`. There is no `'adaptive'` variant in this
    // SDK version's types — it's a newer API mode the types haven't caught
    // up to yet — and `budget_tokens` is exactly the field this model
    // rejects with HTTP 400. No value of the current union expresses what
    // we need to send, so this one field needs a cast; every other field
    // below (system blocks with cache_control, messages, model) is checked
    // by the compiler against `MessageCreateParamsNonStreaming` with no
    // cast at all.
    const res = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 2000,
      thinking: { type: 'adaptive' } as unknown as Anthropic.Messages.ThinkingConfigParam,
      system: prompt.system,
      messages: prompt.messages,
    });

    const block = res.content.find(
      (b): b is Anthropic.Messages.TextBlock => b.type === 'text',
    );
    return { letter: block?.text ?? '', mode: input.mode };
  } catch {
    // Письмо не сгенерировалось — запись всё равно попадёт в очередь,
    // человек увидит её пустой и напишет письмо руками.
    return { letter: '', mode: 'none' };
  }
}
