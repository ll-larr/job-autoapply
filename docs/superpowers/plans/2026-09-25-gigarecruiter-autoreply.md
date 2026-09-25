# Автоответ ГигаРекрутёру — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Автоматически отвечать на вопросы скрининг-бота ГигаРекрутёр в Telegram от имени владельца, без его участия, не выдумывая фактов.

**Architecture:** Транспорт — user-сессия MTProto (GramJS), уже авторизованная в `src/telegram/gramjs.ts`; бот боту писать не может. Ответ рождается из трёх источников — резюме, `data/facts.md` и транскрипта диалога, прочитанного из самого чата, — и проходит валидатор, который отбраковывает любое число, которого нет в источниках. Отбраковка передаётся в `complete()` третьим аргументом, поэтому перебор моделей уже встроен. Цикл живёт окном 2 часа после отклика, гаснет после 10 минут тишины и переходит в поллинг раз в 4 часа.

**Tech Stack:** TypeScript (ESM, `.js` в импортах), Node ≥ 24, vitest, GramJS (`telegram`), OpenRouter через `src/core/openrouter.ts`.

**Spec:** `docs/superpowers/specs/2026-09-25-gigarecruiter-autoreply-design.md`

## Global Constraints

- Node ≥ 24, `"type": "module"` — во всех относительных импортах расширение `.js`, даже для `.ts` файлов.
- TypeScript strict. Никаких `any` в сигнатурах.
- Тесты — vitest, плоско в `tests/<имя>.test.ts`, описания `it(...)` по-русски, как во всём репозитории.
- Сети в тестах нет. Внешнее подменяется через параметры-зависимости, как `fetchImpl` в `CompletionOptions` и `DiscoveryDeps` в `proxy.ts`.
- **В чат с ГигаРекрутёром уходит только прошедший валидацию ответ. Заглушка — никогда.**
- **Уведомлений владельцу нет.** Ни пингов в бота, ни писем. Единственный след — `data/interview.log`.
- **Стенограмма диалога в файлы не пишется.** История живёт в Telegram и читается оттуда.
- Кнопки и клавиатуры в чате не нажимаются никогда.
- Охват — ровно один username из `config.gigarecruiter.username`. Никаких других собеседников.
- Политика отказа — параметр вызывающей стороны, не константа внутри `interview.ts`: у будущего автоответчика в личке она другая (спека, 1.1).
- VPN — v2RayTun, `D:\v2RayTun\v2RayTun.exe`. Процессов два: оболочка и ядро `xraycore.exe`.

## Структура файлов

| Файл | Ответственность |
|---|---|
| `data/facts.md` | факты, которых нет в резюме; заполняется владельцем |
| `src/core/facts.ts` | чтение фактов, извлечение белого списка чисел |
| `src/core/interview.ts` | сборка промпта, валидатор, генерация ответа |
| `src/core/vpn.ts` | статус, остановка, запуск, рестарт VPN |
| `src/telegram/interview-session.ts` | узкий интерфейс к одному диалогу: история, отправка, `setTyping`, подписка |
| `src/core/interview-runner.ts` | окно, тишина, поллинг, состояние, повторы, журнал |
| `src/core/config.ts` | блок `gigarecruiter` (правка) |
| `src/cli.ts` | команда `interview` (правка) |
| `scripts/interview-service.ps1` | запуск под планировщиком Windows |

Границы: `interview.ts` не знает про Telegram, `interview-session.ts` не знает про модели, `runner` склеивает и больше ничего не делает.

---

### Task 1: База фактов и белый список чисел

> **Поправки контроллера 2026-09-25 — обязательны и важнее кода ниже, где расходятся:**
>
> - **R1.** `data/` в `.gitignore` намеренно. `data/facts.md` создать на диске, но **не коммитить** — в нём личные данные. В коммит задачи идут только `src/core/facts.ts` и `tests/facts.test.ts`.

**Files:**
- Create: `data/facts.md`
- Create: `src/core/facts.ts`
- Test: `tests/facts.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces: `interface Facts { text: string; numbers: Set<string> }`, `extractNumbers(text: string): Set<string>`, `readFacts(path?: string): Facts`, `FACTS_PATH = 'data/facts.md'`

- [ ] **Step 1: Написать падающий тест**

```typescript
// tests/facts.test.ts
import { describe, it, expect } from 'vitest';
import { extractNumbers } from '../src/core/facts.js';

describe('extractNumbers', () => {
  it('собирает целые, дробные и проценты', () => {
    const n = extractNumbers('сократил с 76 до 11 часов, это 85,5% и 87.5 процента');
    expect(n.has('76')).toBe(true);
    expect(n.has('11')).toBe(true);
    expect(n.has('85.5')).toBe(true);
    expect(n.has('87.5')).toBe(true);
  });

  it('запятая и точка в дробях — одно и то же число', () => {
    expect(extractNumbers('85,5').has('85.5')).toBe(true);
  });

  it('годы и диапазоны разбираются на числа', () => {
    const n = extractNumbers('с 04/2024 по 09/2024, вилка 280–360');
    expect([...n].sort()).toEqual(['04', '09', '2024', '280', '360']);
  });

  it('числительные словами не считаются числами', () => {
    expect(extractNumbers('три вещи и две части').size).toBe(0);
  });
});
```

- [ ] **Step 2: Прогнать, убедиться что падает**

Run: `npx vitest run tests/facts.test.ts`
Expected: FAIL — `Failed to resolve import "../src/core/facts.js"`

- [ ] **Step 3: Написать минимальную реализацию**

```typescript
// src/core/facts.ts
import { readFileSync, existsSync } from 'node:fs';

/**
 * Факты, которых нет в резюме: пробелы в занятости, зарплатная вилка,
 * гражданство, срок выхода. Их нельзя выдумывать (спека 2026-09-25, 5), а
 * значит нужен список того, что владелец разрешил говорить.
 *
 * Белый список чисел — главная защита от округлений: модель охотно правит
 * «85,5%» на «около 90%» и сдвигает годы. Число, которого нет ни в резюме,
 * ни в фактах, ни в самом вопросе, отбраковывает ответ целиком.
 */

export const FACTS_PATH = 'data/facts.md';

export interface Facts {
  text: string;
  numbers: Set<string>;
}

const NUMBER_RE = /\d+(?:[.,]\d+)?/g;

/** Числа текста в единой форме: дробная часть всегда через точку. */
export function extractNumbers(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(NUMBER_RE)) out.add(m[0].replace(',', '.'));
  return out;
}

/** Нет файла — не ошибка: значит фактов пока нет, отвечаем только по резюме. */
export function readFacts(path: string = FACTS_PATH): Facts {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  return { text, numbers: extractNumbers(text) };
}
```

- [ ] **Step 4: Прогнать, убедиться что проходит**

Run: `npx vitest run tests/facts.test.ts`
Expected: PASS, 4 теста

- [ ] **Step 5: Тест на чтение файла**

```typescript
// дописать в tests/facts.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFacts } from '../src/core/facts.js';

describe('readFacts', () => {
  it('читает файл и собирает из него числа', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-'));
    const p = join(dir, 'facts.md');
    writeFileSync(p, 'Зарплатная вилка: 280–360 тысяч на руки.', 'utf8');
    const f = readFacts(p);
    expect(f.text).toContain('280');
    expect(f.numbers.has('360')).toBe(true);
  });

  it('файла нет — пустые факты, не исключение', () => {
    const f = readFacts(join(tmpdir(), 'нет-такого-файла.md'));
    expect(f.text).toBe('');
    expect(f.numbers.size).toBe(0);
  });
});
```

Run: `npx vitest run tests/facts.test.ts`
Expected: PASS, 6 тестов

- [ ] **Step 6: Создать черновик `data/facts.md`**

Заполненное — из диалогов с владельцем 2026-09-15 и 2026-09-25. Пустые поля он дозаполнит сам; незаполненное поле означает, что на такой вопрос машина промолчит.

```markdown
# Факты сверх резюме

Файл читает `src/core/facts.ts`. Всё, что здесь написано, машина имеет право
сказать рекрутёру. Чего здесь нет — не скажет: валидатор отбракует.

## Деньги

Зарплатная вилка: 280–360 тысяч рублей на руки. Конкретная цифра зависит от
грейда, объёма задач и состава компенсационного пакета.

## Пробелы в занятости

Февраль — апрель 2024: закрывал последние фриланс-проекты в web&digital,
готовился к переходу в финтех, проходил отбор в Озон Банк.

Июль — декабрь 2025: переходный период после Озон Банка. Разбирал архитектуру
LLM-агентов и агентных пайплайнов, промпт-инжиниринг, метрики качества ответов,
сравнение провайдеров моделей, собирал пет-проекты. Параллельно искал позицию в
финтехе и бигтехе.

## Условия работы

Формат (офис, гибрид, удалёнка):
Готовность к переезду:
Срок выхода:
Готовность к тестовому заданию:

## Личные данные

Гражданство:
Город проживания: Москва
Отношение к воинской обязанности:

## Образование и языки

Вуз: РЭУ им. Г. В. Плеханова, прикладная информатика
Годы учёбы:
Уровень английского:

## Чего не говорить

Ничего, чего нет в этом файле и в резюме.
```

- [ ] **Step 7: Коммит**

```bash
git add src/core/facts.ts tests/facts.test.ts data/facts.md
git commit -m "feat: база фактов сверх резюме и белый список чисел

Модель не имеет права называть число, которого нет ни в резюме, ни в
фактах, ни в самом вопросе. Здесь — источник этого списка.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Валидатор ответа

**Files:**
- Create: `src/core/interview.ts`
- Test: `tests/interview-validate.test.ts`

**Interfaces:**
- Consumes: `extractNumbers` из Task 1; `findForbiddenClaim` из `src/core/letter.ts`; `findLeak` из `src/bot/reply.ts`
- Produces: `MAX_ANSWER_LENGTH = 1500`, `allowedNumbers(parts: string[]): Set<string>`, `validateAnswer(answer: string, input: { allowed: Set<string>; maxLength?: number }): string | null` — `null` значит годен, строка — причина отбраковки

- [ ] **Step 1: Написать падающий тест**

```typescript
// tests/interview-validate.test.ts
import { describe, it, expect } from 'vitest';
import { allowedNumbers, validateAnswer } from '../src/core/interview.js';

const allowed = allowedNumbers([
  'Сократил трудозатраты с 76 до 11 часов в месяц, на 85,5%',
  'Зарплатная вилка 280–360',
  'Расскажите про опыт с 2024 года',
]);

describe('validateAnswer', () => {
  it('пропускает ответ с числами из источников', () => {
    expect(validateAnswer('С 76 до 11 часов, это 85,5%, с 2024 года.', { allowed })).toBeNull();
  });

  it('режет выдуманное число', () => {
    expect(validateAnswer('Сократил примерно на 90%.', { allowed }))
      .toBe('выдуманное число: 90');
  });

  it('режет сдвинутый год', () => {
    expect(validateAnswer('Работал там с 2023 года.', { allowed }))
      .toBe('выдуманное число: 2023');
  });

  it('пустой ответ не годится', () => {
    expect(validateAnswer('   ', { allowed })).toBe('пустой ответ');
  });

  it('слишком длинный ответ не годится', () => {
    const long = 'а'.repeat(1501);
    expect(validateAnswer(long, { allowed })).toBe('длиннее 1500 символов');
  });

  it('режет маркер автомата', () => {
    expect(validateAnswer('Как языковая модель, я не могу ответить.', { allowed }))
      .toBe('маркер автомата');
  });

  it('режет утечку секрета', () => {
    expect(validateAnswer('Ключ sk-abcdefgh12345 лежит в .env', { allowed }))
      .toBe('в ответе ключ');
  });
});
```

- [ ] **Step 2: Прогнать, убедиться что падает**

Run: `npx vitest run tests/interview-validate.test.ts`
Expected: FAIL — `Failed to resolve import "../src/core/interview.js"`

- [ ] **Step 3: Написать минимальную реализацию**

```typescript
// src/core/interview.ts
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
```

- [ ] **Step 4: Прогнать, убедиться что проходит**

Run: `npx vitest run tests/interview-validate.test.ts`
Expected: PASS, 7 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/core/interview.ts tests/interview-validate.test.ts
git commit -m "feat: валидатор ответа с белым списком чисел

Число, которого нет ни в резюме, ни в фактах, ни в самом вопросе,
отбраковывает ответ целиком. Плюс длина, маркеры автомата, утечки и
приписанные навыки — две последние проверки переиспользуют то, что уже
написано для писем и бота.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Промпт и генерация ответа

> **Поправки контроллера 2026-09-25 — обязательны и важнее кода ниже, где расходятся:**
>
> - **R3.** `complete()` без ключа OpenRouter отказывает ещё до `fetch`. В `tests/interview-generate.test.ts` поставить `setApiKey('sk-test-key')` в `beforeEach` и `setApiKey(null)` в `afterEach` (`setApiKey` экспортирует `src/core/openrouter.ts`).

**Files:**
- Modify: `src/core/interview.ts`
- Test: `tests/interview-generate.test.ts`

**Interfaces:**
- Consumes: `validateAnswer`, `allowedNumbers` из Task 2; `complete`, `ChatMessage`, `CompletionOptions` из `src/core/openrouter.ts`
- Produces: `interface Turn { who: 'bot' | 'me'; text: string }`, `interface AnswerInput { resume: string; facts: string; transcript: Turn[]; question: string }`, `buildInterviewMessages(input: AnswerInput): ChatMessage[]`, `generateAnswer(input: AnswerInput, options: CompletionOptions & { maxLength?: number }): Promise<{ ok: true; text: string } | { ok: false; failure: string }>`

- [ ] **Step 1: Написать падающий тест**

`ChatMessage` в этом репозитории знает только роли `system` и `user` — роли `assistant` нет. Поэтому транскрипт складывается текстовым блоком внутрь `user`-сообщения, а не отдельными репликами.

```typescript
// tests/interview-generate.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildInterviewMessages, generateAnswer } from '../src/core/interview.js';
import type { Turn } from '../src/core/interview.js';

const transcript: Turn[] = [
  { who: 'bot', text: 'Почему сейчас рассматриваете предложения о работе?' },
  { who: 'me', text: 'Не хватает масштаба.' },
];

describe('buildInterviewMessages', () => {
  it('резюме и факты идут в system, вопрос и транскрипт — в user', () => {
    const m = buildInterviewMessages({
      resume: 'РЕЗЮМЕ-ТЕКСТ',
      facts: 'ФАКТЫ-ТЕКСТ',
      transcript,
      question: 'Какой у вас опыт с Kafka?',
    });
    expect(m).toHaveLength(2);
    expect(m[0]!.role).toBe('system');
    expect(m[0]!.content).toContain('РЕЗЮМЕ-ТЕКСТ');
    expect(m[0]!.content).toContain('ФАКТЫ-ТЕКСТ');
    expect(m[1]!.role).toBe('user');
    expect(m[1]!.content).toContain('Какой у вас опыт с Kafka?');
    expect(m[1]!.content).toContain('Не хватает масштаба.');
  });
});

describe('generateAnswer', () => {
  const input = {
    resume: 'Сократил время с 32 до 4 часов',
    facts: 'Вилка 280–360',
    transcript: [] as Turn[],
    question: 'На сколько сократили время инвентаризации?',
  };

  it('годный ответ возвращается как есть', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'С 32 до 4 часов.' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const r = await generateAnswer(input, { models: ['m1'], fetchImpl, attemptsPerModel: 1 });
    expect(r).toEqual({ ok: true, text: 'С 32 до 4 часов.' });
  });

  it('ответ с выдуманным числом отбраковывается, и берётся следующая модель', async () => {
    const bodies = ['Примерно на 90%.', 'С 32 до 4 часов.'];
    let i = 0;
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: bodies[i++] ?? '' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const r = await generateAnswer(input, { models: ['m1', 'm2'], fetchImpl, attemptsPerModel: 1 });
    expect(r).toEqual({ ok: true, text: 'С 32 до 4 часов.' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('все модели дали брак — ok:false, наружу ничего не отдаётся', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'Примерно на 90%.' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const r = await generateAnswer(input, { models: ['m1', 'm2'], fetchImpl, attemptsPerModel: 1 });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Прогнать, убедиться что падает**

Run: `npx vitest run tests/interview-generate.test.ts`
Expected: FAIL — `buildInterviewMessages is not a function`

- [ ] **Step 3: Дописать реализацию в `src/core/interview.ts`**

Ключ к перебору моделей: у `complete()` третий аргумент — функция отбраковки. Вернула строку — текст считается негодным, и `complete` сам идёт к следующей модели. Своего цикла писать не нужно.

```typescript
// дописать в src/core/interview.ts
import { complete, type ChatMessage, type CompletionOptions } from './openrouter.js';
import { COMMON_WRITING_RULES } from './letter.js';
import { withCandidate } from './profile.js';

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

const INSTRUCTION = `${withCandidate('Ты отвечаешь за кандидата на вопросы скрининг-бота работодателя в Telegram.')}
Отвечай от первого лица, как сам кандидат, спокойно и по делу.
Опирайся только на резюме и на раздел «Факты сверх резюме». Ничего не выдумывай:
ни цифр, ни дат, ни названий компаний, ни инструментов.
Если факта нет ни в резюме, ни в фактах — не называй его и не подменяй похожим.
Не округляй числа: 85,5% остаётся 85,5%, а не «около 90%».
Честно оговаривай границы опыта, если вопрос шире того, что ты делал.
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
```

- [ ] **Step 4: Прогнать, убедиться что проходит**

Run: `npx vitest run tests/interview-generate.test.ts tests/interview-validate.test.ts`
Expected: PASS, 11 тестов

- [ ] **Step 5: Прогнать typecheck**

Run: `npm run typecheck`
Expected: без ошибок

- [ ] **Step 6: Коммит**

```bash
git add src/core/interview.ts tests/interview-generate.test.ts
git commit -m "feat: промпт интервью и генерация с отбраковкой

Транскрипт складывается текстовым блоком в user-сообщение: ChatMessage в
этом репозитории знает только system и user, роли assistant нет.

Перебор моделей свой не нужен — complete() принимает функцию отбраковки
третьим аргументом и сам идёт к следующей модели.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Управление VPN

> **Поправки контроллера 2026-09-25 — обязательны и важнее кода ниже, где расходятся:**
>
> - **R4.** После запуска оболочки порт появляется не мгновенно. `restart` после `launch` ждёт порт до `VPN_WAIT_MS = 30_000`, опрашивая `discover` раз в `VPN_POLL_MS = 2_000` через `deps.sleep`. Только если за 30 с порт не появился — попытка провалена, дальше `sleep(VPN_BACKOFF_MS[attempt])` и новая попытка. Бэкофф 5/15/45 с остаётся между попытками. Без этого первая попытка всегда «проваливается», а вторая убивает только что поднимающийся VPN.
> - Тесты из плана переписать под эту логику, сохранив проверяемое поведение: (1) порт сразу — одна пара kill/launch; (2) порт появился на N-м опросе в пределах 30 с — второго launch нет; (3) порт не появился ни разу — ровно 3 launch и `false`; (4) kill строго раньше launch; (5) между попытками выдержан бэкофф `VPN_BACKOFF_MS[0]`. Считать не сырые вызовы `discover`, а launch/kill/sleep.

**Files:**
- Create: `src/core/vpn.ts`
- Test: `tests/vpn.test.ts`

**Interfaces:**
- Consumes: `discoverSocksProxy` из `src/core/proxy.ts`
- Produces: `interface VpnDeps { discover(): Promise<boolean>; kill(): Promise<void>; launch(exe: string): Promise<void>; sleep(ms: number): Promise<void> }`, `VPN_BACKOFF_MS = [5000, 15000, 45000]`, `isUp(deps: Pick<VpnDeps, 'discover'>): Promise<boolean>`, `restart(exe: string, deps: VpnDeps): Promise<boolean>`

- [ ] **Step 1: Написать падающий тест**

```typescript
// tests/vpn.test.ts
import { describe, it, expect, vi } from 'vitest';
import { restart, VPN_BACKOFF_MS } from '../src/core/vpn.js';

function deps(upAfter: number) {
  let calls = 0;
  return {
    calls: () => calls,
    kill: vi.fn(async () => {}),
    launch: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    discover: vi.fn(async () => { calls += 1; return calls > upAfter; }),
  };
}

describe('restart', () => {
  it('поднялся с первой попытки — одна пара kill и launch', async () => {
    const d = deps(0);
    expect(await restart('C:/v2RayTun.exe', d)).toBe(true);
    expect(d.kill).toHaveBeenCalledTimes(1);
    expect(d.launch).toHaveBeenCalledTimes(1);
  });

  it('поднялся со второй — бэкофф выдержан между попытками', async () => {
    const d = deps(1);
    expect(await restart('C:/v2RayTun.exe', d)).toBe(true);
    expect(d.launch).toHaveBeenCalledTimes(2);
    expect(d.sleep).toHaveBeenCalledWith(VPN_BACKOFF_MS[0]);
  });

  it('не поднялся за три попытки — false, больше не пробуем', async () => {
    const d = deps(99);
    expect(await restart('C:/v2RayTun.exe', d)).toBe(false);
    expect(d.launch).toHaveBeenCalledTimes(3);
  });

  it('убиваем до запуска, иначе оболочка переподнимет старое ядро', async () => {
    const order: string[] = [];
    const d = {
      kill: vi.fn(async () => { order.push('kill'); }),
      launch: vi.fn(async () => { order.push('launch'); }),
      sleep: vi.fn(async () => {}),
      discover: vi.fn(async () => true),
    };
    await restart('C:/v2RayTun.exe', d);
    expect(order).toEqual(['kill', 'launch']);
  });
});
```

- [ ] **Step 2: Прогнать, убедиться что падает**

Run: `npx vitest run tests/vpn.test.ts`
Expected: FAIL — `Failed to resolve import "../src/core/vpn.js"`

- [ ] **Step 3: Написать минимальную реализацию**

```typescript
// src/core/vpn.ts
import { execFile } from 'node:child_process';
import { discoverSocksProxy } from './proxy.js';

/**
 * Рестарт VPN (спека 2026-09-25, 7). Рабочий клиент — v2RayTun, и процессов у
 * него два: оболочка `v2RayTun.exe` держит конфиг и сама поднимает ядро
 * `xraycore.exe` во временной папке. Убивать надо оба — иначе оболочка
 * переподнимет ядро со старым состоянием, — а запускать только оболочку.
 *
 * Без VPN Telegram недоступен физически: деградировать тут не во что, цикл
 * просто спит до следующей попытки.
 */

export const VPN_BACKOFF_MS = [5000, 15000, 45000] as const;

const KILL_NAMES = ['v2RayTun.exe', 'xraycore.exe'];

export interface VpnDeps {
  discover(): Promise<boolean>;
  kill(): Promise<void>;
  launch(exe: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 15000, windowsHide: true }, () => resolve());
  });
}

/** Процесса может не быть — taskkill вернёт ошибку, и это нормально. */
export async function killVpn(): Promise<void> {
  for (const name of KILL_NAMES) await run('taskkill', ['/F', '/IM', name]);
}

export async function launchVpn(exe: string): Promise<void> {
  await run('cmd', ['/c', 'start', '', exe]);
}

export async function isUp(deps: Pick<VpnDeps, 'discover'>): Promise<boolean> {
  return deps.discover();
}

export const defaultVpnDeps: VpnDeps = {
  async discover() {
    const { found } = await discoverSocksProxy();
    return found !== null;
  },
  kill: killVpn,
  launch: launchVpn,
  sleep,
};

/** true — прокси снова отвечает. false — три попытки не помогли. */
export async function restart(exe: string, deps: VpnDeps = defaultVpnDeps): Promise<boolean> {
  for (let attempt = 0; attempt < VPN_BACKOFF_MS.length; attempt += 1) {
    await deps.kill();
    await deps.launch(exe);
    if (await deps.discover()) return true;
    await deps.sleep(VPN_BACKOFF_MS[attempt]!);
  }
  return false;
}
```

- [ ] **Step 4: Прогнать, убедиться что проходит**

Run: `npx vitest run tests/vpn.test.ts`
Expected: PASS, 4 теста

- [ ] **Step 5: Коммит**

```bash
git add src/core/vpn.ts tests/vpn.test.ts
git commit -m "feat: рестарт VPN с бэкоффом 5, 15, 45 секунд

У v2RayTun два процесса: оболочка держит конфиг и поднимает ядро
xraycore.exe. Убиваем оба, запускаем только оболочку — иначе она
переподнимет ядро со старым состоянием.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Диалог с одним собеседником

> **Поправки контроллера 2026-09-25 — обязательны и важнее кода ниже, где расходятся:**
>
> - **R2.** Экспортировать `interface DialogMessage extends TgMessage { out: boolean; hasButtons: boolean }`. `history()` отдаёт `DialogMessage[]` (от старых к новым, id > minId), `onMessage` получает `DialogMessage`. В GramJS: `out` — `m.out === true`, `hasButtons` — `m.replyMarkup !== undefined && m.replyMarkup !== null`. Общий `TgMessage` в `src/telegram/types.ts` **не менять**.
> - `fakeDialog(seed?: DialogMessage[])`: `push(text, opts?: { hasButtons?: boolean })` добавляет **входящее** (`out: false`); `send(text)` не только копит в `sent`, но и кладёт **исходящее** (`out: true`) в историю — как настоящий Telegram. Иначе цикл не отличит свои ответы от вопросов.
> - Тесты: к трём из плана добавить — `send` появляется в `history` с `out: true`; `push` с `hasButtons: true` отдаётся с этим признаком.
> - **Шаг 5 плана (клиент из `openTelegram`) обязателен**, приведение типа `as unknown as` в итоговом коде недопустимо.

**Files:**
- Create: `src/telegram/interview-session.ts`
- Test: `tests/interview-session.test.ts`

**Interfaces:**
- Consumes: `openTelegram` из `src/telegram/gramjs.ts`, `TgMessage` из `src/telegram/types.ts`
- Produces: `interface TgDialog { history(minId: number): Promise<TgMessage[]>; send(text: string): Promise<void>; setTyping(): Promise<void>; onMessage(cb: (m: TgMessage) => void): () => void; close(): Promise<void> }`, `openDialog(username: string): Promise<{ ok: true; dialog: TgDialog } | { ok: false; reason: string }>`, `fakeDialog(seed?: TgMessage[]): TgDialog & { sent: string[]; push(text: string): void }`

Существующий `TgReader` не подходит: его `dialogs()` намеренно не отдаёт личные переписки, а `resolveChat` возвращает `TgChat` с типом `channel | group`. Для личного диалога с ботом нужен свой узкий интерфейс — он же делает цикл тестируемым без сети.

- [ ] **Step 1: Написать падающий тест**

```typescript
// tests/interview-session.test.ts
import { describe, it, expect } from 'vitest';
import { fakeDialog } from '../src/telegram/interview-session.js';

describe('fakeDialog', () => {
  it('history отдаёт только сообщения новее minId, от старых к новым', async () => {
    const d = fakeDialog([
      { id: 1, date: new Date(), text: 'первое', urls: [] },
      { id: 5, date: new Date(), text: 'второе', urls: [] },
      { id: 9, date: new Date(), text: 'третье', urls: [] },
    ]);
    const got = await d.history(5);
    expect(got.map((m) => m.id)).toEqual([9]);
  });

  it('send копит отправленное', async () => {
    const d = fakeDialog();
    await d.send('привет');
    expect(d.sent).toEqual(['привет']);
  });

  it('onMessage получает новые сообщения и отписывается', () => {
    const d = fakeDialog();
    const seen: string[] = [];
    const off = d.onMessage((m) => seen.push(m.text));
    d.push('раз');
    off();
    d.push('два');
    expect(seen).toEqual(['раз']);
  });
});
```

- [ ] **Step 2: Прогнать, убедиться что падает**

Run: `npx vitest run tests/interview-session.test.ts`
Expected: FAIL — `Failed to resolve import "../src/telegram/interview-session.js"`

- [ ] **Step 3: Написать минимальную реализацию**

```typescript
// src/telegram/interview-session.ts
import { Api } from 'telegram';
import { NewMessage } from 'telegram/events/index.js';
import { openTelegram } from './gramjs.js';
import type { TgMessage } from './types.js';

/**
 * Один личный диалог одним объектом (спека 2026-09-25, 4). Существующий
 * TgReader тут не годится: он намеренно не отдаёт личные переписки, а
 * resolveChat знает только каналы и группы.
 *
 * Интерфейс узкий сознательно: цикл не должен уметь ничего, кроме как читать
 * историю одного собеседника, писать ему и показывать «печатает». Ни списка
 * чатов, ни рассылки, ни кнопок.
 */

export interface TgDialog {
  /** Сообщения новее minId, от старых к новым. */
  history(minId: number): Promise<TgMessage[]>;
  send(text: string): Promise<void>;
  setTyping(): Promise<void>;
  /** Подписка на входящие. Возвращает функцию отписки. */
  onMessage(cb: (m: TgMessage) => void): () => void;
  close(): Promise<void>;
}

function toTgMessage(m: Api.Message): TgMessage {
  return { id: m.id, date: new Date(m.date * 1000), text: m.message ?? '', urls: [] };
}

export async function openDialog(
  username: string,
): Promise<{ ok: true; dialog: TgDialog } | { ok: false; reason: string }> {
  const opened = await openTelegram();
  if (!opened.ok) return { ok: false, reason: opened.message };
  const client = (opened as unknown as { client: import('telegram').TelegramClient }).client;
  const peer = await client.getInputEntity(username);

  const dialog: TgDialog = {
    async history(minId: number) {
      const msgs = await client.getMessages(peer, { limit: 100, minId });
      return msgs.map(toTgMessage).reverse();
    },
    async send(text: string) {
      await client.sendMessage(peer, { message: text });
    },
    async setTyping() {
      await client.invoke(new Api.messages.SetTyping({ peer, action: new Api.SendMessageTypingAction() }));
    },
    onMessage(cb) {
      const handler = (event: { message: Api.Message }): void => cb(toTgMessage(event.message));
      client.addEventHandler(handler, new NewMessage({ fromUsers: [username], incoming: true }));
      return () => client.removeEventHandler(handler, new NewMessage({ fromUsers: [username], incoming: true }));
    },
    async close() {
      await opened.close();
    },
  };
  return { ok: true, dialog };
}

/** Подмена для тестов: сети нет, всё в памяти. */
export function fakeDialog(seed: TgMessage[] = []): TgDialog & { sent: string[]; push(text: string): void } {
  const messages = [...seed];
  const sent: string[] = [];
  const subs = new Set<(m: TgMessage) => void>();
  let nextId = Math.max(0, ...messages.map((m) => m.id)) + 1;

  return {
    sent,
    async history(minId: number) {
      return messages.filter((m) => m.id > minId).sort((a, b) => a.id - b.id);
    },
    async send(text: string) {
      sent.push(text);
    },
    async setTyping() {},
    onMessage(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    push(text: string) {
      const m: TgMessage = { id: nextId++, date: new Date(), text, urls: [] };
      messages.push(m);
      for (const cb of subs) cb(m);
    },
    async close() {},
  };
}
```

- [ ] **Step 4: Прогнать, убедиться что проходит**

Run: `npx vitest run tests/interview-session.test.ts`
Expected: PASS, 3 теста

- [ ] **Step 5: Проверить, что `openTelegram` отдаёт клиент**

`openTelegram()` сейчас возвращает `{ reader, sender, close }` и не отдаёт сам `TelegramClient`, а приведение типа в `openDialog` — костыль. Прочитать `src/telegram/gramjs.ts:29-80` и добавить `client` в успешный `OpenResult`, затем убрать приведение:

```typescript
// src/telegram/gramjs.ts — в тип OpenResult
export type OpenResult =
  | { ok: true; client: TelegramClient; reader: TgReader; sender: TgSender; close(): Promise<void> }
  | { ok: false; reason: 'no_keys' | 'no_session' | 'no_proxy' | 'auth'; message: string };
```

и в месте формирования успешного результата добавить `client` в объект. В `openDialog` заменить строку с приведением на `const client = opened.client;`.

- [ ] **Step 6: Прогнать весь набор тестов**

Run: `npm test`
Expected: PASS, все существующие тесты плюс новые

- [ ] **Step 7: Коммит**

```bash
git add src/telegram/interview-session.ts src/telegram/gramjs.ts tests/interview-session.test.ts
git commit -m "feat: узкий интерфейс к одному личному диалогу

TgReader для этого не годится: он намеренно не отдаёт личные переписки, а
resolveChat знает только каналы и группы.

Интерфейс узкий сознательно — читать историю одного собеседника, писать
ему, показывать печатает. Ни списка чатов, ни рассылки, ни кнопок.
openTelegram теперь отдаёт и сам клиент, иначе подписку не повесить.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Цикл — окно, тишина, поллинг, повторы

> **Поправки контроллера 2026-09-25 — обязательны и важнее кода ниже, где расходятся:**
>
> - **R5.** Тест шага 5 использует `dirname` — импортировать его из `node:path` вместе с `join`.
> - `answerOnce` принимает вопрос как `DialogMessage` из задачи 5 (`import type { DialogMessage } from '../telegram/interview-session.js'`), а не `TgMessage`; фикстуры тестов дополнить полями `out: false, hasButtons: false`.

**Files:**
- Create: `src/core/interview-runner.ts`
- Test: `tests/interview-runner.test.ts`

**Interfaces:**
- Consumes: `generateAnswer`, `Turn` (Task 3); `TgDialog`, `fakeDialog` (Task 5); `restart`, `isUp` (Task 4); `readFacts` (Task 1)
- Produces: `interface RunnerState { lastMessageId: number; windowUntil: number; lastPollAt: number }`, `STATE_PATH = 'data/interview-state.json'`, `LOG_PATH = 'data/interview.log'`, `RETRY_BACKOFF_MS = [30000, 120000, 300000, 900000]`, `backoffFor(round: number): number`, `readState(path?: string): RunnerState`, `writeState(s: RunnerState, path?: string): void`, `openWindow(now: number, minutes: number, path?: string): void`, `answerOnce(deps: AnswerDeps): Promise<'sent' | 'retry' | 'idle'>`

- [ ] **Step 1: Написать падающий тест на бэкофф и состояние**

```typescript
// tests/interview-runner.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backoffFor, readState, writeState, openWindow, RETRY_BACKOFF_MS } from '../src/core/interview-runner.js';

describe('backoffFor', () => {
  it('идёт по лестнице 30 секунд, 2, 5, 15 минут', () => {
    expect(backoffFor(0)).toBe(RETRY_BACKOFF_MS[0]);
    expect(backoffFor(1)).toBe(RETRY_BACKOFF_MS[1]);
    expect(backoffFor(3)).toBe(RETRY_BACKOFF_MS[3]);
  });

  it('дальше держит последнюю ступень, а не растёт бесконечно', () => {
    expect(backoffFor(99)).toBe(RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
  });
});

describe('состояние', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'runner-')), 'state.json');

  it('файла нет — нули, не исключение', () => {
    expect(readState(path)).toEqual({ lastMessageId: 0, windowUntil: 0, lastPollAt: 0 });
  });

  it('пишется и читается', () => {
    writeState({ lastMessageId: 42, windowUntil: 100, lastPollAt: 50 }, path);
    expect(readState(path).lastMessageId).toBe(42);
  });

  it('openWindow сдвигает окно, не трогая lastMessageId', () => {
    writeState({ lastMessageId: 42, windowUntil: 0, lastPollAt: 0 }, path);
    openWindow(1_000_000, 120, path);
    const s = readState(path);
    expect(s.windowUntil).toBe(1_000_000 + 120 * 60_000);
    expect(s.lastMessageId).toBe(42);
  });
});
```

- [ ] **Step 2: Прогнать, убедиться что падает**

Run: `npx vitest run tests/interview-runner.test.ts`
Expected: FAIL — `Failed to resolve import "../src/core/interview-runner.js"`

- [ ] **Step 3: Написать состояние, журнал и бэкофф**

```typescript
// src/core/interview-runner.ts
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Цикл автоответа (спека 2026-09-25, 3 и 7). Окно 2 часа после отклика,
 * гашение после 10 минут тишины, поллинг раз в 4 часа.
 *
 * Уведомлений владельцу нет по его решению: единственный след — журнал. Это
 * значит, что протухшая сессия или упавший VPN никого не разбудят, и так
 * задумано.
 */

export const STATE_PATH = 'data/interview-state.json';
export const LOG_PATH = 'data/interview.log';
export const RETRY_BACKOFF_MS = [30_000, 120_000, 300_000, 900_000] as const;

export interface RunnerState {
  lastMessageId: number;
  windowUntil: number;
  lastPollAt: number;
}

const EMPTY: RunnerState = { lastMessageId: 0, windowUntil: 0, lastPollAt: 0 };

export function backoffFor(round: number): number {
  const i = Math.min(round, RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[i]!;
}

export function readState(path: string = STATE_PATH): RunnerState {
  if (!existsSync(path)) return { ...EMPTY };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RunnerState>;
    return {
      lastMessageId: Number(raw.lastMessageId ?? 0),
      windowUntil: Number(raw.windowUntil ?? 0),
      lastPollAt: Number(raw.lastPollAt ?? 0),
    };
  } catch {
    // Битый файл не должен ронять цикл: начинаем с нуля.
    return { ...EMPTY };
  }
}

export function writeState(s: RunnerState, path: string = STATE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(s, null, 2), 'utf8');
}

export function openWindow(now: number, minutes: number, path: string = STATE_PATH): void {
  const s = readState(path);
  writeState({ ...s, windowUntil: now + minutes * 60_000 }, path);
}

export function log(line: string, path: string = LOG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8');
}
```

- [ ] **Step 4: Прогнать, убедиться что проходит**

Run: `npx vitest run tests/interview-runner.test.ts`
Expected: PASS, 5 тестов

- [ ] **Step 5: Тест на один шаг ответа**

```typescript
// дописать в tests/interview-runner.test.ts
import { vi } from 'vitest';
import { answerOnce } from '../src/core/interview-runner.js';
import { fakeDialog } from '../src/telegram/interview-session.js';

function deps(over: Partial<Parameters<typeof answerOnce>[0]> = {}) {
  const dialog = fakeDialog();
  const statePath = join(mkdtempSync(join(tmpdir(), 'once-')), 'state.json');
  const logPath = join(dirname(statePath), 'run.log');
  return {
    dialog,
    statePath,
    logPath,
    question: { id: 7, date: new Date(), text: 'Какой опыт с Kafka?', urls: [] },
    transcript: [],
    generate: vi.fn(async () => ({ ok: true as const, text: 'Проектировал контракт события.' })),
    delay: vi.fn(async () => {}),
    ...over,
  };
}

describe('answerOnce', () => {
  it('годный ответ уходит в чат, lastMessageId двигается', async () => {
    const d = deps();
    expect(await answerOnce(d)).toBe('sent');
    expect(d.dialog.sent).toEqual(['Проектировал контракт события.']);
    expect(readState(d.statePath).lastMessageId).toBe(7);
  });

  it('lastMessageId записывается до отправки — падение не даст ответить дважды', async () => {
    const d = deps();
    d.dialog.send = vi.fn(async () => { throw new Error('сеть'); });
    await expect(answerOnce(d)).rejects.toThrow('сеть');
    expect(readState(d.statePath).lastMessageId).toBe(7);
  });

  it('провал моделей — в чат ничего, статус retry', async () => {
    const d = deps({ generate: vi.fn(async () => ({ ok: false as const, failure: 'все модели дали брак' })) });
    expect(await answerOnce(d)).toBe('retry');
    expect(d.dialog.sent).toEqual([]);
    expect(readState(d.statePath).lastMessageId).toBe(0);
  });

  it('уже отвеченный вопрос пропускается', async () => {
    const d = deps();
    writeState({ lastMessageId: 7, windowUntil: 0, lastPollAt: 0 }, d.statePath);
    expect(await answerOnce(d)).toBe('idle');
    expect(d.dialog.sent).toEqual([]);
  });

  it('перед ответом выдерживается задержка', async () => {
    const d = deps();
    await answerOnce(d);
    expect(d.delay).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 6: Прогнать, убедиться что падает**

Run: `npx vitest run tests/interview-runner.test.ts`
Expected: FAIL — `answerOnce is not a function`

- [ ] **Step 7: Реализовать `answerOnce`**

```typescript
// дописать в src/core/interview-runner.ts
import type { TgMessage } from '../telegram/types.js';
import type { TgDialog } from '../telegram/interview-session.js';
import type { Turn } from './interview.js';

export interface AnswerDeps {
  dialog: TgDialog;
  question: TgMessage;
  transcript: Turn[];
  generate(input: { transcript: Turn[]; question: string }): Promise<{ ok: true; text: string } | { ok: false; failure: string }>;
  /** Пауза перед ответом: мгновенный ответ выдаёт машину. */
  delay(): Promise<void>;
  statePath?: string;
  logPath?: string;
}

/**
 * Один вопрос — один ответ.
 *
 * 'sent' — ответ ушёл. 'retry' — модели не дали годного текста, в чат не ушло
 * ничего, вызывающая сторона ставит бэкофф. 'idle' — на этот вопрос уже
 * отвечали.
 */
export async function answerOnce(deps: AnswerDeps): Promise<'sent' | 'retry' | 'idle'> {
  const statePath = deps.statePath ?? STATE_PATH;
  const logPath = deps.logPath ?? LOG_PATH;
  const state = readState(statePath);
  if (deps.question.id <= state.lastMessageId) return 'idle';

  const r = await deps.generate({ transcript: deps.transcript, question: deps.question.text });
  if (!r.ok) {
    log(`брак: ${r.failure}`, logPath);
    return 'retry';
  }

  await deps.delay();
  await deps.dialog.setTyping();
  // Метку двигаем до отправки: падение на полпути не даст ответить дважды.
  writeState({ ...state, lastMessageId: deps.question.id }, statePath);
  await deps.dialog.send(r.text);
  log(`ответ на ${deps.question.id}: ${r.text.length} символов`, logPath);
  return 'sent';
}
```

- [ ] **Step 8: Прогнать, убедиться что проходит**

Run: `npx vitest run tests/interview-runner.test.ts`
Expected: PASS, 10 тестов

- [ ] **Step 9: Коммит**

```bash
git add src/core/interview-runner.ts tests/interview-runner.test.ts
git commit -m "feat: шаг ответа, состояние и лестница повторов

lastMessageId пишется до отправки: падение на полпути не даст ответить
дважды на один вопрос. Провал моделей не отправляет в чат ничего — только
строку в журнал и retry наружу.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Сборка цикла, конфиг, команда, планировщик

> **Поправки контроллера 2026-09-25 — обязательны и важнее кода ниже, где расходятся:**
>
> Задача 7 в плане содержит дефекты цикла. Реализовать `runInterview` **по этим правилам, а не по коду шага 5**:
>
> - **R6.** Импорты в `interview-runner.ts` слить: `readFileSync` уже импортирован в задаче 6, повторный импорт — ошибка компиляции.
> - **R7.** Входящее с `hasButtons: true` не отвечается никогда: `lastMessageId` сдвигается за него без отправки, в журнал строка «пропущено сообщение с кнопками».
> - **R8. Семантика запуска.**
>   - `windowUntil > now` (окно открыто): сессия живёт до `windowUntil`; после **первого отправленного в этой сессии** ответа она гаснет ещё и по `idleMinutes` тишины. До первого ответа тишина её не гасит — окно ждёт первое сообщение.
>   - `windowUntil <= now` (поллинг): если входящих новее `lastMessageId` нет — выход сразу, одна строка в журнал. Есть — отвечаем и живём до `idleMinutes` тишины.
>   - «Тишина» — время с последнего входящего или отправленного сообщения.
>   - CLI **не** открывает окно на каждом запуске. `npm run interview` — просто запуск. `npm run interview -- --window` — сначала `openWindow(now, windowMinutes)`, потом запуск.
> - **R9. Цикл последовательный, без рекурсии и без гонки с `close()`.** Раз в 5 с `dialog.history(lastMessageId)`. Взять все подряд идущие входящие (`out: false`) без кнопок, склеить тексты через перевод строки в **один** вопрос — ГигаРекрутёр шлёт «Спасибо за ответ» и вопрос то одним сообщением, то двумя, отвечать надо один раз. `lastMessageId` после ответа — id последнего из группы. Транскрипт — вся история до группы (`out` → `me`, иначе `bot`). Исход `retry` — `sleep(backoffFor(round))`, `round += 1`, следующая итерация; исход `sent` — `round = 0`. Подписка `onMessage` не обязательна.
>   - Для этого `answerOnce` расширить или добавить рядом функцию уровня группы — на твоё усмотрение, но с тестами на склейку двух входящих и на пропуск сообщения с кнопками.
> - **R10. Один экземпляр.** `data/interview.lock` с pid процесса. Файл есть и pid жив (`process.kill(pid, 0)` не бросает) — строка в журнал и выход. pid мёртв — перехватить. Снимать в `finally`. Тест на захват, на отказ при живом pid и на перехват мёртвого.
> - Все зависимости `runInterview` (время, сон, открытие диалога, VPN, генерация, пути состояния/журнала/блокировки) — внедряемые параметры с боевыми значениями по умолчанию, чтобы окно, тишину и поллинг проверить тестом на `fakeDialog` без сети и без реального ожидания. Минимум тестов: поллинг без новых — выход без отправки; окно ждёт первое сообщение дольше `idleMinutes`; после ответа тишина `idleMinutes` гасит сессию; своё исходящее не отвечается.
> - Шаги 8 (скрипт планировщика) и 9 (живая проверка собеседника) **перенесены в задачу 8**. В коммит задачи 7 скрипт не входит.

**Files:**
- Modify: `src/core/interview-runner.ts`
- Modify: `src/core/config.ts`
- Modify: `src/cli.ts`
- Modify: `package.json`
- Create: `scripts/interview-service.ps1`
- Test: `tests/interview-loop.test.ts`

**Interfaces:**
- Consumes: всё из задач 1–6
- Produces: `interface GigarecruiterConfig { username: string; windowMinutes: number; idleMinutes: number; pollHours: number; replyDelaySec: [number, number]; maxReplyLength: number; models?: string[]; vpnExe: string }`, `DEFAULT_GIGARECRUITER`, `runInterview(opts: { config: GigarecruiterConfig; now?: () => number }): Promise<void>`

- [ ] **Step 1: Написать падающий тест на сквозной прогон**

Фикстура — реальные вопросы живого интервью 2026-09-15.

```typescript
// tests/interview-loop.test.ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fakeDialog } from '../src/telegram/interview-session.js';
import { answerOnce, readState, writeState } from '../src/core/interview-runner.js';
import type { Turn } from '../src/core/interview.js';

const QUESTIONS = [
  'Почему сейчас рассматриваете предложения о работе?',
  'Чем вас заинтересовала данная вакансия?',
  'Какой у Вас желаемый уровень заработной платы?',
  'Расскажите, как Вы используете Postman или Curl в работе?',
  'Могли бы привести пример задачи, где Вы применяли RabbitMQ или Kafka?',
  'Уточните, чем Вы занимались в период с июля 2025 по февраль 2026 года?',
];

describe('сквозной прогон шести вопросов', () => {
  it('на каждый уходит ровно один ответ, метка растёт', async () => {
    const dialog = fakeDialog();
    const statePath = join(mkdtempSync(join(tmpdir(), 'loop-')), 'state.json');
    const logPath = join(dirname(statePath), 'run.log');
    const transcript: Turn[] = [];

    for (const [i, text] of QUESTIONS.entries()) {
      const question = { id: i + 1, date: new Date(), text, urls: [] };
      const r = await answerOnce({
        dialog,
        question,
        transcript,
        statePath,
        logPath,
        generate: async () => ({ ok: true as const, text: `Ответ ${i + 1}.` }),
        delay: async () => {},
      });
      expect(r).toBe('sent');
      transcript.push({ who: 'bot', text }, { who: 'me', text: `Ответ ${i + 1}.` });
    }

    expect(dialog.sent).toHaveLength(6);
    expect(readState(statePath).lastMessageId).toBe(6);
  });

  it('повторная обработка тех же вопросов ничего не досылает', async () => {
    const dialog = fakeDialog();
    const statePath = join(mkdtempSync(join(tmpdir(), 'loop2-')), 'state.json');
    writeState({ lastMessageId: 6, windowUntil: 0, lastPollAt: 0 }, statePath);

    for (const [i, text] of QUESTIONS.entries()) {
      const r = await answerOnce({
        dialog,
        question: { id: i + 1, date: new Date(), text, urls: [] },
        transcript: [],
        statePath,
        generate: async () => ({ ok: true as const, text: 'не должно уйти' }),
        delay: async () => {},
      });
      expect(r).toBe('idle');
    }
    expect(dialog.sent).toEqual([]);
  });
});
```

- [ ] **Step 2: Прогнать — тест должен пройти сразу**

Run: `npx vitest run tests/interview-loop.test.ts`
Expected: PASS, 2 теста. Он проверяет уже написанное в Task 6; если падает — чинить Task 6, а не подгонять тест.

- [ ] **Step 3: Добавить блок конфига**

```typescript
// дописать в src/core/config.ts рядом с BotConfig

/** Автоответ ГигаРекрутёру (спека 2026-09-25). Нет блока — команда не запускается. */
export interface GigarecruiterConfig {
  /** Username бота без @. */
  username: string;
  windowMinutes: number;
  idleMinutes: number;
  pollHours: number;
  /** Пауза перед ответом, секунды: [минимум, максимум]. */
  replyDelaySec: [number, number];
  maxReplyLength: number;
  /** Не задано — те же модели, что у писем. */
  models?: string[];
  /** Оболочка VPN. Ядро она поднимает сама. */
  vpnExe: string;
}

export const DEFAULT_GIGARECRUITER: Omit<GigarecruiterConfig, 'username' | 'vpnExe'> = {
  windowMinutes: 120,
  idleMinutes: 10,
  pollHours: 4,
  replyDelaySec: [40, 120],
  maxReplyLength: 1500,
};
```

и поле в основном интерфейсе конфига, рядом с `bot?: BotConfig`:

```typescript
  /** Автоответ ГигаРекрутёру (спека 2026-09-25). Нет блока — команда не запускается. */
  gigarecruiter?: GigarecruiterConfig;
```

- [ ] **Step 4: Прописать блок в `config.json`**

```json
  "gigarecruiter": {
    "username": "Giga_recruiter_bot",
    "windowMinutes": 120,
    "idleMinutes": 10,
    "pollHours": 4,
    "replyDelaySec": [40, 120],
    "maxReplyLength": 1500,
    "vpnExe": "D:\\v2RayTun\\v2RayTun.exe"
  }
```

- [ ] **Step 5: Собрать цикл `runInterview`**

```typescript
// дописать в src/core/interview-runner.ts
import { readFileSync } from 'node:fs';
import { openDialog } from '../telegram/interview-session.js';
import { generateAnswer } from './interview.js';
import { readFacts } from './facts.js';
import { restart, isUp, defaultVpnDeps, sleep } from './vpn.js';
import type { GigarecruiterConfig } from './config.js';

function randomDelayMs(range: [number, number]): number {
  const [lo, hi] = range;
  return (lo + Math.random() * Math.max(0, hi - lo)) * 1000;
}

/** История чата в транскрипт: чужие сообщения — бот, свои — кандидат. */
function toTranscript(messages: { id: number; text: string; out?: boolean }[]): Turn[] {
  return messages.map((m) => ({ who: m.out === true ? 'me' : 'bot', text: m.text }));
}

export async function runInterview(opts: {
  config: GigarecruiterConfig;
  resumePath: string;
  models: string[];
  now?: () => number;
}): Promise<void> {
  const now = opts.now ?? (() => Date.now());
  const cfg = opts.config;

  if (!(await isUp(defaultVpnDeps))) {
    log('VPN не отвечает, пробую рестарт');
    if (!(await restart(cfg.vpnExe))) {
      log('VPN не поднялся за три попытки, цикл спит до следующего поллинга');
      return;
    }
  }

  const opened = await openDialog(cfg.username);
  if (!opened.ok) {
    log(`диалог не открылся: ${opened.reason}`);
    return;
  }
  const dialog = opened.dialog;
  const resume = readFileSync(opts.resumePath, 'utf8');
  const facts = readFacts().text;

  let lastActivity = now();
  let round = 0;
  let busy = false;

  const handle = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const state = readState();
      const fresh = await dialog.history(state.lastMessageId);
      const question = fresh.at(-1);
      if (question === undefined) return;
      const transcript = toTranscript(await dialog.history(0)).slice(0, -1);

      const r = await answerOnce({
        dialog,
        question,
        transcript,
        delay: () => sleep(randomDelayMs(cfg.replyDelaySec)),
        generate: (input) => generateAnswer(
          { resume, facts, transcript: input.transcript, question: input.question },
          { models: opts.models, maxLength: cfg.maxReplyLength },
        ),
      });

      if (r === 'sent') {
        lastActivity = now();
        round = 0;
      } else if (r === 'retry') {
        await sleep(backoffFor(round));
        round += 1;
        busy = false;
        await handle();
      }
    } finally {
      busy = false;
    }
  };

  const off = dialog.onMessage(() => { lastActivity = now(); void handle(); });
  await handle();

  // Гасим сессию по тишине или по концу окна — что наступит раньше.
  const idleMs = cfg.idleMinutes * 60_000;
  while (now() - lastActivity < idleMs && now() < readState().windowUntil) {
    await sleep(5000);
  }

  off();
  await dialog.close();
  writeState({ ...readState(), lastPollAt: now() });
  log('сессия закрыта по тишине');
}
```

- [ ] **Step 6: Команда в `src/cli.ts`**

Найти, как зарегистрированы существующие команды (`bot`, `send`, `status`), и добавить рядом по тому же образцу:

```typescript
    case 'interview': {
      const cfg = config.gigarecruiter;
      if (cfg === undefined) {
        console.error('Блок gigarecruiter в config.json не задан — команда не запускается');
        process.exitCode = 1;
        return;
      }
      openWindow(Date.now(), cfg.windowMinutes);
      await runInterview({
        config: cfg,
        resumePath: LEGACY_RESUME_MD,
        models: cfg.models ?? config.letterModels,
      });
      return;
    }
```

и строку в `package.json`:

```json
    "interview": "tsx src/cli.ts interview",
```

- [ ] **Step 7: Прогнать весь набор и typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, ошибок типов нет

- [ ] **Step 8: Скрипт для планировщика**

```powershell
# scripts/interview-service.ps1
# Автоответ ГигаРекрутёру под планировщиком Windows (спека 2026-09-25, 3).
# Первый запуск 2026-09-25 в 22:40: окно держится до 00:40, дальше поллинг
# раз в 4 часа.
$ErrorActionPreference = 'Stop'
Set-Location -Path (Split-Path -Parent $PSScriptRoot)
npm run interview
```

Регистрация задачи (выполнить один раз, вручную):

```powershell
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\lar\job-autoapply\scripts\interview-service.ps1"'
$trigger = New-ScheduledTaskTrigger -Once -At '2026-09-25T22:40:00' -RepetitionInterval (New-TimeSpan -Hours 4)
Register-ScheduledTask -TaskName 'job-autoapply-interview' -Action $action -Trigger $trigger -Description 'Автоответ ГигаРекрутёру'
```

- [ ] **Step 9: Подтвердить собеседника вживую**

Опечатка в username тихо фатальна: подписка встанет на пустое место, цикл
будет ждать вечно и ничего не сообщит. Проверить до планировщика, при
включённом VPN:

```bash
npx tsx -e "import('./src/telegram/interview-session.js').then(async (m) => { const r = await m.openDialog('Giga_recruiter_bot'); if (!r.ok) { console.error('НЕ ОТКРЫЛСЯ:', r.reason); process.exit(1); } const h = await r.dialog.history(0); console.log('сообщений в диалоге:', h.length); console.log('последнее:', h.at(-1)?.text.slice(0, 80)); await r.dialog.close(); })"
```

Expected: непустая история, в последнем сообщении — текст из реального диалога
с ГигаРекрутёром. Пустая история или ошибка резолва означают неверный username.

- [ ] **Step 10: Коммит**

```bash
git add src/core/interview-runner.ts src/core/config.ts src/cli.ts package.json config.json scripts/interview-service.ps1 tests/interview-loop.test.ts
git commit -m "feat: цикл автоответа целиком, команда и планировщик

Окно 2 часа после отклика, гашение по 10 минутам тишины, поллинг раз в 4
часа. Перед стартом проверяется VPN и при необходимости перезапускается.

Сквозной тест гоняет шесть реальных вопросов интервью 2026-09-15 и
проверяет, что повторный прогон не досылает ничего.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Триггер от отклика и планировщик

> Задача добавлена контроллером 2026-09-25 (R11, R12): спека, раздел 3, пункты 1 и 5, а в плане их не было.

**Files:**
- Create: `src/core/interview-trigger.ts`
- Modify: `src/core/sender.ts` (внедряемый хук после успешного отклика)
- Modify: `src/cli.ts` (передать хук в Sender там, где он создаётся для `send`)
- Create: `scripts/interview-service.ps1`
- Test: `tests/interview-trigger.test.ts`, дополнить тест Sender, если хук затрагивает его поведение

**Interfaces:**
- Consumes: `openWindow(now, minutes, path?)` из задачи 6; `GigarecruiterConfig` из задачи 7; `Vacancy` из `src/core/vacancy.ts` (поля `company`, `title`)
- Produces: `isSberVacancy(v: Pick<Vacancy, 'company' | 'title'>): boolean`; `triggerInterview(v, deps: { config: GigarecruiterConfig | undefined; now(): number; openWindow(now: number, minutes: number): void; spawnInterview(): void }): boolean` — `true`, если окно открыто и запуск отдан

**Требования:**

1. `isSberVacancy` — `company` или `title` совпадает с `/сбер|sber/i`. Тест: «ПАО Сбербанк», «SberTech», «Сбер» в заголовке — да; «Озон Банк», «Тинькофф» — нет.
2. `triggerInterview`: блока `gigarecruiter` нет или вакансия не Сбер — `false`, ничего не делает. Иначе `openWindow(now, config.windowMinutes)`, затем `spawnInterview()`, `true`. Тесты на все три ветки.
3. Боевой `spawnInterview` — отсоединённый процесс, переживающий `npm run send`: `spawn('cmd.exe', ['/c', 'npm', 'run', 'interview'], { cwd: <корень репозитория>, detached: true, stdio: 'ignore', windowsHide: true }).unref()`. Второй экземпляр, если он уже идёт, сам выйдет по блокировке из задачи 7 — а продлённое окно подхватит.
4. В `src/core/sender.ts` после ветки `result.status === 'sent'` (строка около 260; **не** для `'already_applied'`) вызвать внедрённый необязательный хук `onSent?.(vacancy)`. Хук не должен ронять отправку: исключение ловится и уходит в журнал отправки. По умолчанию хука нет — существующие тесты Sender не меняются. Как именно вакансия доступна в этой точке — прочитать код; если там строка очереди, а не `Vacancy`, передать то, что содержит `company` и `title`.
5. В `src/cli.ts` для команды `send` передать хук, собранный из `triggerInterview` с боевыми зависимостями.
6. `scripts/interview-service.ps1` — по образцу `scripts/bot-service.ps1` **в его текущем, исправленном виде** (прочитать файл): UTF-8 с BOM и CRLF, `conhost.exe --headless cmd.exe /c ...`, журнал `data\interview-service.log`, триггеры с `-User "$env:USERDOMAIN\$env:USERNAME"`, `Register-ScheduledTask ... -User $me -Force`. Две задачи:
   - `job-autoapply-interview-window` — разово `2026-09-25T22:40:00`, аргумент `npm run interview -- --window`;
   - `job-autoapply-interview-poll` — с `2026-09-26T00:40:00`, повтор раз в 4 часа без срока, аргумент `npm run interview`.
   В шапке — как снять обе задачи. Проверить парсером PowerShell (`[System.Management.Automation.Language.Parser]::ParseFile`) — ноль ошибок. **Не регистрировать** задачи самому: это делает владелец.
7. **Не выполнять** живую проверку собеседника и ничего не отправлять в Telegram — это делает контроллер после задачи.

- [ ] Тесты `tests/interview-trigger.test.ts` — падают
- [ ] Реализация — проходят
- [ ] Хук в Sender и CLI, весь набор `npm test` и `npm run typecheck` зелёные
- [ ] `scripts/interview-service.ps1`, парсер без ошибок
- [ ] Коммит поимённо: `src/core/interview-trigger.ts src/core/sender.ts src/cli.ts scripts/interview-service.ps1 tests/interview-trigger.test.ts` (+ файл теста Sender, если трогал)

---

## Что остаётся владельцу

Одна вещь, без которой цикл не поедет, и сделать её может только он:

1. **Заполнить `data/facts.md`.** Пустое поле означает, что на такой вопрос машина промолчит и уйдёт в повторы. Качество автоответа равно качеству этого файла.

Username ГигаРекрутёра владелец назвал 2026-09-25: `Giga_recruiter_bot`, он уже
вписан в конфиг. На первом живом запуске его надо подтвердить (шаг 10 задачи 7):
опечатка здесь тихо фатальна — подписка встанет на несуществующего
собеседника, и цикл будет молча ждать вечно.

## Самопроверка плана

**Покрытие спеки:**

| Раздел спеки | Задача |
|---|---|
| 1.1 Две формы ответа | Task 2 — политика отказа вынесена из `interview.ts` |
| 3 Триггер и расписание | Task 7 — окно, тишина, поллинг, планировщик |
| 4 Модули | Tasks 1–7, по файлу на задачу |
| 5 Промпт и база фактов | Tasks 1, 3 |
| 6 Валидатор | Task 2 |
| 7 Отказы: модели | Tasks 3, 6 — отбраковка и лестница повторов |
| 7 Отказы: VPN | Task 4 |
| 7 Отказы: Telegram | Task 5 — `openDialog` возвращает причину, не бросает |
| 8 Конфиг и состояние | Tasks 6, 7 |
| 9 Тесты | в каждой задаче |

**Пробелы, найденные при проверке и закрытые в плане:**

- `ChatMessage` не знает роли `assistant` — транскрипт сложен текстовым блоком в `user` (Task 3, шаг 1).
- `TgReader` намеренно не отдаёт личные переписки — нужен свой узкий интерфейс (Task 5).
- `openTelegram()` не отдаёт `TelegramClient`, без него не повесить подписку — правка в Task 5, шаг 5.
- `complete()` принимает функцию отбраковки третьим аргументом, поэтому свой перебор моделей писать не нужно (Task 3, шаг 3).

**Согласованность имён:** `answerOnce`, `readState`, `writeState`, `openWindow`, `backoffFor`, `log` — одни и те же во всех задачах. `Turn`, `TgDialog`, `RunnerState`, `GigarecruiterConfig` объявлены по одному разу и переиспользуются по импорту.
