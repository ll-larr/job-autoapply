import type { Vacancy } from './vacancy.js';
import { createProxiedFetch } from './proxy.js';
import { describeHttpFailure, extractText } from './letter.js';
import { withCandidate } from './profile.js';

/**
 * Вопросы работодателя («тест»), которые hh.ru требует пройти перед откликом.
 *
 * Разметка снята живьём 2026-09-19 на вакансии 137094932 при полной блокировке
 * модифицирующих запросов (tests/fixtures/hh-response-questions.html). Каждый
 * вопрос — блок `[data-qa="task-body"]`: текст в `[data-qa="task-question"]`,
 * варианты — radio `task_<id>`, у части вопросов вариант `open` («свой
 * вариант») с textarea `task_<id>_text`; вопрос без вариантов — только
 * textarea. Checkbox-вопросы встречаются на других вакансиях (см. скилл jobs),
 * поэтому тип `multi` поддержан, хотя живьём не снят.
 *
 * Отвечает модель, без одобрения человеком — так решил владелец 2026-09-19.
 * Поэтому здесь строгая валидация: ответ, который не ложится на форму (нет
 * такого варианта, пропущен вопрос, пустой текст), отбраковывается, и
 * пробуется следующая модель. Невалидный ответ никогда не доходит до формы.
 */

export interface QuestionOption {
  value: string;
  label: string;
}

export interface TestQuestion {
  /** Имя поля варианта (`task_<id>`); у текстового вопроса — имя textarea. */
  name: string;
  text: string;
  kind: 'single' | 'multi' | 'text';
  options: QuestionOption[];
  /** Имя textarea для «своего варианта» или текстового ответа; null — поля нет. */
  textName: string | null;
}

export interface TestAnswer {
  name: string;
  /** Выбранные значения вариантов. Для `single` ровно одно, для `text` пусто. */
  values: string[];
  /** Текст в textarea. Обязателен для `text` и для варианта `open`. */
  text: string;
}

export interface AnswerContext {
  vacancy: Vacancy;
  resume: string;
  /**
   * Что писать на вопрос о зарплатных ожиданиях. В резюме этого нет, а
   * выдумывать число модель не должна. Не задано — «готов обсудить».
   */
  salaryExpectation?: string;
}

export interface AnswerOptions {
  models: string[];
  attemptsPerModel?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const OPEN_VALUE = 'open';

function instruction(salary: string): string {
  return `${withCandidate('Ты заполняешь за кандидата анкету работодателя на hh.ru перед откликом на вакансию.')}
Ответы уходят работодателю без проверки человеком, поэтому правило одно: не врать.

Как отвечать:
- Вопросы о фактах (опыт, стаж, инструменты, нотации, отрасли, уровень языка) — строго по резюме.
  Резюме подтверждает — выбирай «да». Не подтверждает или противоречит — выбирай «нет».
  Стаж считай по датам и цифрам из резюме, не округляй вверх.
- Если вопрос просит подробности («напишите название и сроки», «опишите»), выбери вариант «${OPEN_VALUE}»
  и коротко перечисли факты из резюме: проекты, компании, сроки. Одно-три предложения.
- Вопросы о готовности (формат работы, офис, график, выход, переезд в пределах города) — отвечай «да»,
  если резюме этому явно не противоречит.
- Вопрос о зарплатных ожиданиях: «${salary}». Другого числа не придумывай.
- Текстовый ответ — деловой, от первого лица, без длинных тире, без выдумок.

Верни ТОЛЬКО JSON-массив, без пояснений и без markdown:
[{"name": "<name вопроса>", "values": ["<value варианта>", ...], "text": "<текст или пустая строка>"}]
Для вопроса kind=single в values ровно одно значение из его options.
Для kind=multi — одно или несколько значений из options.
Для kind=text values пустой, text обязателен.
Если выбран вариант "${OPEN_VALUE}", text обязателен.
Ответь на КАЖДЫЙ вопрос.`;
}

export function buildQuestionsPrompt(
  questions: TestQuestion[],
  ctx: AnswerContext,
): { role: 'system' | 'user'; content: string }[] {
  const salary = ctx.salaryExpectation?.trim() || 'Готов обсудить на собеседовании';
  const payload = questions.map((q) => ({
    name: q.name,
    kind: q.kind,
    question: q.text,
    options: q.options.map((o) => ({ value: o.value, label: o.label })),
  }));
  return [
    { role: 'system', content: `${instruction(salary)}\n\nРезюме:\n${ctx.resume}` },
    {
      role: 'user',
      content: `Вакансия: ${ctx.vacancy.title} (${ctx.vacancy.company})\n\n${ctx.vacancy.description}\n\n`
        + `Вопросы:\n${JSON.stringify(payload, null, 2)}`,
    },
  ];
}

/**
 * Разбирает ответ модели и сверяет его с формой. null — ответ негоден
 * целиком: частично заполненная анкета хуже, чем её отсутствие, потому что
 * отправить её можно только один раз.
 */
export function parseAnswers(raw: string, questions: TestQuestion[]): TestAnswer[] | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const byName = new Map<string, { values?: unknown; text?: unknown }>();
  for (const item of parsed) {
    if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
      byName.set((item as { name: string }).name, item as { values?: unknown; text?: unknown });
    }
  }

  const out: TestAnswer[] = [];
  for (const q of questions) {
    const a = byName.get(q.name);
    if (a === undefined) return null;
    const values = Array.isArray(a.values) ? a.values.filter((v): v is string => typeof v === 'string') : [];
    const text = typeof a.text === 'string' ? a.text.trim() : '';
    const allowed = new Set(q.options.map((o) => o.value));

    if (q.kind === 'text') {
      if (text === '') return null;
      out.push({ name: q.name, values: [], text });
      continue;
    }
    if (values.length === 0 || values.some((v) => !allowed.has(v))) return null;
    if (q.kind === 'single' && values.length !== 1) return null;
    if (values.includes(OPEN_VALUE) && (text === '' || q.textName === null)) return null;
    out.push({ name: q.name, values, text: values.includes(OPEN_VALUE) ? text : '' });
  }
  return out;
}

const proxiedFetch = createProxiedFetch();

/**
 * Ответы на анкету через OpenRouter, та же цепочка моделей и повторов, что у
 * писем (см. generateLetter). Не бросает: всё, что пошло не так, — в failure.
 */
export async function answerQuestions(
  questions: TestQuestion[],
  ctx: AnswerContext,
  options: AnswerOptions,
): Promise<{ answers: TestAnswer[] | null; failure?: string }> {
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) return { answers: null, failure: 'OPENROUTER_API_KEY не найден' };

  const fetchImpl = options.fetchImpl ?? proxiedFetch;
  const attempts = options.attemptsPerModel ?? 3;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const messages = buildQuestionsPrompt(questions, ctx);
  let failure = 'ни одна модель не ответила пригодной анкетой';

  for (const model of options.models) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await fetchImpl(OPENROUTER_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          failure = `${model}: ${describeHttpFailure(res.status, await res.text().catch(() => ''))}`;
          continue;
        }
        const text = extractText(await res.json());
        const answers = text === undefined ? null : parseAnswers(text, questions);
        if (answers === null) {
          failure = `${model}: ответ не ложится на анкету`;
          continue;
        }
        return { answers };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failure = `${model}: ${msg.slice(0, 160)}`;
      }
    }
  }
  return { answers: null, failure };
}
