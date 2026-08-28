# Job Autoapply — ядро и первые два адаптера

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Построить ядро системы полуавтоматической подачи резюме и два адаптера-крайности — браузерный `hh.ru` и HTTP-шный `hr.ge` — чтобы проверить, что интерфейс `Adapter` выдерживает обе формы без протечек в ядро.

**Architecture:** Конвейер из пяти стадий, границы которых — записи в SQLite: `search → dedupe → score → letter → queue`, затем человек одобряет в локальной панели, и `sender` отправляет. Адаптеры знают всё про свою площадку и ничего про ядро; ядро знает интерфейс из двух методов и ничего про площадки.

**Tech Stack:** Node.js 24 + TypeScript (strict), `node:sqlite` (встроен в Node, без нативных сборок), Playwright, `@anthropic-ai/sdk`, vitest, tsx.

Спека: [`docs/superpowers/specs/2026-08-27-job-autoapply-design.md`](../specs/2026-08-27-job-autoapply-design.md)

## Global Constraints

- Node.js `>=24.0.0`. На машине стоит `v24.14.0`, npm `11.9.0`.
- TypeScript в режиме `strict: true`. ESM (`"type": "module"`).
- Хранилище — **только `node:sqlite`** (встроенный модуль Node). Никаких `better-sqlite3` и прочих нативных зависимостей.
- **Паролей нет нигде** — ни в коде, ни в конфиге, ни в переменных окружения. Аутентификация только через `chromium.launchPersistentContext` на профиле, куда пользователь залогинился руками.
- **Обход капчи не реализуется ни в каком виде.** Обнаружение капчи всегда означает остановку очереди и уведомление человека.
- Каталог профиля браузера (`browser-profile/`), файлы `*.db`, `*.sqlite` и `.env` — в `.gitignore` (уже сделано в коммите `6b257c1`).
- Тесты не ходят в живую сеть. Адаптеры тестируются против зафиксированных фикстур в `tests/fixtures/`.
- `geekjob.ru` вне этой итерации, но правило действует с самого начала: его `/json/` и `/rest/` закрыты в robots.txt и не используются никогда.
- Модель для писем — `claude-opus-5`, `thinking: { type: "adaptive" }`. `budget_tokens` на этой модели возвращает 400 и не применяется.
- Все коммиты заканчиваются строкой `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## Структура файлов

```
job-autoapply/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── config.json                     # пороги и лимиты; НЕ секреты
├── src/
│   ├── core/
│   │   ├── vacancy.ts              # модель вакансии + нормализация
│   │   ├── config.ts               # типизированная загрузка config.json
│   │   ├── scorer.ts               # скоринг вакансии против резюме
│   │   ├── queue.ts                # SQLite: очередь, дедуп, статусы
│   │   ├── letter.ts               # генерация письма, два режима
│   │   └── sender.ts               # троттлинг, остановка по капче
│   ├── adapters/
│   │   ├── types.ts                # интерфейс Adapter, ApplyResult
│   │   ├── hrge.ts                 # HTTP-адаптер
│   │   └── hh.ts                   # Playwright-адаптер
│   ├── ui/
│   │   ├── server.ts               # http-сервер панели
│   │   └── panel.html              # одна страница, без фреймворков
│   └── cli.ts                      # точка входа
├── templates/                      # скелеты писем (пишет пользователь)
└── tests/
    ├── fixtures/                   # сохранённые HTML и HTTP-ответы
    └── *.test.ts
```

Ответственности не пересекаются: `vacancy` не знает про SQLite, `queue` не знает про площадки, `adapters/*` не импортируют ничего из `core/` кроме `vacancy` и `types`.

---

### Task 1: Каркас проекта и модель вакансии

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `src/core/vacancy.ts`
- Test: `tests/vacancy.test.ts`

**Interfaces:**
- Consumes: ничего (первая задача)
- Produces: тип `Vacancy`, функция `normalizeVacancy(raw: RawVacancy): Vacancy`, тип `RawVacancy`, функция `vacancyKey(v: Vacancy): string`

- [ ] **Step 1: Создать `package.json`**

```json
{
  "name": "job-autoapply",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "cli": "tsx src/cli.ts"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.70.0",
    "playwright": "^1.56.0"
  }
}
```

- [ ] **Step 2: Создать `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Создать `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Установить зависимости**

Run: `npm install`
Expected: `node_modules/` создан, ошибок нет. Нативных сборок быть не должно — `node:sqlite` встроен.

- [ ] **Step 5: Написать падающий тест**

Создать `tests/vacancy.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeVacancy, vacancyKey } from '../src/core/vacancy.js';

describe('normalizeVacancy', () => {
  it('обрезает пробелы и схлопывает переносы в описании', () => {
    const v = normalizeVacancy({
      source: 'hh',
      sourceId: '123',
      title: '  Бизнес-аналитик  ',
      company: ' Сбер ',
      url: 'https://hh.ru/vacancy/123',
      description: 'Первая строка\n\n\n\nВторая строка   ',
      geo: 'Москва',
      postedAt: '2026-08-20T10:00:00Z',
    });

    expect(v.title).toBe('Бизнес-аналитик');
    expect(v.company).toBe('Сбер');
    expect(v.description).toBe('Первая строка\n\nВторая строка');
    expect(v.postedAt).toBeInstanceOf(Date);
  });

  it('по умолчанию проставляет false для isRemote и hasSponsorship', () => {
    const v = normalizeVacancy({
      source: 'hrge', sourceId: '9', title: 'Analyst', company: 'X',
      url: 'https://hr.ge/announcement/9', description: 'text',
      geo: 'Tbilisi', postedAt: '2026-08-20T10:00:00Z',
    });
    expect(v.isRemote).toBe(false);
    expect(v.hasSponsorship).toBe(false);
    expect(v.salaryFrom).toBeNull();
  });

  it('бросает на пустой sourceId — без него дедуп невозможен', () => {
    expect(() => normalizeVacancy({
      source: 'hh', sourceId: '  ', title: 'T', company: 'C',
      url: 'u', description: 'd', geo: 'g', postedAt: '2026-08-20T10:00:00Z',
    })).toThrow('sourceId');
  });
});

describe('vacancyKey', () => {
  it('склеивает source и sourceId — это ключ дедупликации', () => {
    const v = normalizeVacancy({
      source: 'hh', sourceId: '123', title: 'T', company: 'C',
      url: 'u', description: 'd', geo: 'g', postedAt: '2026-08-20T10:00:00Z',
    });
    expect(vacancyKey(v)).toBe('hh:123');
  });
});
```

- [ ] **Step 6: Запустить тест, убедиться что падает**

Run: `npm test -- tests/vacancy.test.ts`
Expected: FAIL — `Failed to resolve import "../src/core/vacancy.js"`

- [ ] **Step 7: Написать минимальную реализацию**

Создать `src/core/vacancy.ts`:

```typescript
export interface RawVacancy {
  source: string;
  sourceId: string;
  title: string;
  company: string;
  url: string;
  description: string;
  geo: string;
  postedAt: string | Date;
  salaryFrom?: number | null;
  salaryTo?: number | null;
  currency?: string | null;
  isRemote?: boolean;
  hasSponsorship?: boolean;
}

export interface Vacancy {
  source: string;
  sourceId: string;
  title: string;
  company: string;
  url: string;
  description: string;
  geo: string;
  postedAt: Date;
  salaryFrom: number | null;
  salaryTo: number | null;
  currency: string | null;
  isRemote: boolean;
  hasSponsorship: boolean;
}

function clean(s: string): string {
  return s.trim().replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
}

export function normalizeVacancy(raw: RawVacancy): Vacancy {
  const sourceId = raw.sourceId.trim();
  if (sourceId === '') {
    throw new Error('normalizeVacancy: sourceId は required — без него дедупликация невозможна');
  }
  return {
    source: raw.source.trim(),
    sourceId,
    title: clean(raw.title),
    company: clean(raw.company),
    url: raw.url.trim(),
    description: clean(raw.description),
    geo: clean(raw.geo),
    postedAt: raw.postedAt instanceof Date ? raw.postedAt : new Date(raw.postedAt),
    salaryFrom: raw.salaryFrom ?? null,
    salaryTo: raw.salaryTo ?? null,
    currency: raw.currency ?? null,
    isRemote: raw.isRemote ?? false,
    hasSponsorship: raw.hasSponsorship ?? false,
  };
}

export function vacancyKey(v: Vacancy): string {
  return `${v.source}:${v.sourceId}`;
}
```

Замечание для реализующего: строка сообщения об ошибке выше содержит опечатку (`は`). Исправь на `'normalizeVacancy: sourceId is required — без него дедупликация невозможна'`. Тест проверяет только вхождение подстроки `sourceId`, так что оба варианта пройдут — но мусор в коде оставлять нельзя.

- [ ] **Step 8: Запустить тесты**

Run: `npm test -- tests/vacancy.test.ts`
Expected: PASS, 4 теста

- [ ] **Step 9: Проверить типы**

Run: `npm run typecheck`
Expected: без ошибок

- [ ] **Step 10: Коммит**

```bash
git add package.json tsconfig.json vitest.config.ts src/core/vacancy.ts tests/vacancy.test.ts package-lock.json
git commit -m "feat: project scaffold and Vacancy model

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Конфиг

**Files:**
- Create: `config.json`, `src/core/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces: тип `Config`, функция `loadConfig(path?: string): Config`

Конфиг держит пороги и лимиты. Секретов в нём нет: ключ Anthropic читается из переменной окружения, пароли не хранятся вообще.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/core/config.js';

function withConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'jaa-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify(obj), 'utf8');
  return p;
}

describe('loadConfig', () => {
  it('читает пороги и лимиты', () => {
    const p = withConfig({
      minScore: 40,
      letterFullThreshold: 75,
      throttle: { hh: { maxPerHour: 10, maxPerDay: 40, minDelayMs: 20000, maxDelayMs: 90000 } },
    });
    const c = loadConfig(p);
    expect(c.minScore).toBe(40);
    expect(c.letterFullThreshold).toBe(75);
    expect(c.throttle.hh?.maxPerDay).toBe(40);
  });

  it('бросает, если letterFullThreshold ниже minScore — такая пара бессмысленна', () => {
    const p = withConfig({
      minScore: 80, letterFullThreshold: 50, throttle: {},
    });
    expect(() => loadConfig(p)).toThrow('letterFullThreshold');
  });

  it('бросает, если minDelayMs больше maxDelayMs', () => {
    const p = withConfig({
      minScore: 40, letterFullThreshold: 75,
      throttle: { hh: { maxPerHour: 10, maxPerDay: 40, minDelayMs: 90000, maxDelayMs: 20000 } },
    });
    expect(() => loadConfig(p)).toThrow('minDelayMs');
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npm test -- tests/config.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать**

Создать `src/core/config.ts`:

```typescript
import { readFileSync } from 'node:fs';

export interface ThrottleRule {
  maxPerHour: number;
  maxPerDay: number;
  minDelayMs: number;
  maxDelayMs: number;
}

export interface Config {
  minScore: number;
  letterFullThreshold: number;
  throttle: Record<string, ThrottleRule | undefined>;
}

export function loadConfig(path = 'config.json'): Config {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Config;

  if (typeof parsed.minScore !== 'number' || typeof parsed.letterFullThreshold !== 'number') {
    throw new Error('loadConfig: minScore и letterFullThreshold обязательны и должны быть числами');
  }
  if (parsed.letterFullThreshold < parsed.minScore) {
    throw new Error(
      `loadConfig: letterFullThreshold (${parsed.letterFullThreshold}) ниже minScore (${parsed.minScore}) — режим full недостижим`,
    );
  }
  for (const [site, rule] of Object.entries(parsed.throttle ?? {})) {
    if (!rule) continue;
    if (rule.minDelayMs > rule.maxDelayMs) {
      throw new Error(`loadConfig: ${site}: minDelayMs больше maxDelayMs`);
    }
  }
  return parsed;
}
```

- [ ] **Step 4: Создать боевой `config.json`**

```json
{
  "minScore": 40,
  "letterFullThreshold": 75,
  "throttle": {
    "hh": { "maxPerHour": 10, "maxPerDay": 40, "minDelayMs": 20000, "maxDelayMs": 90000 },
    "hrge": { "maxPerHour": 15, "maxPerDay": 50, "minDelayMs": 10000, "maxDelayMs": 45000 }
  }
}
```

Пороги и лимиты стартовые. Калибруются после первой живой выборки.

- [ ] **Step 5: Запустить тесты**

Run: `npm test -- tests/config.test.ts`
Expected: PASS, 3 теста

- [ ] **Step 6: Коммит**

```bash
git add config.json src/core/config.ts tests/config.test.ts
git commit -m "feat: typed config loader with threshold and throttle validation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Интерфейс адаптера

**Files:**
- Create: `src/adapters/types.ts`
- Test: `tests/adapter-contract.test.ts`

**Interfaces:**
- Consumes: `Vacancy` из Task 1
- Produces: типы `Adapter`, `SearchFilters`, `ApplyResult`; функция `isHaltingResult(r: ApplyResult): boolean`; набор контрактных тестов `runAdapterContract(name, makeAdapter)`, который переиспользуют Task 6 и Task 8

Это самый маленький файл в проекте и самая важная граница. Если позже для какой-то площадки захочется добавить сюда третий метод — значит дизайн поехал, и это повод остановиться.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/adapter-contract.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isHaltingResult } from '../src/adapters/types.js';
import type { Adapter, ApplyResult } from '../src/adapters/types.js';

describe('isHaltingResult', () => {
  it('captcha и auth_required останавливают очередь', () => {
    expect(isHaltingResult({ status: 'captcha' })).toBe(true);
    expect(isHaltingResult({ status: 'auth_required' })).toBe(true);
  });

  it('обычные исходы очередь не останавливают', () => {
    const ok: ApplyResult[] = [
      { status: 'sent' },
      { status: 'already_applied' },
      { status: 'failed', reason: 'кнопка не найдена' },
    ];
    for (const r of ok) expect(isHaltingResult(r)).toBe(false);
  });
});

describe('Adapter surface', () => {
  it('интерфейс состоит ровно из name, search и apply', () => {
    const stub: Adapter = {
      name: 'stub',
      async search() { return []; },
      async apply() { return { status: 'sent' }; },
    };
    expect(Object.keys(stub).sort()).toEqual(['apply', 'name', 'search']);
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npm test -- tests/adapter-contract.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать**

Создать `src/adapters/types.ts`:

```typescript
import type { Vacancy } from '../core/vacancy.js';

export interface SearchFilters {
  query: string;
  geo?: string;
  remoteOnly?: boolean;
  maxResults?: number;
}

export type ApplyResult =
  | { status: 'sent' }
  | { status: 'already_applied' }
  | { status: 'captcha' }
  | { status: 'auth_required' }
  | { status: 'failed'; reason: string };

export interface Adapter {
  readonly name: string;
  search(filters: SearchFilters): Promise<Vacancy[]>;
  apply(vacancy: Vacancy, letter: string): Promise<ApplyResult>;
}

/**
 * captcha и auth_required требуют человека. Всё остальное — обычный исход
 * одной подачи, очередь продолжает работу.
 */
export function isHaltingResult(r: ApplyResult): boolean {
  return r.status === 'captcha' || r.status === 'auth_required';
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test -- tests/adapter-contract.test.ts`
Expected: PASS, 3 теста

- [ ] **Step 5: Коммит**

```bash
git add src/adapters/types.ts tests/adapter-contract.test.ts
git commit -m "feat: Adapter interface with halting-result distinction

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Скоринг

**Files:**
- Create: `src/core/scorer.ts`
- Test: `tests/scorer.test.ts`

**Interfaces:**
- Consumes: `Vacancy` (Task 1), `Config` (Task 2)
- Produces: `scoreVacancy(v: Vacancy, weights?: KeywordWeights): ScoreResult`, где `ScoreResult = { score: number; matched: string[] }`; экспорт `DEFAULT_WEIGHTS`

Веса взяты из карты рынка, собранной 2026-08-25 по 14 живым вакансиям (Сбер, Т-Банк, ВТБ, Альфа, ПСБ, ОТП, Ozon, МТС). Логика правил, не LLM: детерминированно, объяснимо, бесплатно.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/scorer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { scoreVacancy, DEFAULT_WEIGHTS } from '../src/core/scorer.js';
import { normalizeVacancy } from '../src/core/vacancy.js';

function v(description: string, title = 'Бизнес-аналитик') {
  return normalizeVacancy({
    source: 'hh', sourceId: 'x', title, company: 'C',
    url: 'u', description, geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
  });
}

describe('scoreVacancy', () => {
  it('пустое описание даёт ноль и пустой список совпадений', () => {
    const r = scoreVacancy(v('Ищем человека.'));
    expect(r.score).toBe(0);
    expect(r.matched).toEqual([]);
  });

  it('AI/LLM весит больше, чем BPMN — это дифференциатор, а не гигиена', () => {
    const ai = scoreVacancy(v('Требуется опыт с LLM и AI-агентами'));
    const bpmn = scoreVacancy(v('Требуется BPMN'));
    expect(ai.score).toBeGreaterThan(bpmn.score);
  });

  it('совпадение в заголовке считается так же, как в описании', () => {
    const inTitle = scoreVacancy(v('текст без ключевиков', 'SQL-аналитик'));
    expect(inTitle.matched).toContain('sql');
  });

  it('ключевик засчитывается один раз, сколько бы ни повторялся', () => {
    const once = scoreVacancy(v('SQL'));
    const many = scoreVacancy(v('SQL SQL SQL SQL SQL'));
    expect(many.score).toBe(once.score);
  });

  it('скор ограничен сверху сотней', () => {
    // По одному настоящему ключевику на каждую группу: сырая сумма весов 102,
    // поэтому тест действительно проходит через Math.min(100, total).
    // Через Object.keys(DEFAULT_WEIGHTS) он набирал бы 72 и проходил бы
    // даже с удалённым капом — то есть не проверял бы ничего.
    const everyGroup = 'LLM SQL DWH REST BRD ROI BPMN UML Kafka';
    const r = scoreVacancy(v(everyGroup));
    expect(r.matched).toHaveLength(Object.keys(DEFAULT_WEIGHTS).length);
    expect(r.score).toBe(100);
  });

  it('возвращает совпавшие ключевики — они идут в письмо', () => {
    const r = scoreVacancy(v('Нужен SQL, Kafka и BPMN'));
    expect(r.matched.sort()).toEqual(['bpmn', 'kafka', 'sql']);
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npm test -- tests/scorer.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать**

Создать `src/core/scorer.ts`:

```typescript
import type { Vacancy } from './vacancy.js';

export type KeywordWeights = Record<string, { weight: number; patterns: RegExp[] }>;

export interface ScoreResult {
  score: number;
  matched: string[];
}

/**
 * Веса из карты рынка БА 1–3 года (14 вакансий бигтеха/финтеха, 2026-08-25).
 * AI/LLM — главный дифференциатор года, поэтому весит больше всего.
 * BPMN/UML — базовая гигиена, весят мало: они есть у всех и никого не отличают.
 */
export const DEFAULT_WEIGHTS: KeywordWeights = {
  'ai-llm':     { weight: 22, patterns: [/\bLLM\b/i, /\bAI[- ]?агент/i, /\bGenAI\b/i, /мультиагент/i, /\bRAG\b/i] },
  sql:          { weight: 18, patterns: [/\bSQL\b/i] },
  dwh:          { weight: 12, patterns: [/\bDWH\b/i, /ClickHouse/i, /Vertica/i, /Superset/i, /Tableau/i, /Power ?BI/i] },
  integrations: { weight: 12, patterns: [/\bKafka\b/i, /\bREST\b/i, /\bSOAP\b/i, /микросервис/i, /Swagger/i, /Postman/i] },
  artifacts:    { weight: 10, patterns: [/\bBRD\b/i, /\bFSD\b/i, /\bSRS\b/i, /user stor/i, /Gherkin/i, /acceptance criteria/i] },
  product:      { weight: 8,  patterns: [/\bCJM\b/i, /A\/B/i, /юнит[- ]эконом/i, /\bROI\b/i, /когортн/i] },
  bpmn:         { weight: 6,  patterns: [/\bBPMN\b/i] },
  uml:          { weight: 6,  patterns: [/\bUML\b/i] },
  kafka:        { weight: 8,  patterns: [/\bKafka\b/i] },
};

export function scoreVacancy(v: Vacancy, weights: KeywordWeights = DEFAULT_WEIGHTS): ScoreResult {
  const haystack = `${v.title}\n${v.description}`;
  const matched: string[] = [];
  let total = 0;

  for (const [key, { weight, patterns }] of Object.entries(weights)) {
    if (patterns.some((re) => re.test(haystack))) {
      matched.push(key);
      total += weight;
    }
  }

  return { score: Math.min(100, total), matched: matched.sort() };
}
```

Замечание для реализующего: тест `'возвращает совпавшие ключевики'` ожидает ровно `['bpmn', 'kafka', 'sql']`, но строка `'Нужен SQL, Kafka и BPMN'` попадёт ещё и в `integrations` (там есть паттерн `/\bKafka\b/i`). Это настоящее противоречие в весах — `Kafka` перечислен дважды, в `integrations` и в `kafka`, и один ключевик не должен начисляться дважды. Убери `/\bKafka\b/i` из `integrations`, оставив его только в отдельной группе `kafka`. После правки тест проходит.

- [ ] **Step 4: Запустить тесты**

Run: `npm test -- tests/scorer.test.ts`
Expected: PASS, 6 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/core/scorer.ts tests/scorer.test.ts
git commit -m "feat: rule-based vacancy scorer weighted by 2026 BA market map

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Очередь на SQLite

**Files:**
- Create: `src/core/queue.ts`
- Test: `tests/queue.test.ts`

**Interfaces:**
- Consumes: `Vacancy`, `vacancyKey` (Task 1)
- Produces: класс `Queue` с методами `constructor(dbPath: string)`, `insertPending(v, score, matched, letter, letterMode): boolean`, `has(v): boolean`, `listByStatus(status): QueueRow[]`, `approve(id, letter?)`, `skip(id)`, `markSent(id)`, `markFailed(id, reason)`, `recoverStuck(): number`, `countSentSince(source, sinceMs): number`, `close()`. Тип `QueueRow`, тип `Status = 'pending'|'approved'|'skipped'|'sent'|'failed'`

Это сердце надёжности. Уникальный индекс на `(source, source_id)` — единственная гарантия, что отклик не уйдёт дважды.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/queue.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Queue } from '../src/core/queue.js';
import { normalizeVacancy } from '../src/core/vacancy.js';

function mkVacancy(sourceId: string, source = 'hh') {
  return normalizeVacancy({
    source, sourceId, title: 'БА', company: 'C',
    url: `https://x/${sourceId}`, description: 'd', geo: 'Москва',
    postedAt: '2026-08-20T00:00:00Z',
  });
}

let q: Queue;
beforeEach(() => {
  q = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-q-')), 'test.db'));
});
afterEach(() => q.close());

describe('Queue дедупликация', () => {
  it('вторая вставка той же вакансии отклоняется', () => {
    const v = mkVacancy('1');
    expect(q.insertPending(v, 50, ['sql'], 'письмо', 'hybrid')).toBe(true);
    expect(q.insertPending(v, 50, ['sql'], 'другое письмо', 'full')).toBe(false);
    expect(q.listByStatus('pending')).toHaveLength(1);
  });

  it('одинаковый sourceId на разных площадках — разные записи', () => {
    expect(q.insertPending(mkVacancy('1', 'hh'), 50, [], 'l', 'hybrid')).toBe(true);
    expect(q.insertPending(mkVacancy('1', 'hrge'), 50, [], 'l', 'hybrid')).toBe(true);
    expect(q.listByStatus('pending')).toHaveLength(2);
  });

  it('has видит вакансию в любом статусе, включая skipped', () => {
    const v = mkVacancy('7');
    q.insertPending(v, 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    q.skip(row.id);
    expect(q.has(v)).toBe(true);
  });
});

describe('Queue переходы статусов', () => {
  it('approve сохраняет отредактированное письмо', () => {
    q.insertPending(mkVacancy('2'), 50, [], 'исходное', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    q.approve(row.id, 'отредактированное');
    const approved = q.listByStatus('approved')[0]!;
    expect(approved.letter).toBe('отредактированное');
  });

  it('markFailed пишет причину', () => {
    q.insertPending(mkVacancy('3'), 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    q.approve(row.id);
    q.markFailed(row.id, 'кнопка не найдена');
    expect(q.listByStatus('failed')[0]!.error).toBe('кнопка не найдена');
  });
});

describe('Queue восстановление после обрыва', () => {
  it('approved без sent_at остаются в работе и считаются recoverStuck', () => {
    q.insertPending(mkVacancy('4'), 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    q.approve(row.id);
    expect(q.recoverStuck()).toBe(1);
    expect(q.listByStatus('approved')).toHaveLength(1);
  });

  it('отправленные recoverStuck не трогает', () => {
    q.insertPending(mkVacancy('5'), 50, [], 'l', 'hybrid');
    const row = q.listByStatus('pending')[0]!;
    q.approve(row.id);
    q.markSent(row.id);
    expect(q.recoverStuck()).toBe(0);
    expect(q.listByStatus('sent')).toHaveLength(1);
  });
});

describe('Queue счётчики для троттлинга', () => {
  it('countSentSince считает только отправленные по этой площадке', () => {
    for (const id of ['10', '11']) {
      q.insertPending(mkVacancy(id, 'hh'), 50, [], 'l', 'hybrid');
    }
    q.insertPending(mkVacancy('12', 'hrge'), 50, [], 'l', 'hybrid');
    for (const row of q.listByStatus('pending')) {
      q.approve(row.id);
      q.markSent(row.id);
    }
    expect(q.countSentSince('hh', Date.now() - 3600_000)).toBe(2);
    expect(q.countSentSince('hrge', Date.now() - 3600_000)).toBe(1);
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npm test -- tests/queue.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать**

Создать `src/core/queue.ts`:

```typescript
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Vacancy } from './vacancy.js';

export type Status = 'pending' | 'approved' | 'skipped' | 'sent' | 'failed';
export type LetterMode = 'hybrid' | 'full' | 'none';

export interface QueueRow {
  id: number;
  source: string;
  sourceId: string;
  vacancy: Vacancy;
  score: number;
  matched: string[];
  letter: string;
  letterMode: LetterMode;
  status: Status;
  error: string | null;
}

interface DbRow {
  id: number; source: string; source_id: string; vacancy_json: string;
  score: number; matched_json: string; letter: string; letter_mode: string;
  status: string; error: string | null;
}

export class Queue {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS applications (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        source       TEXT NOT NULL,
        source_id    TEXT NOT NULL,
        vacancy_json TEXT NOT NULL,
        score        INTEGER NOT NULL,
        matched_json TEXT NOT NULL,
        letter       TEXT NOT NULL,
        letter_mode  TEXT NOT NULL,
        status       TEXT NOT NULL,
        error        TEXT,
        created_at   INTEGER NOT NULL,
        decided_at   INTEGER,
        sent_at      INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dedupe
        ON applications(source, source_id);
      CREATE INDEX IF NOT EXISTS idx_status ON applications(status);
      CREATE INDEX IF NOT EXISTS idx_sent ON applications(source, sent_at);
    `);
  }

  insertPending(
    v: Vacancy, score: number, matched: string[], letter: string, letterMode: LetterMode,
  ): boolean {
    if (this.has(v)) return false;
    this.db.prepare(`
      INSERT INTO applications
        (source, source_id, vacancy_json, score, matched_json, letter, letter_mode, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      v.source, v.sourceId, JSON.stringify(v), score,
      JSON.stringify(matched), letter, letterMode, Date.now(),
    );
    return true;
  }

  has(v: Vacancy): boolean {
    const row = this.db
      .prepare('SELECT 1 AS found FROM applications WHERE source = ? AND source_id = ?')
      .get(v.source, v.sourceId);
    return row !== undefined;
  }

  listByStatus(status: Status): QueueRow[] {
    const rows = this.db
      .prepare('SELECT * FROM applications WHERE status = ? ORDER BY score DESC, id ASC')
      .all(status) as unknown as DbRow[];
    return rows.map(this.toQueueRow);
  }

  approve(id: number, letter?: string): void {
    if (letter === undefined) {
      this.db.prepare("UPDATE applications SET status='approved', decided_at=? WHERE id=?")
        .run(Date.now(), id);
    } else {
      this.db.prepare("UPDATE applications SET status='approved', letter=?, decided_at=? WHERE id=?")
        .run(letter, Date.now(), id);
    }
  }

  skip(id: number): void {
    this.db.prepare("UPDATE applications SET status='skipped', decided_at=? WHERE id=?")
      .run(Date.now(), id);
  }

  markSent(id: number): void {
    this.db.prepare("UPDATE applications SET status='sent', sent_at=? WHERE id=?")
      .run(Date.now(), id);
  }

  markFailed(id: number, reason: string): void {
    this.db.prepare("UPDATE applications SET status='failed', error=? WHERE id=?")
      .run(reason, id);
  }

  /**
   * Процесс мог умереть между approve и markSent. Такие записи остаются
   * approved без sent_at и должны быть обработаны заново. Дубль невозможен:
   * уникальный индекс не даст вставить вакансию второй раз, а сама отправка
   * идёт по конкретной строке.
   */
  recoverStuck(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM applications WHERE status='approved' AND sent_at IS NULL",
    ).get() as unknown as { n: number };
    return row.n;
  }

  countSentSince(source: string, sinceMs: number): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM applications WHERE source=? AND status='sent' AND sent_at >= ?",
    ).get(source, sinceMs) as unknown as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }

  private toQueueRow = (r: DbRow): QueueRow => ({
    id: r.id,
    source: r.source,
    sourceId: r.source_id,
    vacancy: JSON.parse(r.vacancy_json) as Vacancy,
    score: r.score,
    matched: JSON.parse(r.matched_json) as string[],
    letter: r.letter,
    letterMode: r.letter_mode as LetterMode,
    status: r.status as Status,
    error: r.error,
  });
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test -- tests/queue.test.ts`
Expected: PASS, 8 тестов

- [ ] **Step 5: Проверить типы**

Run: `npm run typecheck`
Expected: без ошибок. Если `node:sqlite` ругается на типы, добавь в `tsconfig.json` `"lib": ["ES2023"]` — модуль экспериментальный и типы приходят из `@types/node` 24.

- [ ] **Step 6: Коммит**

```bash
git add src/core/queue.ts tests/queue.test.ts
git commit -m "feat: SQLite queue with hard dedupe and crash recovery

Unique index on (source, source_id) is the single guarantee that no
vacancy is ever applied to twice.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Генерация писем

**Files:**
- Create: `src/core/letter.ts`
- Create: `templates/fullstack-analyst.md`, `templates/ai-llm-ba.md`, `templates/product-ba.md`, `templates/english-generic.md`
- Test: `tests/letter.test.ts`

**Interfaces:**
- Consumes: `Vacancy` (Task 1), `Config` (Task 2), `ScoreResult` (Task 4)
- Produces: `buildPrompt(input: LetterInput): PromptParts`, `pickTemplate(v: Vacancy, matched: string[]): TemplateName`, `pickMode(score, threshold): LetterMode`, `generateLetter(input, client): Promise<{ letter: string; mode: LetterMode }>`. Типы `LetterInput`, `PromptParts`, `TemplateName`

LLM в тестах мокается. Проверяется сборка промпта, а не ответ модели.

**Критично для стоимости:** резюме и инструкция стабильны между вызовами и идут **в начало** промпта под `cache_control`. Текст вакансии волатилен и идёт **после** последнего брейкпоинта. Порядок наоборот убивает кэш полностью.

- [ ] **Step 1: Создать скелеты писем**

Четыре файла в `templates/`. Это черновики — пользователь их перепишет и утвердит; система от их содержимого не зависит, только от наличия.

`templates/fullstack-analyst.md`:

```markdown
Здравствуйте!

Откликаюсь на вакансию {{TITLE}} в {{COMPANY}}.

{{HOOK}}

Из релевантного: собирал требования и писал BRD/FSD, описывал процессы в BPMN,
работал с SQL и интеграциями REST/Kafka, вёл AS-IS/TO-BE gap-анализ.

{{FIT}}

Готов обсудить детали. Резюме прикреплено.

кандидат
```

`templates/ai-llm-ba.md`:

```markdown
Здравствуйте!

Откликаюсь на вакансию {{TITLE}} в {{COMPANY}}.

{{HOOK}}

Мой профиль — бизнес-анализ на стыке с LLM-продуктами: ставил задачи по
генеративным пайплайнам, проектировал многошаговые агентные сценарии,
считал стоимость генерации и выстраивал приёмку качества.

{{FIT}}

Готов обсудить детали. Резюме прикреплено.

кандидат
```

`templates/product-ba.md`:

```markdown
Здравствуйте!

Откликаюсь на вакансию {{TITLE}} в {{COMPANY}}.

{{HOOK}}

Из продуктового: CJM, юнит-экономика, метрики и приоритизация,
A/B-гипотезы, работа с данными через SQL и BI.

{{FIT}}

Готов обсудить детали. Резюме прикреплено.

кандидат
```

`templates/english-generic.md`:

```markdown
Hello,

I'm applying for the {{TITLE}} role at {{COMPANY}}.

{{HOOK}}

Relevant background: requirements gathering and BRD/FSD authoring, BPMN
process modelling, SQL and data analysis, REST/Kafka integrations, and
hands-on work with LLM-based product pipelines.

{{FIT}}

Happy to discuss further. CV attached.

Artem Lukyanenko
```

- [ ] **Step 2: Написать падающий тест**

Создать `tests/letter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildPrompt, pickTemplate, pickMode, generateLetter } from '../src/core/letter.js';
import { normalizeVacancy } from '../src/core/vacancy.js';

function mk(over: Partial<Parameters<typeof normalizeVacancy>[0]> = {}) {
  return normalizeVacancy({
    source: 'hh', sourceId: '1', title: 'Бизнес-аналитик', company: 'Сбер',
    url: 'u', description: 'Описание вакансии', geo: 'Москва',
    postedAt: '2026-08-20T00:00:00Z', ...over,
  });
}

const RESUME = 'РЕЗЮМЕ АРТЁМА';

describe('pickMode', () => {
  it('скор ниже порога — hybrid', () => expect(pickMode(60, 75)).toBe('hybrid'));
  it('скор на пороге — full', () => expect(pickMode(75, 75)).toBe('full'));
  it('скор выше порога — full', () => expect(pickMode(90, 75)).toBe('full'));
});

describe('pickTemplate', () => {
  it('площадка hrge даёт английский скелет', () => {
    expect(pickTemplate(mk({ source: 'hrge' }), ['sql'])).toBe('english-generic');
  });
  it('совпадение ai-llm даёт ai-llm-ba', () => {
    expect(pickTemplate(mk(), ['ai-llm', 'sql'])).toBe('ai-llm-ba');
  });
  it('продуктовые ключевики дают product-ba', () => {
    expect(pickTemplate(mk(), ['product'])).toBe('product-ba');
  });
  it('иначе fullstack-analyst', () => {
    expect(pickTemplate(mk(), ['sql', 'bpmn'])).toBe('fullstack-analyst');
  });
});

describe('buildPrompt — порядок для кэша', () => {
  it('стабильный блок идёт первым и помечен cache_control', () => {
    const p = buildPrompt({
      vacancy: mk(), matched: ['sql'], mode: 'hybrid', resume: RESUME, template: 'x',
    });
    expect(p.system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(p.system[0]!.text).toContain(RESUME);
  });

  it('текст вакансии идёт в messages, а не в system — он волатилен', () => {
    const p = buildPrompt({
      vacancy: mk({ description: 'УНИКАЛЬНЫЙ ТЕКСТ' }), matched: ['sql'],
      mode: 'hybrid', resume: RESUME, template: 'x',
    });
    expect(JSON.stringify(p.system)).not.toContain('УНИКАЛЬНЫЙ ТЕКСТ');
    expect(JSON.stringify(p.messages)).toContain('УНИКАЛЬНЫЙ ТЕКСТ');
  });

  it('режим full не подмешивает скелет', () => {
    const p = buildPrompt({
      vacancy: mk(), matched: [], mode: 'full', resume: RESUME, template: 'СКЕЛЕТ',
    });
    expect(JSON.stringify(p)).not.toContain('СКЕЛЕТ');
  });
});

describe('generateLetter', () => {
  it('возвращает текст модели и выбранный режим', async () => {
    const fake = {
      messages: {
        create: async () => ({ content: [{ type: 'text', text: 'ГОТОВОЕ ПИСЬМО' }] }),
      },
    };
    const r = await generateLetter(
      { vacancy: mk(), matched: [], mode: 'hybrid', resume: RESUME, template: 't' },
      fake as never,
    );
    expect(r.letter).toBe('ГОТОВОЕ ПИСЬМО');
    expect(r.mode).toBe('hybrid');
  });

  it('на ошибке модели возвращает пустое письмо и режим none — человек напишет руками', async () => {
    const fake = {
      messages: { create: async () => { throw new Error('rate limit'); } },
    };
    const r = await generateLetter(
      { vacancy: mk(), matched: [], mode: 'hybrid', resume: RESUME, template: 't' },
      fake as never,
    );
    expect(r.letter).toBe('');
    expect(r.mode).toBe('none');
  });
});
```

- [ ] **Step 3: Запустить, убедиться что падает**

Run: `npm test -- tests/letter.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 4: Реализовать**

Создать `src/core/letter.ts`:

```typescript
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
    const res = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 2000,
      thinking: { type: 'adaptive' },
      system: prompt.system,
      messages: prompt.messages,
    } as never);

    const block = (res as { content: Array<{ type: string; text?: string }> })
      .content.find((b) => b.type === 'text');
    return { letter: block?.text ?? '', mode: input.mode };
  } catch {
    // Письмо не сгенерировалось — запись всё равно попадёт в очередь,
    // человек увидит её пустой и напишет письмо руками.
    return { letter: '', mode: 'none' };
  }
}
```

- [ ] **Step 5: Запустить тесты**

Run: `npm test -- tests/letter.test.ts`
Expected: PASS, 12 тестов

- [ ] **Step 6: Коммит**

```bash
git add src/core/letter.ts templates/ tests/letter.test.ts
git commit -m "feat: two-tier letter generation with cache-stable prompt ordering

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Снять настоящий контракт API hr.ge

**Files:**
- Create: `tests/fixtures/hrge-search-request.json`, `tests/fixtures/hrge-search-response.json`
- Create: `docs/hrge-api.md`

**Interfaces:**
- Consumes: ничего
- Produces: зафиксированный формат запроса и ответа `announcement-search` — на них опирается Task 8

Известно точно (разведка 2026-08-27): эндпоинт `POST https://api.p.hr.ge/public-portal/tenant/1/api/v3/announcement-search`, соседние маршруты `announcement/{id}`, `apply`, `search-field`, `announcement-view`. Модель фильтра из бандла:

```
localityIds[], categoryIds[], specializationCodes[], industryCodes[],
workScheduleCodes[], announcementTypeId, publishDateRangeOptionId,
seniorityLevelCodes, employmentFormTypeIds[], transportTypeIds[],
drivingLicenceIds[], worldLanguageIds[], educationLevelCodes[],
experienceRangeOptionIds[], experienceRange{from,to},
withoutWorkExperience, anyExperience, employmentFormIds[],
isWorkFromHome, query, salaryRangeOptionId, onlySelectedSalary, currentPage
```

Неизвестна обёртка запроса: все пробы через `curl` дают `500 "Attempted to divide by zero"`. Значит сервер ждёт поле, которого в фильтре нет (вероятно размер страницы) или заголовок. Угадывать дальше бессмысленно — снимаем настоящий запрос.

- [ ] **Step 1: Открыть страницу поиска в браузерной панели**

Открыть `https://www.hr.ge/search-posting` через браузерную панель (`preview_start` с этим URL).

- [ ] **Step 2: Поставить хук на fetch до того, как приложение сделает запрос**

Выполнить в консоли страницы:

```javascript
window.__captured = [];
const origFetch = window.fetch;
window.fetch = async function (...args) {
  const [input, init] = args;
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('announcement-search')) {
    window.__captured.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? null,
      body: init?.body ?? null,
    });
  }
  return origFetch.apply(this, args);
};
'hook installed';
```

- [ ] **Step 3: Спровоцировать поиск**

Ввести `analyst` в поле поиска на странице и нажать кнопку поиска. Если приложение вместо `fetch` использует `XMLHttpRequest`, хук выше ничего не поймает — тогда поставить второй хук:

```javascript
const origOpen = XMLHttpRequest.prototype.open;
const origSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function (m, u, ...rest) {
  this.__m = m; this.__u = u; return origOpen.call(this, m, u, ...rest);
};
XMLHttpRequest.prototype.send = function (body) {
  if (String(this.__u).includes('announcement-search')) {
    window.__captured.push({ url: this.__u, method: this.__m, body });
  }
  return origSend.call(this, body);
};
'xhr hook installed';
```

и повторить поиск.

- [ ] **Step 4: Забрать пойманный запрос**

```javascript
JSON.stringify(window.__captured, null, 2);
```

- [ ] **Step 5: Воспроизвести запрос через curl и убедиться, что он отвечает 200**

Подставить пойманные тело и заголовки:

```bash
curl -s -m 20 -w "\n[HTTP %{http_code}]\n" -X POST \
  -H "Content-Type: application/json" \
  "https://api.p.hr.ge/public-portal/tenant/1/api/v3/announcement-search" \
  -d '<ПОЙМАННОЕ_ТЕЛО>'
```

Expected: `HTTP 200` и JSON со списком вакансий.

Если 200 получается только с дополнительным заголовком — зафиксировать этот заголовок в `docs/hrge-api.md`. Если запрос проходит только из браузера (AWS WAF на пути), это меняет решение: адаптер `hrge` тоже становится браузерным, и Task 8 переписывается на Playwright. **Это допустимый исход разведки — записать его явно, а не обходить.**

- [ ] **Step 6: Сохранить фикстуры**

Записать пойманное тело в `tests/fixtures/hrge-search-request.json`, полученный ответ — в `tests/fixtures/hrge-search-response.json`. Ответ обрезать до двух вакансий, чтобы фикстура читалась.

- [ ] **Step 7: Задокументировать**

Создать `docs/hrge-api.md`: базовый URL, точный формат запроса, обязательные заголовки, структура ответа с путями до `id`, `title`, `company`, `description`, `city`, `publishDate`, ссылка на страницу вакансии, и — отдельным разделом — что выяснилось про WAF и reCAPTCHA (`recaptchaSiteKey` присутствует в `public/configs`).

- [ ] **Step 8: Коммит**

```bash
git add docs/hrge-api.md tests/fixtures/hrge-search-request.json tests/fixtures/hrge-search-response.json
git commit -m "docs: capture real hr.ge announcement-search API contract

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Адаптер hr.ge

**Files:**
- Create: `src/adapters/hrge.ts`
- Test: `tests/hrge.test.ts`

**Interfaces:**
- Consumes: `Adapter`, `SearchFilters`, `ApplyResult` (Task 3); `normalizeVacancy` (Task 1); фикстуры из Task 7
- Produces: класс `HrGeAdapter implements Adapter`; функция `parseSearchResponse(json: unknown): Vacancy[]`

Точные имена полей ответа берутся из `tests/fixtures/hrge-search-response.json`, снятого в Task 7. Ниже они обозначены как `<ПОЛЕ_ИЗ_ФИКСТУРЫ>` — подставь реальные при реализации.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/hrge.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSearchResponse, HrGeAdapter } from '../src/adapters/hrge.js';

const fixture = JSON.parse(
  readFileSync('tests/fixtures/hrge-search-response.json', 'utf8'),
);

describe('parseSearchResponse', () => {
  it('превращает ответ API в массив Vacancy', () => {
    const vs = parseSearchResponse(fixture);
    expect(vs.length).toBeGreaterThan(0);
    const v = vs[0]!;
    expect(v.source).toBe('hrge');
    expect(v.sourceId).not.toBe('');
    expect(v.url).toContain('hr.ge');
    expect(v.postedAt).toBeInstanceOf(Date);
  });

  it('на пустом списке возвращает пустой массив, а не бросает', () => {
    expect(parseSearchResponse({ data: { announcements: [] } })).toEqual([]);
  });

  it('на мусорном входе возвращает пустой массив', () => {
    expect(parseSearchResponse(null)).toEqual([]);
    expect(parseSearchResponse({ nope: 1 })).toEqual([]);
  });
});

describe('HrGeAdapter.apply', () => {
  it('распознаёт требование капчи как captcha, а не как failed', async () => {
    const a = new HrGeAdapter({
      fetchImpl: async () => new Response(
        JSON.stringify({ error: { errorCode: 'RECAPTCHA_REQUIRED' } }),
        { status: 400 },
      ),
    });
    const r = await a.apply({ sourceId: '1' } as never, 'письмо');
    expect(r.status).toBe('captcha');
  });

  it('401 означает auth_required, очередь должна встать', async () => {
    const a = new HrGeAdapter({
      fetchImpl: async () => new Response('{}', { status: 401 }),
    });
    const r = await a.apply({ sourceId: '1' } as never, 'письмо');
    expect(r.status).toBe('auth_required');
  });

  it('успешный ответ даёт sent', async () => {
    const a = new HrGeAdapter({
      fetchImpl: async () => new Response('{"data":{"success":true}}', { status: 200 }),
    });
    const r = await a.apply({ sourceId: '1' } as never, 'письмо');
    expect(r.status).toBe('sent');
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npm test -- tests/hrge.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать**

Создать `src/adapters/hrge.ts`. Пути до полей (`<ПОЛЕ_ИЗ_ФИКСТУРЫ>`) подставить из фикстуры Task 7:

```typescript
import { normalizeVacancy, type Vacancy } from '../core/vacancy.js';
import type { Adapter, ApplyResult, SearchFilters } from './types.js';

const BASE = 'https://api.p.hr.ge/public-portal/tenant/1/api/v3';

/** Каркас фильтра из бандла hr.ge. Поля не выдуманы — сняты из main-*.js. */
const BASE_FILTER = {
  localityIds: [], categoryIds: [], specializationCodes: [], industryCodes: [],
  workScheduleCodes: [], announcementTypeId: null, publishDateRangeOptionId: 0,
  seniorityLevelCodes: null, employmentFormTypeIds: [], transportTypeIds: [],
  drivingLicenceIds: [], worldLanguageIds: [], educationLevelCodes: [],
  experienceRangeOptionIds: [], experienceRange: { from: null, to: null },
  withoutWorkExperience: false, anyExperience: false, employmentFormIds: [],
  isWorkFromHome: false, query: '', salaryRangeOptionId: 0,
  onlySelectedSalary: false, currentPage: 1,
};

export function parseSearchResponse(json: unknown): Vacancy[] {
  const items = (json as { data?: { announcements?: unknown[] } })?.data?.announcements;
  if (!Array.isArray(items)) return [];

  const out: Vacancy[] = [];
  for (const raw of items) {
    const a = raw as Record<string, unknown>;
    const id = String(a['<ПОЛЕ_ИЗ_ФИКСТУРЫ:id>'] ?? '');
    if (id === '') continue;
    out.push(normalizeVacancy({
      source: 'hrge',
      sourceId: id,
      title: String(a['<ПОЛЕ_ИЗ_ФИКСТУРЫ:title>'] ?? ''),
      company: String(a['<ПОЛЕ_ИЗ_ФИКСТУРЫ:company>'] ?? ''),
      url: `https://www.hr.ge/announcement/${id}`,
      description: String(a['<ПОЛЕ_ИЗ_ФИКСТУРЫ:description>'] ?? ''),
      geo: String(a['<ПОЛЕ_ИЗ_ФИКСТУРЫ:city>'] ?? 'Georgia'),
      postedAt: String(a['<ПОЛЕ_ИЗ_ФИКСТУРЫ:publishDate>'] ?? new Date().toISOString()),
      isRemote: Boolean(a['<ПОЛЕ_ИЗ_ФИКСТУРЫ:isWorkFromHome>'] ?? false),
    }));
  }
  return out;
}

export class HrGeAdapter implements Adapter {
  readonly name = 'hrge';
  private fetchImpl: typeof fetch;

  constructor(opts: { fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(filters: SearchFilters): Promise<Vacancy[]> {
    const body = {
      ...BASE_FILTER,
      query: filters.query,
      isWorkFromHome: filters.remoteOnly ?? false,
      currentPage: 1,
    };
    const res = await this.fetchImpl(`${BASE}/announcement-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    return parseSearchResponse(await res.json());
  }

  async apply(vacancy: Vacancy, letter: string): Promise<ApplyResult> {
    const res = await this.fetchImpl(`${BASE}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ announcementId: vacancy.sourceId, coverLetter: letter }),
    });

    if (res.status === 401 || res.status === 403) return { status: 'auth_required' };

    const text = await res.text();
    if (/recaptcha|captcha/i.test(text)) return { status: 'captcha' };
    if (/already.?applied|already.?exists/i.test(text)) return { status: 'already_applied' };
    if (res.ok) return { status: 'sent' };
    return { status: 'failed', reason: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
}
```

Порядок проверок в `apply` важен: капча проверяется **до** `res.ok`, потому что сервер может вернуть требование капчи со статусом 200.

- [ ] **Step 4: Запустить тесты**

Run: `npm test -- tests/hrge.test.ts`
Expected: PASS, 6 тестов

- [ ] **Step 5: Коммит**

```bash
git add src/adapters/hrge.ts tests/hrge.test.ts
git commit -m "feat: hr.ge HTTP adapter with captcha and auth detection

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Профиль браузера и снятие фикстур hh.ru

**Files:**
- Create: `src/browser.ts`
- Create: `tests/fixtures/hh-search.html`, `tests/fixtures/hh-vacancy.html`
- Create: `docs/hh-selectors.md`

**Interfaces:**
- Consumes: ничего
- Produces: `openProfile(): Promise<BrowserContext>` — persistent context на профиле пользователя; зафиксированные HTML-фикстуры и карта селекторов для Task 10

Это единственное место, где решается вопрос аутентификации, и решается он тем, что паролей здесь нет.

- [ ] **Step 1: Реализовать открытие профиля**

Создать `src/browser.ts`:

```typescript
import { chromium, type BrowserContext } from 'playwright';
import { resolve } from 'node:path';

const PROFILE_DIR = resolve('browser-profile');

/**
 * Persistent context на выделенном профиле. Пользователь логинится в него
 * руками один раз; куки живут в каталоге профиля. Паролей в коде нет и не будет.
 * Каталог профиля в .gitignore.
 */
export async function openProfile(headless = false): Promise<BrowserContext> {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1440, height: 900 },
    locale: 'ru-RU',
  });
}
```

- [ ] **Step 2: Установить браузер Playwright**

Run: `npx playwright install chromium`
Expected: chromium скачан

- [ ] **Step 3: Залогиниться в hh.ru руками**

Написать одноразовый скрипт `scripts/login.ts`:

```typescript
import { openProfile } from '../src/browser.js';

const ctx = await openProfile(false);
const page = await ctx.newPage();
await page.goto('https://hh.ru/account/login');
console.log('Залогинься вручную. Когда закончишь — нажми Enter в терминале.');
process.stdin.once('data', async () => { await ctx.close(); process.exit(0); });
```

Run: `npx tsx scripts/login.ts`

Пользователь логинится сам, в том числе решает капчу, если она появится. Скрипт паролей не касается.

- [ ] **Step 4: Снять фикстуры**

Написать одноразовый скрипт `scripts/capture-hh.ts`:

```typescript
import { writeFileSync } from 'node:fs';
import { openProfile } from '../src/browser.js';

const ctx = await openProfile(false);
const page = await ctx.newPage();

await page.goto('https://hh.ru/search/vacancy?text=%D0%B1%D0%B8%D0%B7%D0%BD%D0%B5%D1%81-%D0%B0%D0%BD%D0%B0%D0%BB%D0%B8%D1%82%D0%B8%D0%BA&area=1');
await page.waitForLoadState('networkidle');
writeFileSync('tests/fixtures/hh-search.html', await page.content(), 'utf8');

const firstLink = await page.locator('a[data-qa="serp-item__title"]').first().getAttribute('href');
if (firstLink) {
  await page.goto(firstLink);
  await page.waitForLoadState('networkidle');
  writeFileSync('tests/fixtures/hh-vacancy.html', await page.content(), 'utf8');
}

await ctx.close();
```

Run: `npx tsx scripts/capture-hh.ts`
Expected: два HTML-файла в `tests/fixtures/`

- [ ] **Step 5: Записать карту селекторов**

Открыть снятые фикстуры и выписать в `docs/hh-selectors.md` реальные значения для: карточка вакансии в выдаче, ссылка на вакансию, заголовок, компания, зарплата, регион, дата, полное описание на странице вакансии, кнопка «Откликнуться», поле сопроводительного письма, кнопка отправки, признак «вы уже откликались», признак капчи.

`data-qa`-атрибуты у hh стабильнее классов — предпочитать их.

- [ ] **Step 6: Коммит**

```bash
git add src/browser.ts scripts/ docs/hh-selectors.md tests/fixtures/hh-search.html tests/fixtures/hh-vacancy.html
git commit -m "feat: persistent browser profile and captured hh.ru fixtures

Auth is the user's own manual login into a persistent profile.
No passwords in code, config, or environment.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Адаптер hh.ru

**Files:**
- Create: `src/adapters/hh.ts`
- Test: `tests/hh.test.ts`

**Interfaces:**
- Consumes: `Adapter` (Task 3), `normalizeVacancy` (Task 1), `openProfile` (Task 9), фикстуры и селекторы из Task 9
- Produces: класс `HhAdapter implements Adapter`; функция `parseSearchPage(page: Page): Promise<Vacancy[]>`; функция `classifyApplyOutcome(s: ApplySignals): ApplyResult`

**Парсинг идёт через DOM Playwright, не через регулярки.** Playwright уже в зависимостях, а разбор HTML регулярками ломается на любой смене вёрстки и не переживает вложенные теги. `parseSearchPage` принимает `Page`, поэтому тестируется офлайн: фикстура загружается в страницу через `page.setContent(html)`, браузер при этом реальный, но сети нет.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/hh.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { parseSearchPage, classifyApplyOutcome } from '../src/adapters/hh.js';

const html = readFileSync('tests/fixtures/hh-search.html', 'utf8');

let browser: Browser;
let page: Page;

beforeAll(async () => {
  // Реальный браузер, но без сети: фикстура грузится через setContent.
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});
afterAll(async () => { await browser.close(); });

describe('parseSearchPage', () => {
  it('вытаскивает вакансии из реальной выдачи', async () => {
    await page.setContent(html);
    const vs = await parseSearchPage(page);
    expect(vs.length).toBeGreaterThan(0);
    const v = vs[0]!;
    expect(v.source).toBe('hh');
    expect(v.sourceId).toMatch(/^\d+$/);
    expect(v.url).toContain('hh.ru/vacancy/');
    expect(v.title).not.toBe('');
    expect(v.company).not.toBe('');
  });

  it('на пустой странице возвращает пустой массив', async () => {
    await page.setContent('<html><body></body></html>');
    expect(await parseSearchPage(page)).toEqual([]);
  });

  it('sourceId уникален внутри одной выдачи', async () => {
    await page.setContent(html);
    const ids = (await parseSearchPage(page)).map((v) => v.sourceId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('classifyApplyOutcome', () => {
  it('видимая капча важнее всего остального', () => {
    expect(classifyApplyOutcome({ captchaVisible: true, alreadyApplied: true, submitted: true }))
      .toEqual({ status: 'captcha' });
  });
  it('незалогиненность даёт auth_required', () => {
    expect(classifyApplyOutcome({ loggedOut: true }))
      .toEqual({ status: 'auth_required' });
  });
  it('уже откликались — already_applied', () => {
    expect(classifyApplyOutcome({ alreadyApplied: true }))
      .toEqual({ status: 'already_applied' });
  });
  it('успешная отправка — sent', () => {
    expect(classifyApplyOutcome({ submitted: true })).toEqual({ status: 'sent' });
  });
  it('ничего не произошло — failed с причиной', () => {
    const r = classifyApplyOutcome({});
    expect(r.status).toBe('failed');
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npm test -- tests/hh.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать**

Создать `src/adapters/hh.ts`. Селекторы взять из `docs/hh-selectors.md` (Task 9) — ниже помечены как `<СЕЛЕКТОР:...>`:

```typescript
import type { Page, Locator } from 'playwright';
import { normalizeVacancy, type Vacancy } from '../core/vacancy.js';
import { openProfile } from '../browser.js';
import type { Adapter, ApplyResult, SearchFilters } from './types.js';

export interface ApplySignals {
  captchaVisible?: boolean;
  loggedOut?: boolean;
  alreadyApplied?: boolean;
  submitted?: boolean;
}

/**
 * Приоритет проверок задан намеренно: капча важнее всего, потому что она
 * останавливает очередь целиком. Затем потеря сессии. Только потом обычные
 * исходы одной подачи.
 */
export function classifyApplyOutcome(s: ApplySignals): ApplyResult {
  if (s.captchaVisible) return { status: 'captcha' };
  if (s.loggedOut) return { status: 'auth_required' };
  if (s.alreadyApplied) return { status: 'already_applied' };
  if (s.submitted) return { status: 'sent' };
  return { status: 'failed', reason: 'форма отклика не подтвердила отправку' };
}

/**
 * Разбор выдачи через DOM Playwright. Селекторы — из docs/hh-selectors.md.
 * Функция принимает Page, а не строку, поэтому в тестах фикстура грузится
 * через page.setContent и сеть не нужна.
 */
export async function parseSearchPage(page: Page): Promise<Vacancy[]> {
  const cards = await page.locator('<СЕЛЕКТОР:card>').all();
  const out: Vacancy[] = [];
  const seen = new Set<string>();

  for (const card of cards) {
    const href = await card.locator('<СЕЛЕКТОР:title-link>').first()
      .getAttribute('href').catch(() => null);
    const id = href === null ? undefined : /\/vacancy\/(\d+)/.exec(href)?.[1];
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);

    out.push(normalizeVacancy({
      source: 'hh',
      sourceId: id,
      title: await innerTextOr(card, '<СЕЛЕКТОР:title-link>', ''),
      company: await innerTextOr(card, '<СЕЛЕКТОР:company>', ''),
      url: `https://hh.ru/vacancy/${id}`,
      description: '', // полное описание дочитывается на странице вакансии
      geo: await innerTextOr(card, '<СЕЛЕКТОР:region>', 'не указан'),
      postedAt: new Date(),
    }));
  }
  return out;
}

async function innerTextOr(
  scope: Locator, selector: string, fallback: string,
): Promise<string> {
  const text = await scope.locator(selector).first().innerText().catch(() => '');
  const trimmed = text.trim();
  return trimmed === '' ? fallback : trimmed;
}

export class HhAdapter implements Adapter {
  readonly name = 'hh';

  async search(filters: SearchFilters): Promise<Vacancy[]> {
    const ctx = await openProfile(false);
    try {
      const page = await ctx.newPage();
      const url = `https://hh.ru/search/vacancy?text=${encodeURIComponent(filters.query)}&area=1`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const vacancies = await parseSearchPage(page);

      // Дочитываем полное описание — без него скоринг слепой.
      const limit = filters.maxResults ?? vacancies.length;
      for (const v of vacancies.slice(0, limit)) {
        await page.goto(v.url, { waitUntil: 'domcontentloaded' });
        v.description = (await page.locator('<СЕЛЕКТОР:description>').innerText()).trim();
      }
      return vacancies.slice(0, limit);
    } finally {
      await ctx.close();
    }
  }

  async apply(vacancy: Vacancy, letter: string): Promise<ApplyResult> {
    const ctx = await openProfile(false);
    try {
      const page = await ctx.newPage();
      await page.goto(vacancy.url, { waitUntil: 'domcontentloaded' });

      const signals: ApplySignals = {
        captchaVisible: await page.locator('<СЕЛЕКТОР:captcha>').isVisible().catch(() => false),
        loggedOut: await page.locator('<СЕЛЕКТОР:login-link>').isVisible().catch(() => false),
        alreadyApplied: await page.locator('<СЕЛЕКТОР:already-applied>').isVisible().catch(() => false),
      };
      if (signals.captchaVisible || signals.loggedOut || signals.alreadyApplied) {
        return classifyApplyOutcome(signals);
      }

      await page.locator('<СЕЛЕКТОР:respond-button>').click();
      await page.locator('<СЕЛЕКТОР:letter-textarea>').fill(letter);
      await page.locator('<СЕЛЕКТОР:submit-button>').click();

      // Капча умеет появляться уже после нажатия отправки.
      const captchaAfter = await page.locator('<СЕЛЕКТОР:captcha>')
        .isVisible({ timeout: 5000 }).catch(() => false);
      if (captchaAfter) return { status: 'captcha' };

      const ok = await page.locator('<СЕЛЕКТОР:success-marker>')
        .isVisible({ timeout: 10000 }).catch(() => false);
      return classifyApplyOutcome({ submitted: ok });
    } catch (e) {
      return { status: 'failed', reason: e instanceof Error ? e.message : String(e) };
    } finally {
      await ctx.close();
    }
  }
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test -- tests/hh.test.ts`
Expected: PASS, 8 тестов

- [ ] **Step 5: Проверить, что интерфейс выдержал**

Прочитать `src/adapters/types.ts`. Убедиться, что за Task 8 и Task 10 в него не добавилось ни одного метода и ни одного поля. Если добавилось — остановиться и пересмотреть дизайн до того, как появятся ещё четыре адаптера. Это и есть главная проверка первой итерации.

- [ ] **Step 6: Коммит**

```bash
git add src/adapters/hh.ts tests/hh.test.ts
git commit -m "feat: hh.ru browser adapter with captcha-first outcome classification

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Отправщик с троттлингом и остановкой по капче

**Files:**
- Create: `src/core/sender.ts`
- Test: `tests/sender.test.ts`

**Interfaces:**
- Consumes: `Queue` (Task 5), `Adapter`/`isHaltingResult` (Task 3), `Config`/`ThrottleRule` (Task 2)
- Produces: `class Sender` с `constructor(queue, adapters: Map<string, Adapter>, config, deps?)`, метод `run(): Promise<SendReport>`, тип `SendReport = { sent: number; failed: number; halted: null | { source: string; reason: 'captcha' | 'auth_required' | 'killed' } }`; функции `requestStop(): void`, `clearStop(): void`, `isStopRequested(): boolean`

Kill switch реализован флаг-файлом `data/STOP`, а не сигналом процесса: отправка может идти долго, и человек должен уметь остановить её из другого терминала. `Sender` проверяет флаг перед каждой подачей.

Здесь живут защитные требования спеки. Они проверяются тестами, а не намерением.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/sender.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Sender } from '../src/core/sender.js';
import { Queue } from '../src/core/queue.js';
import { normalizeVacancy } from '../src/core/vacancy.js';
import type { Adapter, ApplyResult } from '../src/adapters/types.js';

const CONFIG = {
  minScore: 40,
  letterFullThreshold: 75,
  throttle: { hh: { maxPerHour: 2, maxPerDay: 10, minDelayMs: 0, maxDelayMs: 0 } },
};

function mkAdapter(results: ApplyResult[]): Adapter {
  let i = 0;
  return {
    name: 'hh',
    async search() { return []; },
    async apply() { return results[Math.min(i++, results.length - 1)]!; },
  };
}

function seed(q: Queue, n: number) {
  for (let i = 0; i < n; i++) {
    const v = normalizeVacancy({
      source: 'hh', sourceId: String(i), title: 'БА', company: 'C',
      url: 'u', description: 'd', geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
    });
    q.insertPending(v, 50, [], 'письмо', 'hybrid');
  }
  for (const row of q.listByStatus('pending')) q.approve(row.id);
}

let q: Queue;
beforeEach(() => {
  q = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-s-')), 'test.db'));
});

describe('Sender троттлинг', () => {
  it('не превышает maxPerHour за один прогон', async () => {
    seed(q, 5);
    const s = new Sender(q, new Map([['hh', mkAdapter([{ status: 'sent' }])]]), CONFIG, {
      sleep: async () => {},
    });
    const rep = await s.run();
    expect(rep.sent).toBe(2);
    expect(q.listByStatus('approved')).toHaveLength(3);
  });

  it('вызывает sleep между отправками', async () => {
    seed(q, 2);
    const delays: number[] = [];
    const s = new Sender(q, new Map([['hh', mkAdapter([{ status: 'sent' }])]]), CONFIG, {
      sleep: async (ms) => { delays.push(ms); },
    });
    await s.run();
    expect(delays.length).toBeGreaterThan(0);
  });
});

describe('Sender остановка', () => {
  it('капча останавливает очередь и возвращает запись в approved', async () => {
    seed(q, 3);
    const s = new Sender(q, new Map([['hh', mkAdapter([{ status: 'captcha' }])]]), CONFIG, {
      sleep: async () => {},
    });
    const rep = await s.run();
    expect(rep.halted).toEqual({ source: 'hh', reason: 'captcha' });
    expect(rep.sent).toBe(0);
    expect(q.listByStatus('approved')).toHaveLength(3);
    expect(q.listByStatus('failed')).toHaveLength(0);
  });

  it('auth_required тоже останавливает', async () => {
    seed(q, 2);
    const s = new Sender(q, new Map([['hh', mkAdapter([{ status: 'auth_required' }])]]), CONFIG, {
      sleep: async () => {},
    });
    const rep = await s.run();
    expect(rep.halted?.reason).toBe('auth_required');
  });

  it('обычный failed очередь не останавливает', async () => {
    seed(q, 2);
    const s = new Sender(q, new Map([['hh', mkAdapter([
      { status: 'failed', reason: 'кнопка не найдена' }, { status: 'sent' },
    ])]]), CONFIG, { sleep: async () => {} });
    const rep = await s.run();
    expect(rep.halted).toBeNull();
    expect(rep.failed).toBe(1);
    expect(rep.sent).toBe(1);
  });

  it('already_applied засчитывается как sent — дедуп догоняет', async () => {
    seed(q, 1);
    const s = new Sender(q, new Map([['hh', mkAdapter([{ status: 'already_applied' }])]]), CONFIG, {
      sleep: async () => {},
    });
    await s.run();
    expect(q.listByStatus('sent')).toHaveLength(1);
  });
});

describe('Sender kill switch', () => {
  it('поднятый флаг останавливает отправку до первой подачи', async () => {
    seed(q, 3);
    let applyCalls = 0;
    const counting: Adapter = {
      name: 'hh',
      async search() { return []; },
      async apply() { applyCalls++; return { status: 'sent' }; },
    };
    const s = new Sender(q, new Map([['hh', counting]]), CONFIG, {
      sleep: async () => {},
      stopRequested: () => true,
    });
    const rep = await s.run();
    expect(applyCalls).toBe(0);
    expect(rep.halted).toEqual({ source: '-', reason: 'killed' });
    expect(q.listByStatus('approved')).toHaveLength(3);
  });

  it('флаг, поднятый в середине, останавливает после текущей подачи', async () => {
    seed(q, 3);
    let calls = 0;
    const s = new Sender(q, new Map([['hh', mkAdapter([{ status: 'sent' }])]]), CONFIG, {
      sleep: async () => {},
      stopRequested: () => calls++ >= 1,
    });
    const rep = await s.run();
    expect(rep.sent).toBe(1);
    expect(rep.halted?.reason).toBe('killed');
    expect(q.listByStatus('approved')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npm test -- tests/sender.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать**

Создать `src/core/sender.ts`:

```typescript
import { existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Queue } from './queue.js';
import type { Config } from './config.js';
import type { Adapter } from '../adapters/types.js';
import { isHaltingResult } from '../adapters/types.js';

const STOP_FLAG = 'data/STOP';

/** Kill switch. Флаг-файл, а не сигнал: остановить надо уметь из другого терминала. */
export function requestStop(): void {
  mkdirSync(dirname(STOP_FLAG), { recursive: true });
  writeFileSync(STOP_FLAG, new Date().toISOString(), 'utf8');
}

export function clearStop(): void {
  rmSync(STOP_FLAG, { force: true });
}

export function isStopRequested(): boolean {
  return existsSync(STOP_FLAG);
}

export interface SendReport {
  sent: number;
  failed: number;
  halted: null | { source: string; reason: 'captcha' | 'auth_required' | 'killed' };
}

interface Deps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  stopRequested?: () => boolean;
}

const HOUR = 3600_000;
const DAY = 86_400_000;

export class Sender {
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private random: () => number;
  private stopRequested: () => boolean;

  constructor(
    private queue: Queue,
    private adapters: Map<string, Adapter>,
    private config: Config,
    deps: Deps = {},
  ) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? Math.random;
    this.stopRequested = deps.stopRequested ?? isStopRequested;
  }

  async run(): Promise<SendReport> {
    const report: SendReport = { sent: 0, failed: 0, halted: null };

    for (const row of this.queue.listByStatus('approved')) {
      // Проверка перед каждой подачей: незавершённое остаётся approved.
      if (this.stopRequested()) {
        report.halted = { source: '-', reason: 'killed' };
        return report;
      }

      const adapter = this.adapters.get(row.source);
      if (adapter === undefined) {
        this.queue.markFailed(row.id, `нет адаптера для площадки ${row.source}`);
        report.failed++;
        continue;
      }

      const rule = this.config.throttle[row.source];
      if (rule !== undefined) {
        const inHour = this.queue.countSentSince(row.source, this.now() - HOUR);
        const inDay = this.queue.countSentSince(row.source, this.now() - DAY);
        // Лимит достигнут — запись остаётся approved и уйдёт в следующий прогон.
        if (inHour >= rule.maxPerHour || inDay >= rule.maxPerDay) continue;
      }

      const result = await adapter.apply(row.vacancy, row.letter);

      if (isHaltingResult(result)) {
        // Запись НЕ помечается failed — она остаётся approved и будет
        // обработана после того, как человек разберётся с капчей или логином.
        report.halted = {
          source: row.source,
          reason: result.status as 'captcha' | 'auth_required',
        };
        return report;
      }

      if (result.status === 'sent' || result.status === 'already_applied') {
        this.queue.markSent(row.id);
        report.sent++;
      } else {
        this.queue.markFailed(row.id, result.reason);
        report.failed++;
      }

      if (rule !== undefined) {
        const span = rule.maxDelayMs - rule.minDelayMs;
        await this.sleep(rule.minDelayMs + Math.floor(this.random() * (span + 1)));
      }
    }

    return report;
  }
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test -- tests/sender.test.ts`
Expected: PASS, 9 тестов

- [ ] **Step 5: Прогнать весь набор**

Run: `npm test`
Expected: все тесты зелёные

- [ ] **Step 6: Коммит**

```bash
git add src/core/sender.ts tests/sender.test.ts
git commit -m "feat: throttled sender that halts the queue on captcha or lost session

A halting result leaves the row in 'approved', never 'failed' - the
application has not been sent and must be retried after a human intervenes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Панель одобрения

**Files:**
- Create: `src/ui/server.ts`, `src/ui/panel.html`
- Test: `tests/ui-server.test.ts`

**Interfaces:**
- Consumes: `Queue` (Task 5)
- Produces: `startPanel(queue: Queue, port: number): Promise<{ close(): Promise<void> }>`; HTTP-эндпоинты `GET /api/pending`, `POST /api/approve`, `POST /api/skip`, `GET /`

Без фреймворков: `node:http` и одна страница. Панель — локальный инструмент на один экран, ей не нужна сборка.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/ui-server.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startPanel } from '../src/ui/server.js';
import { Queue } from '../src/core/queue.js';
import { normalizeVacancy } from '../src/core/vacancy.js';

const PORT = 34567;
let q: Queue;
let panel: { close(): Promise<void> };

beforeEach(async () => {
  q = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-ui-')), 'test.db'));
  q.insertPending(
    normalizeVacancy({
      source: 'hh', sourceId: '1', title: 'БА', company: 'Сбер',
      url: 'https://hh.ru/vacancy/1', description: 'd', geo: 'Москва',
      postedAt: '2026-08-20T00:00:00Z',
    }),
    80, ['sql'], 'исходное письмо', 'full',
  );
  panel = await startPanel(q, PORT);
});
afterEach(async () => { await panel.close(); q.close(); });

describe('панель', () => {
  it('GET /api/pending отдаёт ожидающие записи', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/pending`);
    const rows = await res.json() as Array<{ id: number; score: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.score).toBe(80);
  });

  it('POST /api/approve с изменённым письмом сохраняет правку', async () => {
    const [row] = q.listByStatus('pending');
    await fetch(`http://127.0.0.1:${PORT}/api/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: row!.id, letter: 'моя правка' }),
    });
    expect(q.listByStatus('approved')[0]!.letter).toBe('моя правка');
  });

  it('POST /api/skip убирает запись из pending', async () => {
    const [row] = q.listByStatus('pending');
    await fetch(`http://127.0.0.1:${PORT}/api/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: row!.id }),
    });
    expect(q.listByStatus('pending')).toHaveLength(0);
    expect(q.listByStatus('skipped')).toHaveLength(1);
  });

  it('GET / отдаёт HTML страницы', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/`);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<html');
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npm test -- tests/ui-server.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать сервер**

Создать `src/ui/server.ts`:

```typescript
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Queue } from '../core/queue.js';

const PANEL_HTML = resolve('src/ui/panel.html');

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export async function startPanel(
  queue: Queue, port: number,
): Promise<{ close(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/api/pending') {
        return json(res, queue.listByStatus('pending'));
      }
      if (req.method === 'POST' && req.url === '/api/approve') {
        const b = await readJson(req);
        queue.approve(Number(b['id']), typeof b['letter'] === 'string' ? b['letter'] : undefined);
        return json(res, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/api/skip') {
        const b = await readJson(req);
        queue.skip(Number(b['id']));
        return json(res, { ok: true });
      }
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(readFileSync(PANEL_HTML, 'utf8'));
      }
      json(res, { error: 'not found' }, 404);
    } catch (e) {
      json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // Слушаем только на loopback: панель не должна быть видна из сети.
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));

  return {
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
```

- [ ] **Step 4: Реализовать страницу**

Создать `src/ui/panel.html`:

```html
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Job Autoapply — очередь</title>
  <style>
    body { font: 15px/1.5 system-ui, sans-serif; margin: 0; background: #f6f6f7; }
    header { padding: 12px 20px; background: #fff; border-bottom: 1px solid #ddd;
             position: sticky; top: 0; display: flex; gap: 12px; align-items: center; }
    .card { display: grid; grid-template-columns: 1fr 1fr; gap: 16px;
            background: #fff; margin: 16px 20px; padding: 16px;
            border: 1px solid #ddd; border-radius: 8px; }
    .meta { font-size: 13px; color: #666; }
    .score { font-weight: 700; }
    .desc { max-height: 260px; overflow-y: auto; white-space: pre-wrap;
            font-size: 13px; border: 1px solid #eee; padding: 8px; }
    textarea { width: 100%; min-height: 260px; font: 13px/1.5 ui-monospace, monospace; }
    button { padding: 6px 14px; cursor: pointer; }
    .empty { padding: 40px 20px; color: #666; }
  </style>
</head>
<body>
  <header>
    <strong>Очередь откликов</strong>
    <span id="count"></span>
    <button id="approveAll">Одобрить всё со скором ≥ 75</button>
  </header>
  <div id="list"></div>

<script>
async function load() {
  const rows = await (await fetch('/api/pending')).json();
  document.getElementById('count').textContent = rows.length + ' в ожидании';
  const list = document.getElementById('list');
  list.innerHTML = '';

  if (rows.length === 0) {
    list.innerHTML = '<div class="empty">Пусто. Запусти поиск.</div>';
    return;
  }

  for (const r of rows) {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `
      <div>
        <div><a href="${r.vacancy.url}" target="_blank" rel="noopener">${r.vacancy.title}</a></div>
        <div class="meta">${r.vacancy.company} · ${r.vacancy.geo} · ${r.source}</div>
        <div class="meta">скор <span class="score">${r.score}</span> ·
             ${r.matched.join(', ') || 'без совпадений'} · режим ${r.letterMode}</div>
        <div class="desc"></div>
      </div>
      <div>
        <textarea></textarea>
        <div style="margin-top:8px; display:flex; gap:8px;">
          <button data-act="approve">Отправить</button>
          <button data-act="skip">Пропустить</button>
        </div>
      </div>`;
    el.querySelector('.desc').textContent = r.vacancy.description;
    el.querySelector('textarea').value = r.letter;

    el.querySelector('[data-act="approve"]').onclick = async () => {
      await post('/api/approve', { id: r.id, letter: el.querySelector('textarea').value });
      load();
    };
    el.querySelector('[data-act="skip"]').onclick = async () => {
      await post('/api/skip', { id: r.id });
      load();
    };
    list.appendChild(el);
  }
}

async function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

document.getElementById('approveAll').onclick = async () => {
  const rows = await (await fetch('/api/pending')).json();
  for (const r of rows.filter((x) => x.score >= 75)) {
    await post('/api/approve', { id: r.id, letter: r.letter });
  }
  load();
};

load();
</script>
</body>
</html>
```

- [ ] **Step 5: Запустить тесты**

Run: `npm test -- tests/ui-server.test.ts`
Expected: PASS, 4 теста

- [ ] **Step 6: Коммит**

```bash
git add src/ui/ tests/ui-server.test.ts
git commit -m "feat: local approval panel bound to loopback only

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: Сборка конвейера и живой прогон

**Files:**
- Create: `src/cli.ts`, `src/pipeline.ts`
- Test: `tests/pipeline.test.ts`
- Modify: `package.json` (скрипты)

**Interfaces:**
- Consumes: всё предыдущее
- Produces: `runSearch(opts): Promise<SearchReport>` в `src/pipeline.ts`; команды CLI `search`, `panel`, `send`, `status`, `stop`

- [ ] **Step 1: Написать падающий тест**

Создать `tests/pipeline.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSearch } from '../src/pipeline.js';
import { Queue } from '../src/core/queue.js';
import { normalizeVacancy } from '../src/core/vacancy.js';
import type { Adapter } from '../src/adapters/types.js';

const CONFIG = { minScore: 40, letterFullThreshold: 75, throttle: {} };

function mkAdapter(descs: string[]): Adapter {
  return {
    name: 'hh',
    async search() {
      return descs.map((d, i) => normalizeVacancy({
        source: 'hh', sourceId: String(i), title: 'БА', company: 'C',
        url: `https://hh.ru/vacancy/${i}`, description: d, geo: 'Москва',
        postedAt: '2026-08-20T00:00:00Z',
      }));
    },
    async apply() { return { status: 'sent' }; },
  };
}

let q: Queue;
beforeEach(() => {
  q = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-p-')), 'test.db'));
});

describe('runSearch', () => {
  it('отбрасывает вакансии ниже minScore до генерации письма', async () => {
    let letterCalls = 0;
    const rep = await runSearch({
      queue: q, config: CONFIG, filters: { query: 'аналитик' },
      adapters: [mkAdapter(['ничего интересного', 'SQL, Kafka, LLM, BPMN, DWH'])],
      generate: async () => { letterCalls++; return { letter: 'письмо', mode: 'hybrid' }; },
    });
    expect(rep.found).toBe(2);
    expect(rep.queued).toBe(1);
    expect(letterCalls).toBe(1); // на мусор токены не потрачены
  });

  it('повторный прогон не создаёт дублей', async () => {
    const opts = {
      queue: q, config: CONFIG, filters: { query: 'аналитик' },
      adapters: [mkAdapter(['SQL, Kafka, LLM, BPMN, DWH'])],
      generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
    };
    await runSearch(opts);
    const second = await runSearch(opts);
    expect(second.queued).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(q.listByStatus('pending')).toHaveLength(1);
  });

  it('падение одного адаптера не роняет остальные', async () => {
    const broken: Adapter = {
      name: 'broken',
      async search() { throw new Error('сеть легла'); },
      async apply() { return { status: 'sent' }; },
    };
    const rep = await runSearch({
      queue: q, config: CONFIG, filters: { query: 'аналитик' },
      adapters: [broken, mkAdapter(['SQL, Kafka, LLM, BPMN, DWH'])],
      generate: async () => ({ letter: 'письмо', mode: 'hybrid' as const }),
    });
    expect(rep.queued).toBe(1);
    expect(rep.adapterErrors).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npm test -- tests/pipeline.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать конвейер**

Создать `src/pipeline.ts`:

```typescript
import type { Queue, LetterMode } from './core/queue.js';
import type { Config } from './core/config.js';
import type { Adapter, SearchFilters } from './adapters/types.js';
import { scoreVacancy } from './core/scorer.js';
import { pickMode } from './core/letter.js';
import type { Vacancy } from './core/vacancy.js';

export interface SearchReport {
  found: number;
  queued: number;
  duplicates: number;
  belowThreshold: number;
  adapterErrors: Array<{ adapter: string; message: string }>;
}

export interface RunSearchOptions {
  queue: Queue;
  config: Config;
  filters: SearchFilters;
  adapters: Adapter[];
  generate: (v: Vacancy, matched: string[], mode: LetterMode)
    => Promise<{ letter: string; mode: LetterMode }>;
}

export async function runSearch(opts: RunSearchOptions): Promise<SearchReport> {
  const report: SearchReport = {
    found: 0, queued: 0, duplicates: 0, belowThreshold: 0, adapterErrors: [],
  };

  for (const adapter of opts.adapters) {
    let vacancies: Vacancy[];
    try {
      vacancies = await adapter.search(opts.filters);
    } catch (e) {
      // Частичный результат — валидный результат. Остальные площадки работают.
      report.adapterErrors.push({
        adapter: adapter.name,
        message: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    report.found += vacancies.length;

    for (const v of vacancies) {
      if (opts.queue.has(v)) { report.duplicates++; continue; }

      const { score, matched } = scoreVacancy(v);
      if (score < opts.config.minScore) { report.belowThreshold++; continue; }

      const mode = pickMode(score, opts.config.letterFullThreshold);
      const { letter, mode: usedMode } = await opts.generate(v, matched, mode);

      if (opts.queue.insertPending(v, score, matched, letter, usedMode)) report.queued++;
      else report.duplicates++;
    }
  }

  return report;
}
```

- [ ] **Step 4: Реализовать CLI**

Создать `src/cli.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { Queue } from './core/queue.js';
import { loadConfig } from './core/config.js';
import { runSearch } from './pipeline.js';
import { Sender, requestStop, clearStop, isStopRequested } from './core/sender.js';
import { startPanel } from './ui/server.js';
import { HhAdapter } from './adapters/hh.js';
import { HrGeAdapter } from './adapters/hrge.js';
import { generateLetter, pickTemplate } from './core/letter.js';
import type { Adapter } from './adapters/types.js';

const DB = 'data/queue.db';
const RESUME_PATH = 'C:/Users/lar/Desktop/Резюме/Резюме_Кандидат_БизнесАналитик_2026.md';

const [cmd, ...rest] = process.argv.slice(2);
const config = loadConfig();
const queue = new Queue(DB);
const adapters: Adapter[] = [new HhAdapter(), new HrGeAdapter()];

switch (cmd) {
  case 'search': {
    const query = rest.join(' ') || 'бизнес-аналитик';
    const client = new Anthropic();
    const resume = readFileSync(RESUME_PATH, 'utf8');

    const report = await runSearch({
      queue, config, adapters, filters: { query },
      generate: async (v, matched, mode) => generateLetter(
        { vacancy: v, matched, mode, resume,
          template: readFileSync(`templates/${pickTemplate(v, matched)}.md`, 'utf8') },
        client,
      ),
    });
    console.log(report);
    break;
  }

  case 'panel': {
    const stuck = queue.recoverStuck();
    if (stuck > 0) console.log(`${stuck} записей ждут отправки с прошлого прогона`);
    await startPanel(queue, 4321);
    console.log('Панель: http://127.0.0.1:4321');
    break;
  }

  case 'send': {
    clearStop(); // прошлый kill switch не должен блокировать новый прогон
    const map = new Map(adapters.map((a) => [a.name, a]));
    const report = await new Sender(queue, map, config).run();
    console.log(report);
    if (report.halted !== null) {
      const { source, reason } = report.halted;
      console.error(
        reason === 'killed'
          ? 'ОСТАНОВЛЕНО вручную. Неотправленное осталось в approved, запусти send заново.'
          : `ОСТАНОВЛЕНО на площадке ${source}: ${reason}. ` +
            'Открой сайт в браузере, разберись вручную, потом запусти send заново.',
      );
      process.exitCode = 1;
    }
    break;
  }

  case 'stop': {
    requestStop();
    console.log('Флаг остановки поднят. Идущая отправка встанет после текущей подачи.');
    break;
  }

  case 'status': {
    for (const s of ['pending', 'approved', 'sent', 'failed', 'skipped'] as const) {
      console.log(`${s}: ${queue.listByStatus(s).length}`);
    }
    if (isStopRequested()) console.log('ВНИМАНИЕ: поднят флаг остановки (data/STOP)');
    break;
  }

  default:
    console.log('Команды: search [запрос] | panel | send | stop | status');
}

queue.close();
```

- [ ] **Step 5: Добавить скрипты в `package.json`**

В блок `"scripts"` добавить:

```json
"search": "tsx src/cli.ts search",
"panel": "tsx src/cli.ts panel",
"send": "tsx src/cli.ts send",
"stop": "tsx src/cli.ts stop",
"status": "tsx src/cli.ts status"
```

- [ ] **Step 6: Запустить весь набор тестов**

Run: `npm test`
Expected: все тесты зелёные

Run: `npm run typecheck`
Expected: без ошибок

- [ ] **Step 7: Коммит**

```bash
git add src/pipeline.ts src/cli.ts tests/pipeline.test.ts package.json
git commit -m "feat: wire pipeline and CLI

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Живой прогон — только поиск, без отправки**

Run: `npm run search -- бизнес-аналитик`

Проверить глазами:
- сколько вакансий найдено, сколько отсеяно по `minScore`, сколько попало в очередь;
- распределение скоров выглядит осмысленно — если всё подряд получает 0 или всё подряд 100, веса в `scorer.ts` требуют правки;
- письма в очереди читаются как письма, а не как шаблон.

Run: `npm run panel`

Открыть `http://127.0.0.1:4321`, пролистать карточки.

- [ ] **Step 9: Живой прогон — одна настоящая подача**

**Это первая отправка в живой аккаунт. Делается под наблюдением человека и только после того, как он прочитал письмо в панели.**

Одобрить в панели **ровно одну** вакансию. Затем:

Run: `npm run send`

Проверить в личном кабинете `hh.ru`, что отклик действительно виден и письмо пришло целиком, без обрезки и без плейсхолдеров `{{...}}`.

Только после успеха этой проверки поднимать лимиты в `config.json`.

- [ ] **Step 10: Записать результаты живого прогона**

Создать `docs/superpowers/plans/2026-08-27-live-run-notes.md`: что сработало, что сломалось, какие селекторы `hh.ru` оказались неверными, какое распределение скоров получилось, какие пороги выставлены по итогу.

- [ ] **Step 11: Финальный коммит**

```bash
git add docs/superpowers/plans/2026-08-27-live-run-notes.md config.json
git commit -m "docs: first live run notes and calibrated thresholds

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Что считается успехом первой итерации

1. `npm test` зелёный, `npm run typecheck` без ошибок.
2. `src/adapters/types.ts` не вырос ни на один метод после реализации обоих адаптеров.
3. Один живой отклик на `hh.ru` дошёл до личного кабинета целиком.
4. Повторный `npm run search` по тому же запросу даёт `queued: 0` и ненулевой `duplicates`.
5. Тест на остановку по капче проходит, и в нём запись остаётся в `approved`, а не уходит в `failed`.

Пункты 4 и 5 — главные. Первый доказывает, что дубли невозможны; второй — что система не пытается продавить капчу.
