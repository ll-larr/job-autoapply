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

export interface GenerateLetterOptions {
  /** Модели OpenRouter, в порядке попытки. Первая, что ответит успешно, и используется. */
  models: string[];
  /** Для тестов — подмена сетевого fetch, как в src/adapters/hrge.ts. */
  fetchImpl?: typeof fetch;
}

export interface PromptParts {
  messages: [
    system: { role: 'system'; content: string },
    user: { role: 'user'; content: string },
  ];
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

const WRITING_RULES = `Правила письма:
- Никаких длинных тире в тексте письма. Только запятые и точки.
- Не начинай с упоминания того, что это отклик на вакансию, или с названия вакансии и компании: адресат это и так знает.
- Никаких списков через двоеточие вроде "Из релевантного:" или "Мой профиль:". Пиши связной прозой.
- Не заканчивай письмо штампами вроде "Готов обсудить детали" или "Резюме прикреплено". Заканчивай конкретной просьбой или вопросом.
- Под полным запретом слова и обороты: "в современном мире", "динамичный", "synergy", "команда профессионалов", "амбициозный", "не только... но и", "хочу отметить", "стоит подчеркнуть", "имею опыт", "что соответствует требованиям", "делают эту позицию особенно интересной", "в рамках", "осуществлял".
- Не пересказывай требования вакансии обратно работодателю. Он их написал. Вместо
  "имею опыт X, что соответствует вашему требованию Y" пиши, что именно ты с X делал.
- Будь конкретен: вместо прилагательного бери цифру, название инструмента или конкретный проект из резюме. Не выдумывай факты, которых нет в резюме.
- Варьируй длину предложений, не делай их все одной формы.
- Не больше одного восклицательного знака на всё письмо, и только в приветствии.
- Никогда не упоминай диплом или университет. Этого не должно быть в письме ни в каком виде.
- Не преувеличивай: заявляй только то, что подтверждено резюме. В частности: он потребляет API
  и прогонял их руками через Postman и curl, но не проектирует и не пишет контракты API сам;
  он читает и правит чужой SQL, но не пишет сложные запросы с нуля. Письмо не должно намекать
  на обратное ни прямо, ни между строк.
- Не преувеличивать — это НЕ значит перечислять, чего он не умеет. Слабые стороны просто
  не упоминаются. Никогда не пиши в письме оборотов вида "сложные запросы с нуля не пишу"
  или "контракты сам не проектирую": работодателя не просили о признаниях, а такая фраза
  топит письмо. Пиши то, что он умеет, и молчи об остальном.
- Если вакансия — стажировка (в тексте вакансии встречается "стажировка", "стажёр", "intern"
  или "trainee"), одним предложением прямо скажи, что на самом деле он рассматривает позиции
  уровня junior+/middle. Без извинений и без долгих объяснений — просто факт.`;

const INSTRUCTION_HYBRID = `Ты помогаешь кандидату откликаться на вакансии бизнес-аналитика.
Тебе дан скелет письма с плейсхолдерами {{HOOK}} и {{FIT}}.
Замени {{TITLE}} и {{COMPANY}} на данные вакансии.
Вместо {{HOOK}} напиши одно-два предложения о том, что конкретно в этой компании
или продукте делает вакансию интересной. Опирайся только на текст вакансии.
ОБА плейсхолдера обязаны быть ЗАМЕНЕНЫ на живой текст. Удалить их и вернуть
скелет без них — это провал задачи, а не её решение: без {{HOOK}} и {{FIT}}
письмо не содержит ни слова про конкретную вакансию, и весь смысл теряется.
Вместо {{FIT}} напиши одно-два предложения, связывающих опыт из резюме
с конкретными требованиями вакансии. В {{FIT}} обязательно должна быть хотя бы одна
конкретная опора из резюме: названный проект, инструмент или цифра, привязанная
к тому, что вакансия реально просит.
Не выдумывай фактов, которых нет в резюме. Верни только готовое письмо, без пояснений.

${WRITING_RULES}`;

const INSTRUCTION_FULL = `Ты помогаешь кандидату откликаться на вакансии бизнес-аналитика.
Напиши сопроводительное письмо с нуля под конкретную вакансию.
Держи объём в 4–6 абзацев, деловой тон без канцелярита и без превосходных степеней.
Опирайся только на факты из резюме — ничего не выдумывай.
Начни с обращения, закончи подписью «кандидат».
Верни только письмо, без пояснений.

${WRITING_RULES}`;

/**
 * Порядок сообщений: стабильное (инструкция + резюме, в hybrid-режиме — ещё
 * и скелет) идёт первым как system-сообщение, волатильное (текст вакансии) —
 * вторым, как user-сообщение. Это просто гигиена расположения: стабильный
 * префикс первым не мешает и кое-где помогает — некоторые провайдеры кешируют
 * запросы на своей стороне без каких-либо явных маркеров от нас. Формального
 * контроля над этим у нас нет: OpenRouter не поддерживает Anthropic-специфичный
 * `cache_control`, поэтому мы его не отправляем и не обещаем экономию на кеше.
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
    messages: [
      { role: 'system', content: stable },
      { role: 'user', content: volatile },
    ],
  };
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Достаёт текст ответа из тела OpenRouter chat-completions, не веря его форме. */
function extractText(body: unknown): string | undefined {
  const choices = (body as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = first?.message?.content;
  return typeof content === 'string' && content !== '' ? content : undefined;
}

const EMPTY_RESULT = { letter: '', mode: 'none' as const };

/**
 * Пробует модели из `options.models` по порядку через OpenRouter. Любой сбой —
 * нет ключа, сетевая ошибка, HTTP-ошибка, ответ без текста — переходит
 * к следующей модели, а не бросает. Если ни одна модель не ответила,
 * возвращается пустое письмо с mode 'none': запись всё равно попадёт
 * в очередь, человек увидит её пустой и напишет письмо руками. Потеря
 * вакансии из-за сбоя генерации — ровно то, что этот контракт не даёт
 * случиться.
 */
/** Куски скелета, по которым видно, что модель их не заполнила. */
const PLACEHOLDER = /\{\{\s*(HOOK|FIT|TITLE|COMPANY)\s*\}\}/;

/**
 * Годен ли ответ модели как письмо.
 *
 * Проверяется две вещи, обе — про гибридный режим, где модель должна была
 * заполнить {{HOOK}} и {{FIT}}:
 *
 * 1. В тексте не осталось незаполненных плейсхолдеров.
 * 2. Текст не является скелетом, из которого плейсхолдеры просто вырезали.
 *    Слабые модели делают именно это: возвращают синтаксически чистое письмо,
 *    в котором нет ни слова про конкретную вакансию. Сравниваем со скелетом,
 *    выкинув из него плейсхолдеры и пробелы: если совпало, модель ничего не
 *    добавила.
 */
export function isUsableLetter(text: string, input: LetterInput): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  if (PLACEHOLDER.test(trimmed)) return false;
  if (input.mode !== 'hybrid') return true;

  const squash = (s: string): string =>
    s.replace(PLACEHOLDER, ' ').replace(/\{\{[^}]*\}\}/g, ' ').replace(/\s+/g, ' ').trim();
  return squash(trimmed) !== squash(input.template);
}

export async function generateLetter(
  input: LetterInput,
  options: GenerateLetterOptions,
): Promise<{ letter: string; mode: LetterMode }> {
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) return EMPTY_RESULT;

  const fetchImpl = options.fetchImpl ?? fetch;
  const prompt = buildPrompt(input);

  for (const model of options.models) {
    try {
      const res = await fetchImpl(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, messages: prompt.messages }),
      });
      if (!res.ok) continue;

      const text = extractText(await res.json());
      if (text === undefined) continue;
      // Модель может вернуть внешне правдоподобное письмо, которое на деле
      // бесполезно: в гибридном режиме слабые модели вырезают {{HOOK}} и
      // {{FIT}} вместо того, чтобы их заполнить, и на выходе оказывается голый
      // скелет без единого слова про эту вакансию. Ради этих двух вставок
      // гибридный режим и существует, поэтому такой ответ считаем неудачей и
      // пробуем следующую модель.
      if (!isUsableLetter(text, input)) continue;
      return { letter: text, mode: input.mode };
    } catch {
      // Эта модель недоступна — пробуем следующую в списке.
      continue;
    }
  }

  return EMPTY_RESULT;
}
