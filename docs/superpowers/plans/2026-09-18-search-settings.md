# Настройки поиска: специальности, веса, стаж, стоп-слова, резюме

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вынести то, что сейчас зашито в код под бизнес-аналитика (запросы, веса навыков, слова заголовка, стаж, 1С/Битрикс), в редактируемые в панели настройки, чтобы искать любые специальности со своими навыками, весами, стажем и резюме.

**Architecture:** Новый модуль совпадений (`matching.ts`) заменяет регэкспы в скоринге и отсеве. Специальность — запись в `data/settings.json`; конвейер получает фразы вместе со специальностью и оценивает вакансию её навыками. Нынешнее поведение БА сохраняется точно — это проверяет тест паритета со старым скорером.

**Tech Stack:** Node.js 24 + TypeScript strict, `node:sqlite`, Playwright, vitest, `unpdf` (новая зависимость, извлечение текста из PDF).

**Spec:** [`docs/superpowers/specs/2026-09-18-search-settings-telegram-autoapply-design.md`](../specs/2026-09-18-search-settings-telegram-autoapply-design.md), разделы 3 и 6. Этапы 1–4 из раздела 9. Этапы 5–8 (Telegram, автоотклик) — отдельный план.

## Global Constraints

- Node.js `>=24.0.0`, ESM, TypeScript `strict` + `noUncheckedIndexedAccess`.
- Регэкспы на кириллице не используют `\b` и `\w` — они не видят кириллицу (спека 3.6).
- Формула скора: `min(100, round(совпавшие_веса × 113 / сумма_всех_весов))`, сумма 0 → скор 0 (спека 3.3).
- Стоп-слово: в заголовке **или** 2+ упоминаний в описании (спека 3.5).
- Опыт: минимум бакета `noExperience=0, between1And3=1, between3And6=3, moreThan6=6`, проходит если минимум ≤ «мой опыт»; `null` проходит (спека 3.4).
- БА после переноса даёт те же скоры и те же `matched`, что до него (спека 3.3, приёмка).
- `data/settings.json` пишется атомарно: временный файл + `rename` (спека 3.8).
- Тесты не ходят в живую сеть.
- Все коммиты заканчиваются строкой `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- В этой ветке параллельно работает другая сессия. Перед каждой задачей — `git status` и `git log -3`; чужие изменения не трогать и не коммитить.

---

## Структура файлов

```
src/core/
├── matching.ts            # НОВЫЙ: правила совпадения слова с текстом (спека 3.6)
├── specialty.ts           # НОВЫЙ: типы Skill, Specialty
├── specialty-defaults.ts  # НОВЫЙ: засев — навыки/слова БА, стоп-слова, фразы
├── settings.ts            # НОВЫЙ: data/settings.json — валидация, засев, атомарная запись
├── resume.ts              # НОВЫЙ: текст резюме специальности, извлечение из PDF
├── openrouter.ts          # НОВЫЙ: общий вызов OpenRouter (вынесен из letter.ts)
├── suggest.ts             # НОВЫЙ: «Предложить» — навыки специальности от LLM
├── scorer.ts              # переписан: навыки вместо DEFAULT_WEIGHTS
├── screening.ts           # профиль вместо зашитых 1С/Битрикс/«аналитик»/juniorOnly
├── letter.ts              # роль в инструкции, вызов через openrouter.ts
├── queue.ts               # колонка specialty
└── config.ts              # searchQueries становится необязательным
src/pipeline.ts            # фразы со специальностью, стоп-слова, новые счётчики
src/cli.ts                 # сборка фраз из настроек, --specialty, резюме по специальности
src/adapters/types.ts      # SearchFilters.experienceYears
src/adapters/hh.ts         # предотсев по стажу специальности
src/ui/server.ts           # /api/settings, /api/settings/suggest
src/ui/panel.html          # вкладка «Настройки»
tests/
├── matching.test.ts       # НОВЫЙ
├── settings.test.ts       # НОВЫЙ
├── resume.test.ts         # НОВЫЙ
├── suggest.test.ts        # НОВЫЙ
├── scorer-parity.test.ts  # НОВЫЙ: старый скорер против нового на корпусе фикстур
└── support/legacy-scorer.ts  # НОВЫЙ: копия нынешнего scorer.ts, только для паритета
```

---

### Task 1: Правила совпадения

**Files:**
- Create: `src/core/matching.ts`
- Test: `tests/matching.test.ts`

**Interfaces:**
- Produces:
  - `normalizeForMatch(text: string): string` — нижний регистр, `ё→е`, латинские двойники → кириллица; длина строки сохраняется.
  - `compileTerm(term: string): RegExp | null` — глобальный регэксп по нормализованному тексту; `null` для пустого терма. Кешируется.
  - `hasInNormalized(normalized: string, term: string): boolean`
  - `countInNormalized(normalized: string, term: string): number`
  - `containsTerm(text: string, term: string): boolean` — то же, но нормализует сам.
  - `countTerm(text: string, term: string): number`

- [ ] **Step 1: Write the failing test**

`tests/matching.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { compileTerm, containsTerm, countTerm, normalizeForMatch } from '../src/core/matching.js';

describe('normalizeForMatch', () => {
  it('нижний регистр, ё → е, латинские двойники → кириллица', () => {
    expect(normalizeForMatch('Ёлка 1C TЗ')).toBe('елка 1с тз');
  });

  it('длина строки не меняется — позиции совпадений остаются честными', () => {
    const s = 'Бизнес-аналитик BPMN 2.0, ClickHouse';
    expect(normalizeForMatch(s)).toHaveLength(s.length);
  });
});

describe('containsTerm — слово совпадает с начала слова', () => {
  it.each([
    ['битрикс', 'Интегратор Битрикс24', true],
    ['битрикс', 'опыт с 1С-Битрикс', true],
    ['битрикс', 'ребитрикс', false],
    ['регламент', 'пишем регламенты', true],
    ['аналитик', 'Бизнес-аналитик', true],
    ['аналитик', 'BI-аналитика', true],
    ['задач', 'ставим задачи', true],
  ])('%s в «%s» → %s', (term, text, expected) => {
    expect(containsTerm(text, term)).toBe(expected);
  });
});

describe('containsTerm — кириллическое слово от 5 букв теряет гласное окончание', () => {
  it.each([
    ['процессная модель', 'строим процессную модель', true],
    ['процессная модель', 'описание процессной модели', true],
    ['постановка задач', 'отвечает за постановку задач', true],
    ['функциональные требования', 'сбор функциональных требований', true],
    ['оптимизация процесс*', 'занимаемся оптимизацией процессов', true],
  ])('%s в «%s» → %s', (term, text, expected) => {
    expect(containsTerm(text, term)).toBe(expected);
  });
});

describe('containsTerm — короткие слова и аббревиатуры только целиком', () => {
  it.each([
    ['SQL', 'знание SQL и Excel', true],
    ['SQL', 'PostgreSQL', false],
    ['ТЗ', 'пишем ТЗ для разработки', true],
    ['ТЗ', 'метатзисы', false],
    ['REST', 'интеграции REST API', true],
    ['REST', 'restrictions apply', false],
    ['REST', 'RESTful', false],
    ['1С', 'Аналитик 1C', true],
    ['1С', '1С:Предприятие', true],
    ['1С', '1С-Битрикс', true],
    ['1С', 'в команде 1 сотрудник', false],
    ['1С', 'температура 21С', false],
    ['A/B', 'проводим A/B-тесты', true],
    ['BA', 'BA / SA', true],
    ['BA', 'Basis', false],
  ])('%s в «%s» → %s', (term, text, expected) => {
    expect(containsTerm(text, term)).toBe(expected);
  });
});

describe('containsTerm — * и фразы', () => {
  it('* — любые буквы дальше, окончание не отрезается', () => {
    expect(containsTerm('пишем user stories', 'user stor*')).toBe(true);
    expect(containsTerm('юнит-экономика продукта', 'юнит-эконом*')).toBe(true);
  });

  it('пробел во фразе — любые пробелы; дефис — только дефис или тире', () => {
    expect(containsTerm('бизнес   процессы', 'бизнес процесс')).toBe(true);
    expect(containsTerm('бизнес-процессы', 'бизнес процесс')).toBe(false);
    expect(containsTerm('бизнес-процессы', 'бизнес-процесс')).toBe(true);
    expect(containsTerm('бизнес–процессы', 'бизнес-процесс')).toBe(true);
    expect(containsTerm('модель TO-BE', 'TO-BE')).toBe(true);
    expect(containsTerm('ability to be proactive', 'TO-BE')).toBe(false);
    expect(containsTerm('отчёты в Power BI', 'Power BI')).toBe(true);
  });
});

describe('countTerm', () => {
  it('считает непересекающиеся вхождения', () => {
    expect(countTerm('1С, 1C и снова 1С:ERP', '1С')).toBe(3);
    expect(countTerm('ничего', '1С')).toBe(0);
  });
});

describe('compileTerm', () => {
  it('пустой терм — null, а не регэксп, совпадающий со всем', () => {
    expect(compileTerm('   ')).toBeNull();
    expect(containsTerm('любой текст', '  ')).toBe(false);
    expect(countTerm('любой текст', '')).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/matching.test.ts`
Expected: FAIL — `Failed to resolve import "../src/core/matching.js"`.

- [ ] **Step 3: Write minimal implementation**

`src/core/matching.ts`:

```ts
/**
 * Совпадение слова из настроек с живым русским текстом вакансии.
 *
 * Слова задаёт человек в панели: синонимы навыков, слова заголовка,
 * стоп-слова. Пишет он их как обычно — «процессная модель», «1С», «Битрикс», —
 * а текст вакансии склоняет, путает алфавиты и лепит дефисы. Правила ниже —
 * ровно раздел 3.6 спеки 2026-09-18:
 *
 * - регистр не важен, `ё` = `е`;
 * - латиница и кириллица-двойники склеиваются («1C» = «1С»);
 * - слово совпадает с НАЧАЛА слова в тексте («битрикс» ловит «Битрикс24»);
 * - кириллическое слово от 5 букв теряет гласное окончание, до двух букв
 *   («процессная модель» ловит «процессной модели»);
 * - `*` в конце — любые буквы дальше, окончание при этом не трогается;
 * - слово до 3 знаков и аббревиатура заглавными («REST», «ТЗ») — только
 *   целиком: «REST» не ловит «restrictions», «SQL» не ловит «PostgreSQL»;
 * - во фразе пробел значит «любые пробелы», дефис — «дефис или тире».
 *
 * `\b` и `\w` не используются нигде: в JS они не видят кириллицу (см. шапку
 * scorer.ts). Граница слова — явный класс WORD_CHARS по УЖЕ нормализованному
 * тексту, поэтому в нём только строчные буквы.
 */

const WORD_CHARS = '0-9a-zа-я';
/** Дефис и все тире от U+2010 до U+2015: в описаниях вакансий встречаются все. */
const HYPHENS = '\\-\\u2010-\\u2015';
const HYPHEN_RE = new RegExp(`^[${HYPHENS}]$`);
const SPLIT_RE = new RegExp(`(\\s+|[${HYPHENS}])`);

/**
 * Латинская буква → кириллическая, которая выглядит так же. Применяется после
 * toLowerCase, поэтому пары подобраны по заглавным (B/В, H/Н, M/М, T/Т) и
 * строчным (a/а, c/с, e/е, o/о, p/р, x/х, y/у, k/к) начертаниям.
 */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у',
};

const STEMMABLE = /^[а-я]{5,}$/;
const VOWEL_END = /[аеиоуыэюяйь]$/;
const MAX_STRIPPED = 2;
const WHOLE_WORD_MAX = 3;

export function normalizeForMatch(text: string): string {
  let out = '';
  for (const ch of text.toLowerCase()) {
    const c = ch === 'ё' ? 'е' : ch;
    out += HOMOGLYPHS[c] ?? c;
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Аббревиатура: хотя бы две буквы, и ни одной строчной («REST», «ТЗ», «A/B»). */
function isAcronym(raw: string): boolean {
  const letters = raw.replace(/[^A-Za-zА-Яа-яЁё]/g, '');
  return letters.length >= 2 && letters === letters.toUpperCase();
}

function wordPattern(raw: string): string | null {
  const wildcard = raw.endsWith('*');
  const bare = wildcard ? raw.slice(0, -1) : raw;
  if (bare === '') return null;

  let base = bare.toLowerCase().replaceAll('ё', 'е');
  if (!wildcard && STEMMABLE.test(base)) {
    for (let i = 0; i < MAX_STRIPPED && VOWEL_END.test(base); i++) base = base.slice(0, -1);
  }

  const body = escapeRegExp(normalizeForMatch(base));
  const whole = !wildcard && (bare.length <= WHOLE_WORD_MAX || isAcronym(bare));
  return whole ? `${body}(?![${WORD_CHARS}])` : `${body}[${WORD_CHARS}]*`;
}

const cache = new Map<string, RegExp | null>();

export function compileTerm(term: string): RegExp | null {
  const hit = cache.get(term);
  if (hit !== undefined) return hit;

  let pattern = '';
  let words = 0;
  let separator = '\\s+';
  for (const piece of term.trim().split(SPLIT_RE)) {
    if (piece === '') continue;
    if (/^\s+$/.test(piece)) { separator = '\\s+'; continue; }
    if (HYPHEN_RE.test(piece)) { separator = `[${HYPHENS}]`; continue; }
    const wp = wordPattern(piece);
    if (wp === null) continue;
    if (words > 0) pattern += separator;
    pattern += wp;
    words++;
    separator = '\\s+';
  }

  const re = words === 0 ? null : new RegExp(`(?<![${WORD_CHARS}])${pattern}`, 'g');
  cache.set(term, re);
  return re;
}

/** `normalized` обязан быть уже пропущен через normalizeForMatch. */
export function hasInNormalized(normalized: string, term: string): boolean {
  const re = compileTerm(term);
  // search() не смотрит на lastIndex глобального регэкспа — состояние не течёт между вызовами.
  return re !== null && normalized.search(re) !== -1;
}

/** `normalized` обязан быть уже пропущен через normalizeForMatch. */
export function countInNormalized(normalized: string, term: string): number {
  const re = compileTerm(term);
  return re === null ? 0 : [...normalized.matchAll(re)].length;
}

export function containsTerm(text: string, term: string): boolean {
  return hasInNormalized(normalizeForMatch(text), term);
}

export function countTerm(text: string, term: string): number {
  return countInNormalized(normalizeForMatch(text), term);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/matching.test.ts`
Expected: PASS, все случаи.

- [ ] **Step 5: Commit**

```bash
git add src/core/matching.ts tests/matching.test.ts
git commit -m "feat: word matching that survives Russian case endings and mixed alphabets"
```

---

### Task 2: Специальность, засев БА и скорер на навыках

**Files:**
- Create: `src/core/specialty.ts`, `src/core/specialty-defaults.ts`, `tests/support/legacy-scorer.ts`, `tests/scorer-parity.test.ts`
- Modify: `src/core/scorer.ts` (целиком), `tests/scorer.test.ts`

**Interfaces:**
- Consumes: `normalizeForMatch`, `hasInNormalized` (Task 1).
- Produces:
  - `interface Skill { id: string; name: string; synonyms: string[]; weight: number; core: boolean }`
  - `interface Specialty { id: string; name: string; enabled: boolean; queries: string[]; titleWords: string[]; skills: Skill[]; experienceYears: number; resumePdf: string | null; legacyLetters: boolean }`
  - `BA_SPECIALTY_ID = 'business-analyst'`, `SYSTEM_ANALYST_SPECIALTY_ID = 'system-analyst'`
  - `BA_SKILLS: Skill[]`, `BA_TITLE_WORDS: string[]`, `DEFAULT_STOP_WORDS: string[]`, `DEFAULT_EXPERIENCE_YEARS = 2`, `BA_DEFAULT_QUERIES: string[]`, `SYSTEM_ANALYST_DEFAULT_QUERIES: string[]`
  - `makeBaSpecialty(queries: string[], resumePdf: string | null): Specialty`, `makeSystemAnalystSpecialty(queries: string[], resumePdf: string | null): Specialty`, `DEFAULT_SPECIALTY: Specialty`
  - `SCORE_REFERENCE_TOTAL = 113`; `scoreVacancy(v: Pick<Vacancy,'title'|'description'>, skills?: readonly Skill[]): ScoreResult` — `ScoreResult { score; matched: string[] /* skill.id, отсортированы */; hasCoreMatch: boolean }`. `hasCoreMatch === true`, если в профиле нет ни одного навыка-ядра с весом > 0.

- [ ] **Step 1: Сохранить старый скорер для паритета**

```bash
mkdir -p tests/support
git show HEAD:src/core/scorer.ts \
  | sed "s#from './vacancy.js'#from '../../src/core/vacancy.js'#" \
  | sed 's/export function scoreVacancy(/export function legacyScoreVacancy(/' \
  > tests/support/legacy-scorer.ts
```

Проверь, что в файле `DEFAULT_WEIGHTS` и `legacyScoreVacancy` и импорт `../../src/core/vacancy.js`. Сверху допиши комментарий:

```ts
/**
 * Скорер ДО 2026-09-18, дословно. Живёт только ради tests/scorer-parity.test.ts:
 * перенос весов бизнес-аналитика из регэкспов в синонимы обязан давать ровно
 * те же скоры. Не править — это эталон, а не код.
 */
```

- [ ] **Step 2: Write the failing parity test**

`tests/scorer-parity.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { scoreVacancy } from '../src/core/scorer.js';
import { BA_SKILLS } from '../src/core/specialty-defaults.js';
import { legacyScoreVacancy } from './support/legacy-scorer.js';
import {
  parseSearchPage as parseCareeristSearch,
  parseVacancyPage as parseCareeristVacancy,
} from '../src/adapters/careerist.js';
import { parseDetailResponse, parseSearchResponse } from '../src/adapters/hrge.js';

/**
 * Приёмка переноса БА (спека 3.3): на каждом тексте корпуса новый скорер с
 * засеянными навыками даёт тот же скор и тот же список совпадений, что старый
 * скорер на DEFAULT_WEIGHTS. Корпус — настоящие вакансии из фикстур плюс
 * фразы из tests/scorer.test.ts.
 *
 * Если тест упал, чинится BA_SKILLS (синонимы) или правила совпадения, а не
 * ожидание: расхождение значит, что владелец увидит другую очередь.
 */

const HAND_CORPUS = [
  'Ищем человека.',
  'Проводим gap-анализ AS-IS/TO-BE и пишем регламенты',
  'Требуется опыт с LLM и AI-агентами',
  'Пишем BRD, FSD и ведём постановку задач разработчикам',
  'Требуется SQL',
  'Требуется UML',
  'BPMN BRD LLM ROI Kafka UML REST SQL DWH',
  'Нужен SQL, Kafka и BPMN',
  'Нужен SQL, DWH, ClickHouse, Kafka, UML, REST, Postman, CJM, ROI, LLM и RAG',
  'Описываем регламент бизнес-процесса',
  'Собираем бизнес-требования и пишем ТЗ',
  'Строим модель AS-IS, предлагаем TO-BE',
  'Проводим гэп-анализ текущих процессов',
  'Строим процессную модель компании',
  'Занимаемся оптимизацией процессов подразделения',
  'Пишем ТЗ для разработки',
  'метатзисы это не аббревиатура',
  'Отвечает за постановку задач команде разработки',
  'Работаем по Definition of Ready',
  'Сбор бизнес- и функциональных требований, нефункциональных требований',
  'Пишем user stories и acceptance criteria, проводим A/B-тесты, считаем юнит-экономику',
  'Отчёты в Power BI и PowerBI, витрины в Vertica, дашборды Superset и Tableau',
  'Интеграции через SOAP, микросервисы, Swagger, мультиагентные системы, GenAI, когортный анализ',
];

let browser: Browser;
const corpus: string[] = [...HAND_CORPUS];

beforeAll(async () => {
  browser = await chromium.launch();
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.setContent(readFileSync('tests/fixtures/hh-search.html', 'utf8'), { waitUntil: 'domcontentloaded' });
  corpus.push(...await page.locator('[data-qa="vacancy-serp__vacancy"]').allInnerTexts());
  await page.setContent(readFileSync('tests/fixtures/hh-vacancy.html', 'utf8'), { waitUntil: 'domcontentloaded' });
  corpus.push(...await page.locator('[data-qa="vacancy-description"]').allInnerTexts());
  await context.close();

  corpus.push(...parseCareeristSearch(readFileSync('tests/fixtures/careerist-search.html', 'utf8')).map((i) => i.title));
  for (const f of ['careerist-vacancy.html', 'careerist-vacancy-nested.html']) {
    corpus.push(parseCareeristVacancy(readFileSync(`tests/fixtures/${f}`, 'utf8')).description);
  }
  corpus.push(parseDetailResponse(JSON.parse(readFileSync('tests/fixtures/hrge-detail-response.json', 'utf8'))));
  for (const f of ['hrge-search-response.json', 'hrge-search-response-keyword.json']) {
    corpus.push(...parseSearchResponse(JSON.parse(readFileSync(`tests/fixtures/${f}`, 'utf8'))).map((i) => i.title));
  }
}, 60_000);

afterAll(async () => { await browser.close(); });

describe('паритет: навыки БА против старых регэкспов', () => {
  it('корпус собран — больше 80 текстов, из них 50 карточек hh', () => {
    expect(corpus.length).toBeGreaterThan(80);
  });

  it('каждый текст корпуса: тот же скор и те же совпадения', () => {
    const diffs: string[] = [];
    for (const text of corpus) {
      const v = { title: '', description: text };
      const was = legacyScoreVacancy(v as never);
      const now = scoreVacancy(v, BA_SKILLS);
      if (was.score !== now.score || was.matched.join() !== now.matched.join()
        || was.hasCoreMatch !== now.hasCoreMatch) {
        diffs.push(`${text.slice(0, 90).replace(/\s+/g, ' ')}\n  было ${was.score} [${was.matched}] стало ${now.score} [${now.matched}]`);
      }
    }
    expect(diffs, diffs.join('\n')).toEqual([]);
  });
});
```

Если у `parseSearchResponse` из hr.ge элемент называется не `title` — открой `src/adapters/hrge.ts#SearchItem` и возьми его поле заголовка.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/scorer-parity.test.ts`
Expected: FAIL — `Failed to resolve import "../src/core/specialty-defaults.js"`.

- [ ] **Step 4: Типы специальности**

`src/core/specialty.ts`:

```ts
/**
 * Специальность — то, что человек ищет: «Бизнес-аналитик», «Менеджер продукта».
 * Хранится в data/settings.json и правится во вкладке «Настройки» (спека 3.2).
 */

export interface Skill {
  /**
   * Стабильный ключ навыка. Идёт в `matched` очереди, в письмо («совпавшие
   * темы») и в выбор скелета письма (`pickTemplate` смотрит на 'ai-llm' и
   * 'product'), поэтому у перенесённых навыков БА он равен прежнему ключу
   * группы из DEFAULT_WEIGHTS, а не русскому названию.
   */
  id: string;
  name: string;
  /** Совпадение любого синонима — навык совпал. Правила — core/matching.ts. */
  synonyms: string[];
  /** Целое 0–100. Ноль выключает навык, не удаляя его. */
  weight: number;
  /** Вакансия без единого совпавшего навыка-ядра отсекается (нынешний noCoreMatch). */
  core: boolean;
}

export interface Specialty {
  /** Стабильный ключ: пишется в колонку specialty очереди. */
  id: string;
  name: string;
  enabled: boolean;
  /** Фразы поиска для hh, careerist, hr.ge. */
  queries: string[];
  /** Вакансия проходит, только если заголовок содержит одно из них. */
  titleWords: string[];
  skills: Skill[];
  /** «Мой опыт, лет» — гейт опыта (спека 3.4). */
  experienceYears: number;
  /** Абсолютный путь к PDF резюме; null — берётся резюме БА. */
  resumePdf: string | null;
  /**
   * Письма по-старому: скелеты templates/*.md, выбор hybrid/full по скору и
   * текст резюме из CV …Бизнес-аналитик.md. true только у двух засеянных
   * специальностей — чтобы их письма не поменялись (спека 3.7). В панели не
   * показывается и при сохранении сохраняется как было.
   */
  legacyLetters: boolean;
}
```

- [ ] **Step 5: Засев**

`src/core/specialty-defaults.ts`:

```ts
import type { Skill, Specialty } from './specialty.js';

/**
 * То, что до 2026-09-18 было зашито в код, переложенное в данные. Отсюда
 * засевается data/settings.json при первом запуске (core/settings.ts).
 *
 * BA_SKILLS — перенос DEFAULT_WEIGHTS из прежнего scorer.ts: те же ключи, те
 * же веса, те же ядра. Регэкспы превращены в синонимы по правилам
 * core/matching.ts; равенство скоров проверяет tests/scorer-parity.test.ts.
 * Там, где регэксп покрывал несколько написаний («бизнес[- ]?процесс»), здесь
 * столько же синонимов.
 */

export const BA_SPECIALTY_ID = 'business-analyst';
export const SYSTEM_ANALYST_SPECIALTY_ID = 'system-analyst';

/** Прежний ACCEPTABLE_EXPERIENCE (без опыта и 1–3 года) — это ровно «мой опыт 2 года». */
export const DEFAULT_EXPERIENCE_YEARS = 2;

export const BA_SKILLS: Skill[] = [
  {
    id: 'process-design', name: 'Процессы', weight: 28, core: true,
    synonyms: [
      'BPMN', 'AS-IS', 'TO-BE',
      'gap-анализ', 'gap анализ', 'геп-анализ', 'гэп-анализ', 'геп анализ', 'гэп анализ',
      'регламент', 'бизнес-процесс', 'бизнес процесс', 'бизнеспроцесс',
      'процессная модель', 'оптимизация процесс*',
    ],
  },
  {
    id: 'requirements-docs', name: 'Требования и документация', weight: 24, core: true,
    synonyms: [
      'BRD', 'FSD', 'SRS', 'ТЗ',
      'бизнес-требования', 'бизнес требования', 'бизнестребования',
      'функциональные требования', 'нефункциональные требования',
      'user stor*', 'acceptance criteria', 'DoR', 'definition of ready', 'постановка задач',
    ],
  },
  {
    id: 'ai-llm', name: 'AI / LLM', weight: 22, core: false,
    synonyms: ['LLM', 'AI-агент', 'AI агент', 'AIагент', 'GenAI', 'мультиагент', 'RAG'],
  },
  {
    id: 'product', name: 'Продукт', weight: 8, core: false,
    synonyms: ['CJM', 'A/B', 'юнит-эконом*', 'юнит эконом*', 'ROI', 'когортн*'],
  },
  { id: 'kafka', name: 'Kafka', weight: 8, core: false, synonyms: ['Kafka'] },
  { id: 'uml', name: 'UML', weight: 6, core: false, synonyms: ['UML'] },
  {
    id: 'integrations', name: 'Интеграции', weight: 6, core: false,
    synonyms: ['REST', 'SOAP', 'микросервис', 'Swagger', 'Postman'],
  },
  { id: 'sql', name: 'SQL', weight: 6, core: false, synonyms: ['SQL'] },
  {
    id: 'dwh', name: 'DWH / BI', weight: 5, core: false,
    synonyms: ['DWH', 'ClickHouse', 'Vertica', 'Superset', 'Tableau', 'Power BI', 'PowerBI'],
  },
];

/** Прежний ANALYST_TITLE_PATTERNS. */
export const BA_TITLE_WORDS: string[] = ['аналитик', 'analyst', 'BA', 'SA'];

/** Прежние 1С и Битрикс24 из screening.ts. Битрикс — двумя алфавитами, как было в регэкспе. */
export const DEFAULT_STOP_WORDS: string[] = ['1С', 'Битрикс', 'Bitrix'];

/** Фразы, если в config.json нет searchQueries. Совпадают с config.json на 2026-09-18. */
export const BA_DEFAULT_QUERIES: string[] = [
  'аналитик бизнес-процессов', 'аналитик бизнес процессов', 'бизнес-аналитик', 'бизнес аналитик',
];
export const SYSTEM_ANALYST_DEFAULT_QUERIES: string[] = ['системный аналитик'];

function cloneSkills(): Skill[] {
  return BA_SKILLS.map((s) => ({ ...s, synonyms: [...s.synonyms] }));
}

export function makeBaSpecialty(queries: string[], resumePdf: string | null): Specialty {
  return {
    id: BA_SPECIALTY_ID, name: 'Бизнес-аналитик', enabled: true, queries: [...queries],
    titleWords: [...BA_TITLE_WORDS], skills: cloneSkills(),
    experienceYears: DEFAULT_EXPERIENCE_YEARS, resumePdf, legacyLetters: true,
  };
}

/**
 * Прежний запрос «системный аналитик» с juniorOnly. Опыт 0 — это и есть
 * juniorOnly: проходит только «без опыта», плюс отсев «старший/senior/middle»
 * в заголовке (core/screening.ts). Навыки и слова заголовка — как у БА:
 * раньше все фразы оценивались одним скорингом.
 */
export function makeSystemAnalystSpecialty(queries: string[], resumePdf: string | null): Specialty {
  return {
    ...makeBaSpecialty(queries, resumePdf),
    id: SYSTEM_ANALYST_SPECIALTY_ID, name: 'Системный аналитик', experienceYears: 0,
  };
}

/** Специальность по умолчанию там, где её не передали (старые вызовы, тесты). */
export const DEFAULT_SPECIALTY: Specialty = makeBaSpecialty(BA_DEFAULT_QUERIES, null);
```

- [ ] **Step 6: Переписать скорер**

`src/core/scorer.ts` целиком:

```ts
import type { Vacancy } from './vacancy.js';
import type { Skill } from './specialty.js';
import { BA_SKILLS } from './specialty-defaults.js';
import { hasInNormalized, normalizeForMatch } from './matching.js';

export interface ScoreResult {
  score: number;
  /** id совпавших навыков, по алфавиту. Идут в письмо и в выбор скелета. */
  matched: string[];
  /**
   * true, если совпал хотя бы один навык-ядро. Также true, если в профиле нет
   * ни одного ядра с ненулевым весом: гейту нечего требовать (спека 3.3).
   */
  hasCoreMatch: boolean;
}

/**
 * Сумма весов бизнес-аналитика на 2026-09-18 (28+24+22+8+8+6+6+6+5). Скор
 * нормируется на сумму весов профиля и растягивается на это число, поэтому
 * для БА формула сводится ровно к прежней `min(100, совпавшие_веса)`, а у
 * любого другого профиля шкала остаётся 0–100 и порог minScore не теряет
 * смысла.
 */
export const SCORE_REFERENCE_TOTAL = 113;

/**
 * Навык совпал, если в заголовке или описании нашёлся любой его синоним (см.
 * core/matching.ts). Навык с весом 0 выключен целиком: не совпадает, не
 * считается в сумму и не участвует в гейте ядра.
 */
export function scoreVacancy(
  v: Pick<Vacancy, 'title' | 'description'>,
  skills: readonly Skill[] = BA_SKILLS,
): ScoreResult {
  const haystack = normalizeForMatch(`${v.title}\n${v.description}`);
  const matched: string[] = [];
  let matchedWeight = 0;
  let totalWeight = 0;
  let hasCore = false;
  let coreRequired = false;

  for (const skill of skills) {
    if (skill.weight <= 0) continue;
    totalWeight += skill.weight;
    if (skill.core) coreRequired = true;
    if (skill.synonyms.some((t) => hasInNormalized(haystack, t))) {
      matched.push(skill.id);
      matchedWeight += skill.weight;
      if (skill.core) hasCore = true;
    }
  }

  const score = totalWeight === 0
    ? 0
    : Math.min(100, Math.round((matchedWeight * SCORE_REFERENCE_TOTAL) / totalWeight));
  return { score, matched: matched.sort(), hasCoreMatch: hasCore || !coreRequired };
}
```

- [ ] **Step 7: Поправить tests/scorer.test.ts под новый импорт**

Замени импорт и тест про сотню:

```ts
import { scoreVacancy } from '../src/core/scorer.js';
import { BA_SKILLS } from '../src/core/specialty-defaults.js';
import type { Skill } from '../src/core/specialty.js';
```

```ts
  it('скор ограничен сверху сотней', () => {
    // По одному ключевику на каждую из девяти групп: сырая сумма 113, то есть
    // тест действительно проходит через Math.min(100, …).
    const everyGroup = 'BPMN BRD LLM ROI Kafka UML REST SQL DWH';
    const r = scoreVacancy(v(everyGroup));
    expect(r.matched).toHaveLength(BA_SKILLS.length);
    expect(r.score).toBe(100);
  });
```

И добавь в конец файла:

```ts
describe('scoreVacancy — любой профиль', () => {
  const skills: Skill[] = [
    { id: 'roadmap', name: 'Роадмап', synonyms: ['роадмап', 'roadmap'], weight: 30, core: true },
    { id: 'metrics', name: 'Метрики', synonyms: ['метрик', 'retention'], weight: 10, core: false },
  ];

  it('скор нормируется на сумму весов профиля', () => {
    // 30 из 40 → 30 × 113 / 40 = 84.75 → 85
    expect(scoreVacancy(v('Ведём роадмап продукта'), skills).score).toBe(85);
    expect(scoreVacancy(v('Роадмап, метрики, retention'), skills).score).toBe(100);
  });

  it('вес 0 выключает навык целиком — и из суммы, и из гейта ядра', () => {
    const off: Skill[] = [{ ...skills[0]!, weight: 0 }, skills[1]!];
    const r = scoreVacancy(v('Ведём роадмап и метрики'), off);
    expect(r.matched).toEqual(['metrics']);
    expect(r.score).toBe(100); // 10 из 10 → 113 → потолок
    expect(r.hasCoreMatch).toBe(true); // ядер с весом > 0 не осталось — требовать нечего
  });

  it('сумма весов 0 — скор 0', () => {
    expect(scoreVacancy(v('роадмап'), []).score).toBe(0);
  });

  it('ядро есть, но не совпало — hasCoreMatch false', () => {
    expect(scoreVacancy(v('Считаем метрики'), skills).hasCoreMatch).toBe(false);
  });
});
```

- [ ] **Step 8: Run tests**

Run: `npx vitest run tests/scorer.test.ts tests/scorer-parity.test.ts`
Expected: PASS. Если паритет упал — тест печатает каждый расходящийся текст с «было/стало». Чини синонимы в `BA_SKILLS` (или правило в `matching.ts`, тогда допиши случай в `tests/matching.test.ts`), пока расхождений не станет ноль. Ожидание не трогай.

- [ ] **Step 9: Commit**

```bash
git add src/core/specialty.ts src/core/specialty-defaults.ts src/core/scorer.ts tests/scorer.test.ts tests/scorer-parity.test.ts tests/support/legacy-scorer.ts
git commit -m "feat: skills with weights replace hard-coded scorer regexes, same scores for BA"
```

---

### Task 3: Отсев по профилю специальности

**Files:**
- Modify: `src/core/screening.ts`, `src/adapters/types.ts`, `src/adapters/hh.ts:503-527`, `tests/screening.test.ts`, `tests/hh.test.ts` (только если там импортируются удалённые функции)

**Interfaces:**
- Consumes: `normalizeForMatch`, `hasInNormalized`, `countInNormalized` (Task 1); `BA_TITLE_WORDS`, `DEFAULT_STOP_WORDS`, `DEFAULT_EXPERIENCE_YEARS` (Task 2).
- Produces:
  - `isExperienceWithin(level: ExperienceLevel | null, years: number): boolean`
  - `STOPWORD_DESCRIPTION_THRESHOLD = 2`; `findStopWord(v: Pick<Vacancy,'title'|'description'>, stopWords: readonly string[]): string | null`
  - `hasTitleWord(title: string, titleWords: readonly string[]): boolean`
  - `interface ScreeningProfile { titleWords: readonly string[]; experienceYears: number; stopWords: readonly string[]; skipTitleGate?: boolean }`
  - `DEFAULT_SCREENING: ScreeningProfile`
  - `type ScreenReason = 'experience' | 'grade' | 'stopword' | 'internship' | 'not_title'`
  - `type ScreenResult = { passed: true } | { passed: false; reason: ScreenReason; detail: string; stopWord?: string }`
  - `screenVacancy(v: Vacancy, profile?: ScreeningProfile): ScreenResult`
  - остаются: `parseExperienceFromText`, `isSeniorTitle`, `isInternshipTitle`, `isAboveJuniorTitle`
  - удаляются: `isExperienceAcceptable`, `JUNIOR_EXPERIENCE`, `isJuniorExperience`, `is1cCentric`, `isBitrixCentric`, `isAnalystTitle`
  - `SearchFilters.experienceYears?: number` — стаж специальности, по которой идёт этот запрос.

- [ ] **Step 1: Write the failing tests**

В `tests/screening.test.ts`:
1. Импорт замени на:

```ts
import {
  screenVacancy,
  parseExperienceFromText,
  isSeniorTitle,
  isInternshipTitle,
  isAboveJuniorTitle,
  isExperienceWithin,
  findStopWord,
  hasTitleWord,
  DEFAULT_SCREENING,
  STOPWORD_DESCRIPTION_THRESHOLD,
} from '../src/core/screening.js';
```

2. Удали блоки `describe('isExperienceAcceptable'…)`, `describe('isJuniorExperience / JUNIOR_EXPERIENCE'…)`, `describe('is1cCentric'…)`, и внутри `describe('правила по разбору отменённых 2026-09-01')` — блоки про Битрикс и «заголовок обязан называть аналитика» (их случаи переезжают ниже). Блоки `parseExperienceFromText`, `isSeniorTitle`, `screenVacancy — experience/grade`, «стажировки», «грейд выше junior» оставь; в них замени `reason: 'platform'` на `reason: 'stopword'` и `reason: 'not_analyst'` на `reason: 'not_title'`, если встретятся.

3. Добавь:

```ts
describe('isExperienceWithin — минимум бакета против «мой опыт»', () => {
  it.each([
    ['noExperience', 0, true], ['between1And3', 0, false],
    ['between1And3', 1, true], ['between1And3', 2, true], ['between3And6', 2, false],
    ['between3And6', 3, true], ['moreThan6', 5, false], ['moreThan6', 6, true],
  ] as const)('%s при опыте %i → %s', (level, years, expected) => {
    expect(isExperienceWithin(level, years)).toBe(expected);
  });

  it('требование неизвестно — проходит при любом опыте', () => {
    expect(isExperienceWithin(null, 0)).toBe(true);
  });

  it('опыт 2 — ровно прежний ACCEPTABLE_EXPERIENCE', () => {
    expect(DEFAULT_SCREENING.experienceYears).toBe(2);
  });
});

describe('findStopWord — заголовок или 2+ упоминаний в описании', () => {
  const words = ['1С', 'Битрикс', 'Bitrix'];

  it('порог описания — 2', () => expect(STOPWORD_DESCRIPTION_THRESHOLD).toBe(2));

  it('«Аналитик 1С» — в заголовке, сразу', () => {
    expect(findStopWord(v({ title: 'Аналитик 1С', description: 'x' }), words)).toBe('1С');
  });

  it('латинская «1C» в заголовке тоже', () => {
    expect(findStopWord(v({ title: 'Аналитик 1C', description: 'x' }), words)).toBe('1С');
  });

  it('одно упоминание в списке систем — проходит', () => {
    expect(findStopWord(v({ description: 'Системы: TOS.Solvo, 1С, ELMA, Jira.' }), words)).toBeNull();
  });

  it('два упоминания в описании — отсев (было три до 2026-09-18, спека 3.5)', () => {
    expect(findStopWord(v({ description: 'Внедрение 1С:ERP. Интеграции с 1С.' }), words)).toBe('1С');
  });

  it('«1 сотрудник» и «21С» — не 1С', () => {
    expect(findStopWord(v({ description: '1 сотрудник, 1 секция, 21С, 21С' }), words)).toBeNull();
  });

  it('«Системный аналитик Bitrix24» и «Интегратор/аналитик Битрикс24» — по заголовку', () => {
    expect(findStopWord(v({ title: 'Системный аналитик Bitrix24' }), words)).toBe('Bitrix');
    expect(findStopWord(v({ title: 'Интегратор/аналитик Битрикс24' }), words)).toBe('Битрикс');
  });

  it('Битрикс один раз среди систем — проходит', () => {
    expect(findStopWord(v({ description: 'Работали с amoCRM, Битрикс24, Jira' }), words)).toBeNull();
  });

  it('пустой список — ничего не отсекает', () => {
    expect(findStopWord(v({ title: 'Аналитик 1С' }), [])).toBeNull();
  });
});

describe('hasTitleWord', () => {
  const words = ['аналитик', 'analyst', 'BA', 'SA'];

  it.each([
    'Менеджер по операционному консалтингу',
    'Менеджер по повышению эффективности бизнеса (направление lean)',
    'Управляющий директор по развитию эффективности сегментов',
  ])('отсекает «%s»', (title) => expect(hasTitleWord(title, words)).toBe(false));

  it.each([
    'Бизнес-аналитик', 'Системный аналитик', 'Business Analyst', 'BA / SA', 'Аналитик бизнес-процессов',
  ])('пропускает «%s»', (title) => expect(hasTitleWord(title, words)).toBe(true));
});

describe('screenVacancy — профиль специальности', () => {
  const profile = { titleWords: ['продакт', 'product'], experienceYears: 3, stopWords: ['вахта'] };

  it('слова заголовка берутся из профиля', () => {
    expect(screenVacancy(v({ title: 'Product manager' }), profile)).toEqual({ passed: true });
    const r = screenVacancy(v({ title: 'Бизнес-аналитик' }), profile);
    expect(r.passed === false && r.reason).toBe('not_title');
  });

  it('стаж — из профиля: 3–6 лет проходит при опыте 3', () => {
    expect(screenVacancy(v({ title: 'Product manager', experience: 'between3And6' }), profile).passed).toBe(true);
  });

  it('стоп-слово называет себя в причине', () => {
    const r = screenVacancy(v({ title: 'Product manager вахта' }), profile);
    expect(r).toMatchObject({ passed: false, reason: 'stopword', stopWord: 'вахта' });
  });

  it('опыт 0 отсекает «Старший …» по грейду — прежний juniorOnly', () => {
    const r = screenVacancy(v({ title: 'Старший системный аналитик' }), { ...DEFAULT_SCREENING, experienceYears: 0 });
    expect(r.passed === false && r.reason).toBe('grade');
  });

  it('опыт 2 «Старший ИТ аналитик» пропускает', () => {
    expect(screenVacancy(v({ title: 'Старший ИТ аналитик' })).passed).toBe(true);
  });

  it('skipTitleGate снимает проверку заголовка', () => {
    expect(screenVacancy(v({ title: 'Пост из канала' }), { ...profile, skipTitleGate: true }).passed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/screening.test.ts`
Expected: FAIL — `isExperienceWithin`/`findStopWord`/`hasTitleWord` не экспортированы.

- [ ] **Step 3: Implement screening**

В `src/core/screening.ts`:

1. Импорты сверху:

```ts
import type { ExperienceLevel, Vacancy } from './vacancy.js';
import { countInNormalized, hasInNormalized, normalizeForMatch } from './matching.js';
import { BA_TITLE_WORDS, DEFAULT_EXPERIENCE_YEARS, DEFAULT_STOP_WORDS } from './specialty-defaults.js';
```

2. `ScreenReason`/`ScreenResult` замени на:

```ts
export type ScreenReason =
  | 'experience'
  | 'grade'
  /** Стоп-слово из настроек (спека 3.5). Раньше — 'platform' для 1С и Битрикса. */
  | 'stopword'
  | 'internship'
  /** В заголовке нет ни одного слова заголовка специальности. Раньше — 'not_analyst'. */
  | 'not_title';

export type ScreenResult =
  | { passed: true }
  | { passed: false; reason: ScreenReason; detail: string; stopWord?: string };

/** Что отсев берёт из специальности и настроек. */
export interface ScreeningProfile {
  titleWords: readonly string[];
  experienceYears: number;
  stopWords: readonly string[];
  /**
   * Не проверять заголовок. Для постов Telegram: слова заголовка там ищутся по
   * всему посту ещё до конвейера, а заголовок из запасного правила может их
   * не содержать (спека 4.6).
   */
  skipTitleGate?: boolean;
}

export const DEFAULT_SCREENING: ScreeningProfile = {
  titleWords: BA_TITLE_WORDS,
  experienceYears: DEFAULT_EXPERIENCE_YEARS,
  stopWords: DEFAULT_STOP_WORDS,
};
```

3. Раздел 1 «Опыт»: удали `ACCEPTABLE_EXPERIENCE`, `isExperienceAcceptable`, `JUNIOR_EXPERIENCE`, `isJuniorExperience`, `checkExperience` и вставь:

```ts
/**
 * Минимум лет, который требует бакет. Вакансия проходит, если этот минимум не
 * выше «мой опыт» специальности (спека 3.4). «1–3 года» требует минимум 1,
 * поэтому при опыте 2 проходит, а «3–6 лет» — нет: ровно прежний
 * ACCEPTABLE_EXPERIENCE. При опыте 0 проходит только «без опыта» — прежний
 * juniorOnly.
 */
const MIN_YEARS: Readonly<Record<ExperienceLevel, number>> = {
  noExperience: 0,
  between1And3: 1,
  between3And6: 3,
  moreThan6: 6,
};

/** null — требование неизвестно — проходит: иначе гейт тихо резал бы большинство вакансий. */
export function isExperienceWithin(level: ExperienceLevel | null, years: number): boolean {
  if (level === null) return true;
  return MIN_YEARS[level] <= years;
}
```

4. Разделы 3 (1С) и 4 (заголовок-аналитик): удали `ONE_C_TOKEN_RE`, `ONE_C_DESCRIPTION_THRESHOLD`, `BITRIX_TOKEN_RE`, `BITRIX_DESCRIPTION_THRESHOLD`, `countBitrixMentions`, `isBitrixCentric`, `count1cMentions`, `is1cCentric`, `ANALYST_TITLE_PATTERNS`, `isAnalystTitle` и вставь:

```ts
// ============================================================================
// 3. Стоп-слова — платформы и прочее, что владельцу не подходит.
// ============================================================================

/**
 * Одно правило на все стоп-слова (спека 3.5, выбор владельца 2026-09-18):
 * слово в заголовке — отсев сразу; в описании — если встретилось 2 раза и
 * больше. Одно упоминание — это обычно пункт в списке систем («Jira, 1С,
 * ELMA»), и резать за него значит терять нормальные вакансии.
 *
 * Для 1С это строже прежнего порога 3 — осознанно.
 */
export const STOPWORD_DESCRIPTION_THRESHOLD = 2;

/** Первое сработавшее стоп-слово в порядке списка, либо null. */
export function findStopWord(
  v: Pick<Vacancy, 'title' | 'description'>,
  stopWords: readonly string[],
): string | null {
  const title = normalizeForMatch(v.title);
  const description = normalizeForMatch(v.description);
  for (const word of stopWords) {
    if (hasInNormalized(title, word)) return word;
    if (countInNormalized(description, word) >= STOPWORD_DESCRIPTION_THRESHOLD) return word;
  }
  return null;
}

// ============================================================================
// 4. Заголовок обязан называть специальность.
// ============================================================================

/**
 * Скор говорит, ЧЕМ занимаются; заголовок — кем зовут. 2026-09-01 владелец
 * отменил «Менеджера по операционному консалтингу» и подобных: лексика
 * процессов в описании у них честно была, а роль — не его. Слова берутся из
 * специальности (у БА — «аналитик», «analyst», «BA», «SA»).
 */
export function hasTitleWord(title: string, titleWords: readonly string[]): boolean {
  const normalized = normalizeForMatch(title);
  return titleWords.some((w) => hasInNormalized(normalized, w));
}
```

5. `screenVacancy` замени на:

```ts
export function screenVacancy(v: Vacancy, profile: ScreeningProfile = DEFAULT_SCREENING): ScreenResult {
  const level = v.experience ?? parseExperienceFromText(v.description);
  if (!isExperienceWithin(level, profile.experienceYears)) {
    return {
      passed: false,
      reason: 'experience',
      detail: `требуемый опыт выше заданных ${profile.experienceYears} лет (структурно: ${v.experience ?? 'нет'})`,
    };
  }
  if (isSeniorTitle(v.title)) {
    return {
      passed: false,
      reason: 'grade',
      detail: 'заголовок содержит маркер грейда выше начального/среднего уровня',
    };
  }
  if (profile.experienceYears < 1 && isAboveJuniorTitle(v.title)) {
    return {
      passed: false,
      reason: 'grade',
      detail: 'при опыте 0 отсекаются «старший», senior и middle в заголовке',
    };
  }
  const stopWord = findStopWord(v, profile.stopWords);
  if (stopWord !== null) {
    return { passed: false, reason: 'stopword', detail: `стоп-слово: ${stopWord}`, stopWord };
  }
  if (isInternshipTitle(v.title)) {
    return { passed: false, reason: 'internship', detail: 'стажировка' };
  }
  if (profile.skipTitleGate !== true && !hasTitleWord(v.title, profile.titleWords)) {
    return {
      passed: false,
      reason: 'not_title',
      detail: 'заголовок не называет специальность, каким бы ни был скор описания',
    };
  }
  return { passed: true };
}
```

Шапку файла (про «три жёстких фильтра») поправь одной фразой: теперь параметры отсева берутся из специальности и стоп-слов настроек, в коде остаются только стажировки и грейд.

- [ ] **Step 4: hh-предотсев по стажу специальности**

`src/adapters/types.ts`, в `SearchFilters` после `skip`:

```ts
  /**
   * «Мой опыт, лет» специальности, по которой идёт этот запрос (спека 3.4).
   * Адаптер, который отсеивает по опыту до дочитки описания (hh.ru), обязан
   * брать порог отсюда, а не из общего значения: иначе запрос системного
   * аналитика (опыт 0) пропускал бы «1–3 года». undefined — порог по
   * умолчанию, DEFAULT_EXPERIENCE_YEARS.
   */
  experienceYears?: number;
```

`src/adapters/hh.ts`: импорт `isExperienceAcceptable, isSeniorTitle` замени на

```ts
import { isAboveJuniorTitle, isExperienceWithin, isSeniorTitle } from '../core/screening.js';
import { DEFAULT_EXPERIENCE_YEARS } from '../core/specialty-defaults.js';
```

и цикл предотсева:

```ts
      const years = filters.experienceYears ?? DEFAULT_EXPERIENCE_YEARS;
      for (const it of window) {
        if (!isExperienceWithin(it.experience ?? null, years)) { rejectedExperience++; continue; }
        if (isSeniorTitle(it.title) || (years < 1 && isAboveJuniorTitle(it.title))) {
          rejectedGrade++;
          continue;
        }
        if (filters.seenThisRun?.has(`${this.name}:${it.sourceId}`)) { duplicatesSkipped++; continue; }
        wanted.push(it);
      }
```

Проверь `grep -rn "isExperienceAcceptable\|is1cCentric\|isBitrixCentric\|isAnalystTitle\|isJuniorExperience\|JUNIOR_EXPERIENCE" src tests scripts` — после правки совпадений быть не должно (кроме `pipeline.ts`, его чинит Task 5).

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/screening.test.ts tests/hh.test.ts tests/matching.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/screening.ts src/adapters/types.ts src/adapters/hh.ts tests/screening.test.ts
git commit -m "feat: screening takes title words, experience and stop-words from the specialty"
```

---

### Task 4: Хранилище настроек

**Files:**
- Create: `src/core/settings.ts`, `tests/settings.test.ts`
- Modify: `src/core/config.ts:73-102` (searchQueries необязателен), `tests/config.test.ts:145-157`

**Interfaces:**
- Consumes: `Specialty`, `Skill` (Task 2); `makeBaSpecialty`, `makeSystemAnalystSpecialty`, `BA_DEFAULT_QUERIES`, `SYSTEM_ANALYST_DEFAULT_QUERIES`, `DEFAULT_STOP_WORDS` (Task 2); `SearchQueryConfig` (config.ts).
- Produces:
  - `interface Settings { version: 1; specialties: Specialty[]; stopWords: string[] }`
  - `SETTINGS_PATH = 'data/settings.json'`
  - `validateSettings(raw: unknown): { ok: true; settings: Settings } | { ok: false; error: string }` — чистит пробелы и пустые строки в списках, выдаёт id новым специальностям и навыкам.
  - `seedSettings(searchQueries: readonly SearchQueryConfig[] | undefined, baResumePdf: string | null): Settings`
  - `loadSettings(path: string, seed: () => Settings): Settings` — нет файла → засев и запись; битый файл → Error с путём и причиной (не пересевает молча).
  - `saveSettings(path: string, settings: unknown): Settings` — валидация, атомарная запись; при ошибке валидации бросает `Error(error)`.
  - `enabledSpecialties(s: Settings): Specialty[]`

- [ ] **Step 1: Write the failing test**

`tests/settings.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateSettings, seedSettings, loadSettings, saveSettings, enabledSpecialties, type Settings,
} from '../src/core/settings.js';
import { BA_SPECIALTY_ID, SYSTEM_ANALYST_SPECIALTY_ID, BA_SKILLS } from '../src/core/specialty-defaults.js';

const CONFIG_QUERIES = [
  { query: 'аналитик бизнес-процессов' },
  { query: 'бизнес-аналитик' },
  { query: 'системный аналитик', constraints: { juniorOnly: true } },
];

function tmp(): string {
  return join(mkdtempSync(join(tmpdir(), 'jaa-settings-')), 'settings.json');
}

describe('seedSettings', () => {
  it('фразы без juniorOnly — БА, с juniorOnly — системный аналитик с опытом 0', () => {
    const s = seedSettings(CONFIG_QUERIES, '/cv.pdf');
    const [ba, sa] = s.specialties;
    expect(ba!.id).toBe(BA_SPECIALTY_ID);
    expect(ba!.queries).toEqual(['аналитик бизнес-процессов', 'бизнес-аналитик']);
    expect(ba!.experienceYears).toBe(2);
    expect(ba!.resumePdf).toBe('/cv.pdf');
    expect(ba!.legacyLetters).toBe(true);
    expect(sa!.id).toBe(SYSTEM_ANALYST_SPECIALTY_ID);
    expect(sa!.queries).toEqual(['системный аналитик']);
    expect(sa!.experienceYears).toBe(0);
    expect(sa!.skills).toEqual(ba!.skills);
  });

  it('без searchQueries в config — фразы по умолчанию', () => {
    const s = seedSettings(undefined, null);
    expect(s.specialties[0]!.queries.length).toBeGreaterThan(0);
    expect(s.specialties[1]!.queries).toEqual(['системный аналитик']);
  });

  it('стоп-слова — 1С и Битрикс', () => {
    expect(seedSettings(undefined, null).stopWords).toEqual(['1С', 'Битрикс', 'Bitrix']);
  });

  it('засев проходит собственную валидацию', () => {
    expect(validateSettings(seedSettings(CONFIG_QUERIES, null)).ok).toBe(true);
  });
});

describe('validateSettings', () => {
  function base(): Settings {
    return seedSettings(CONFIG_QUERIES, null);
  }

  it('чистит пробелы и пустые строки в списках', () => {
    const s = base();
    s.specialties[0]!.queries = ['  бизнес-аналитик ', '', '   '];
    s.stopWords = [' 1С ', '', '1с'];
    const r = validateSettings(s);
    expect(r.ok && r.settings.specialties[0]!.queries).toEqual(['бизнес-аналитик']);
    // дубль без учёта регистра выкидывается
    expect(r.ok && r.settings.stopWords).toEqual(['1С']);
  });

  it.each([
    ['пустое название', (s: Settings) => { s.specialties[0]!.name = '  '; }, /название/],
    ['повтор названия', (s: Settings) => { s.specialties[1]!.name = 'бизнес-аналитик'; }, /повтор/],
    ['нет слов заголовка', (s: Settings) => { s.specialties[0]!.titleWords = ['']; }, /слов[оа] заголовка/],
    ['вес больше 100', (s: Settings) => { s.specialties[0]!.skills[0]!.weight = 101; }, /вес/],
    ['дробный вес', (s: Settings) => { s.specialties[0]!.skills[0]!.weight = 2.5; }, /вес/],
    ['навык без синонимов', (s: Settings) => { s.specialties[0]!.skills[0]!.synonyms = [' ']; }, /синоним/],
    ['опыт -1', (s: Settings) => { s.specialties[0]!.experienceYears = -1; }, /опыт/],
    ['опыт дробный', (s: Settings) => { s.specialties[0]!.experienceYears = 1.5; }, /опыт/],
  ])('отклоняет: %s', (_label, mutate, message) => {
    const s = base();
    mutate(s);
    const r = validateSettings(s);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(message);
  });

  it('новой специальности и новому навыку выдаёт id', () => {
    const s = base() as unknown as { specialties: Array<Record<string, unknown>> };
    s.specialties.push({
      name: 'Менеджер продукта', enabled: true, queries: ['product manager'], titleWords: ['продакт'],
      skills: [{ name: 'Роадмап', synonyms: ['роадмап'], weight: 20, core: true }],
      experienceYears: 1, resumePdf: null,
    });
    const r = validateSettings(s);
    expect(r.ok).toBe(true);
    const added = r.ok ? r.settings.specialties[2]! : undefined;
    expect(added!.id).toMatch(/^s\d+$/);
    expect(added!.skills[0]!.id).toMatch(/^k\d+$/);
    expect(added!.legacyLetters).toBe(false);
  });

  it('не ломает id и порядок навыков БА', () => {
    const r = validateSettings(base());
    expect(r.ok && r.settings.specialties[0]!.skills.map((k) => k.id)).toEqual(BA_SKILLS.map((k) => k.id));
  });

  it('мусор вместо объекта — понятная ошибка, не исключение', () => {
    expect(validateSettings(null).ok).toBe(false);
    expect(validateSettings({ specialties: 'нет' }).ok).toBe(false);
  });
});

describe('loadSettings / saveSettings', () => {
  it('нет файла — засевает и записывает', () => {
    const path = tmp();
    const s = loadSettings(path, () => seedSettings(CONFIG_QUERIES, null));
    expect(s.specialties).toHaveLength(2);
    expect(existsSync(path)).toBe(true);
  });

  it('битый файл — ошибка с путём, а не молчаливый пересев', () => {
    const path = tmp();
    writeFileSync(path, '{ нет', 'utf8');
    expect(() => loadSettings(path, () => seedSettings(undefined, null))).toThrow(path);
    expect(readFileSync(path, 'utf8')).toBe('{ нет');
  });

  it('сохранение отклоняет плохое и не трогает файл', () => {
    const path = tmp();
    const s = loadSettings(path, () => seedSettings(undefined, null));
    const before = readFileSync(path, 'utf8');
    const bad = structuredClone(s);
    bad.specialties[0]!.name = '';
    expect(() => saveSettings(path, bad)).toThrow(/название/);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('сохранение атомарное: временных файлов не остаётся, прочитанное совпадает', () => {
    const path = tmp();
    const s = loadSettings(path, () => seedSettings(undefined, null));
    s.specialties[0]!.skills[0]!.weight = 30;
    saveSettings(path, s);
    expect(readdirSync(join(path, '..'))).toEqual(['settings.json']);
    expect(loadSettings(path, () => { throw new Error('не должен засевать'); }).specialties[0]!.skills[0]!.weight).toBe(30);
  });
});

describe('enabledSpecialties', () => {
  it('только включённые, в порядке настроек', () => {
    const s = seedSettings(CONFIG_QUERIES, null);
    s.specialties[0]!.enabled = false;
    expect(enabledSpecialties(s).map((x) => x.id)).toEqual([SYSTEM_ANALYST_SPECIALTY_ID]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/settings.test.ts`
Expected: FAIL — нет модуля `settings.js`.

- [ ] **Step 3: Implement**

`src/core/settings.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SearchQueryConfig } from './config.js';
import type { Skill, Specialty } from './specialty.js';
import {
  BA_DEFAULT_QUERIES, DEFAULT_STOP_WORDS, SYSTEM_ANALYST_DEFAULT_QUERIES,
  makeBaSpecialty, makeSystemAnalystSpecialty,
} from './specialty-defaults.js';

/**
 * Настройки поиска, которые человек правит в панели (спека 3.1): специальности
 * и стоп-слова. Лежат в data/ — вне git, рядом с queue.db. Техника, которую не
 * крутят каждый день (модели, пороги, паузы), остаётся в config.json.
 */
export interface Settings {
  version: 1;
  specialties: Specialty[];
  stopWords: string[];
}

export const SETTINGS_PATH = 'data/settings.json';

const MAX_EXPERIENCE_YEARS = 50;

type Result = { ok: true; settings: Settings } | { ok: false; error: string };

function cleanList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    const key = t.toLowerCase();
    if (t === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function nextId(prefix: string, taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const id = `${prefix}${n}`;
    if (!taken.has(id)) { taken.add(id); return id; }
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Проверяет и нормализует то, что пришло из панели или с диска. Пустые строки в
 * списках и пробелы по краям чистятся молча — это мусор от пустых полей формы,
 * а не ошибка человека. Всё остальное, что сделало бы поиск бессмысленным,
 * отклоняется с причиной по-русски: панель показывает её как есть.
 */
export function validateSettings(raw: unknown): Result {
  if (!isRecord(raw) || !Array.isArray(raw['specialties'])) {
    return { ok: false, error: 'настройки: ожидался объект со списком specialties' };
  }

  const takenSpecialtyIds = new Set<string>();
  for (const s of raw['specialties']) {
    if (isRecord(s) && typeof s['id'] === 'string' && s['id'].trim() !== '') takenSpecialtyIds.add(s['id'].trim());
  }

  const names = new Set<string>();
  const specialties: Specialty[] = [];

  for (const [i, s] of (raw['specialties'] as unknown[]).entries()) {
    const where = `специальность №${i + 1}`;
    if (!isRecord(s)) return { ok: false, error: `${where}: ожидался объект` };

    const name = typeof s['name'] === 'string' ? s['name'].trim() : '';
    if (name === '') return { ok: false, error: `${where}: пустое название` };
    const key = name.toLowerCase();
    if (names.has(key)) return { ok: false, error: `«${name}»: повтор названия` };
    names.add(key);

    const id = typeof s['id'] === 'string' && s['id'].trim() !== ''
      ? s['id'].trim()
      : nextId('s', takenSpecialtyIds);

    const titleWords = cleanList(s['titleWords']);
    if (titleWords.length === 0) {
      return { ok: false, error: `«${name}»: нужно хотя бы одно слово заголовка` };
    }

    const years = s['experienceYears'];
    if (typeof years !== 'number' || !Number.isInteger(years) || years < 0 || years > MAX_EXPERIENCE_YEARS) {
      return { ok: false, error: `«${name}»: опыт — целое число лет от 0 до ${MAX_EXPERIENCE_YEARS}` };
    }

    const resumeRaw = s['resumePdf'];
    const resumePdf = typeof resumeRaw === 'string' && resumeRaw.trim() !== '' ? resumeRaw.trim() : null;

    if (!Array.isArray(s['skills'])) return { ok: false, error: `«${name}»: ожидался список навыков` };
    const takenSkillIds = new Set<string>();
    for (const k of s['skills']) {
      if (isRecord(k) && typeof k['id'] === 'string' && k['id'].trim() !== '') takenSkillIds.add(k['id'].trim());
    }
    const skills: Skill[] = [];
    for (const [j, k] of (s['skills'] as unknown[]).entries()) {
      const at = `«${name}», навык №${j + 1}`;
      if (!isRecord(k)) return { ok: false, error: `${at}: ожидался объект` };
      const skillName = typeof k['name'] === 'string' ? k['name'].trim() : '';
      if (skillName === '') return { ok: false, error: `${at}: пустое название навыка` };
      const synonyms = cleanList(k['synonyms']);
      if (synonyms.length === 0) return { ok: false, error: `«${name}», «${skillName}»: нужен хотя бы один синоним` };
      const weight = k['weight'];
      if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 0 || weight > 100) {
        return { ok: false, error: `«${name}», «${skillName}»: вес — целое от 0 до 100` };
      }
      const skillId = typeof k['id'] === 'string' && k['id'].trim() !== ''
        ? k['id'].trim()
        : nextId('k', takenSkillIds);
      skills.push({ id: skillId, name: skillName, synonyms, weight, core: k['core'] === true });
    }

    specialties.push({
      id,
      name,
      enabled: s['enabled'] !== false,
      queries: cleanList(s['queries']),
      titleWords,
      skills,
      experienceYears: years,
      resumePdf,
      legacyLetters: s['legacyLetters'] === true,
    });
  }

  return { ok: true, settings: { version: 1, specialties, stopWords: cleanList(raw['stopWords']) } };
}

/**
 * Первый запуск: переносит то, что было в config.json и в коде. Фразы с
 * juniorOnly становятся «Системным аналитиком» с опытом 0, остальные —
 * «Бизнес-аналитиком» (спека 3.1).
 */
export function seedSettings(
  searchQueries: readonly SearchQueryConfig[] | undefined,
  baResumePdf: string | null,
): Settings {
  const baQueries = searchQueries === undefined
    ? BA_DEFAULT_QUERIES
    : searchQueries.filter((q) => q.constraints?.juniorOnly !== true).map((q) => q.query);
  const saQueries = searchQueries === undefined
    ? SYSTEM_ANALYST_DEFAULT_QUERIES
    : searchQueries.filter((q) => q.constraints?.juniorOnly === true).map((q) => q.query);
  return {
    version: 1,
    specialties: [
      makeBaSpecialty(baQueries, baResumePdf),
      makeSystemAnalystSpecialty(saQueries, baResumePdf),
    ],
    stopWords: [...DEFAULT_STOP_WORDS],
  };
}

function writeAtomic(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  // rename в пределах каталога атомарен и на NTFS: читатель видит либо
  // старый файл целиком, либо новый целиком, но не половину.
  renameSync(tmp, path);
}

export function loadSettings(path: string, seed: () => Settings): Settings {
  if (!existsSync(path)) {
    const seeded = seed();
    writeAtomic(path, seeded);
    return seeded;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    // Не пересеваем молча: пересев стёр бы настройки человека. Пусть он
    // увидит, что файл битый, и решит сам.
    throw new Error(`${path}: не читается как JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const r = validateSettings(raw);
  if (!r.ok) throw new Error(`${path}: ${r.error}`);
  return r.settings;
}

export function saveSettings(path: string, settings: unknown): Settings {
  const r = validateSettings(settings);
  if (!r.ok) throw new Error(r.error);
  writeAtomic(path, r.settings);
  return r.settings;
}

export function enabledSpecialties(s: Settings): Specialty[] {
  return s.specialties.filter((x) => x.enabled);
}
```

- [ ] **Step 4: config.json#searchQueries — необязателен**

В `src/core/config.ts`: у поля `searchQueries` в `Config` поставь `?` и допиши в комментарий «С 2026-09-18 читается только при засеве data/settings.json (core/settings.ts); поиск берёт фразы из настроек». В `loadConfig` блок

```ts
  if (!Array.isArray(parsed.searchQueries) || parsed.searchQueries.length === 0) {
    throw new Error('loadConfig: searchQueries обязателен и должен быть непустым списком');
  }
  for (const [i, qc] of parsed.searchQueries.entries()) {
```

замени на

```ts
  if (parsed.searchQueries !== undefined && !Array.isArray(parsed.searchQueries)) {
    throw new Error('loadConfig: searchQueries, если задан, должен быть списком');
  }
  for (const [i, qc] of (parsed.searchQueries ?? []).entries()) {
```

В `tests/config.test.ts` тест «бросает, если searchQueries отсутствует или пуст» замени на:

```ts
    it('searchQueries необязателен: фразы живут в data/settings.json', () => {
      const withoutQueries = withConfig({ minScore: 40, letterFullThreshold: 75, letterModels: ['m'], throttle: {} });
      expect(loadConfig(withoutQueries).searchQueries).toBeUndefined();
    });

    it('бросает, если searchQueries задан не списком', () => {
      const p = withConfig({ minScore: 40, letterFullThreshold: 75, letterModels: ['m'], searchQueries: 'бизнес', throttle: {} });
      expect(() => loadConfig(p)).toThrow('searchQueries');
    });
```



- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/settings.test.ts tests/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/settings.ts src/core/config.ts tests/settings.test.ts tests/config.test.ts
git commit -m "feat: data/settings.json with specialties and stop-words, seeded from config"
```

---

### Task 5: Конвейер и очередь на специальностях

**Files:**
- Modify: `src/pipeline.ts`, `src/core/queue.ts`, `src/cli.ts`, `src/ui/panel.html:367-375`, `tests/pipeline.test.ts`, `tests/queue.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: `Specialty`, `DEFAULT_SPECIALTY`, `BA_SPECIALTY_ID`, `DEFAULT_STOP_WORDS` (Task 2), `screenVacancy`, `ScreeningProfile` (Task 3), `Settings`, `enabledSpecialties`, `loadSettings`, `seedSettings`, `SETTINGS_PATH` (Task 4).
- Produces:
  - `pipeline.ts`: `interface SearchQuery { query: string; specialty?: Specialty }`; `RunSearchOptions.queries: SearchQuery[]`; `RunSearchOptions.stopWords?: readonly string[]` (по умолчанию `DEFAULT_STOP_WORDS`); `generate: (v, matched, mode, specialty: Specialty) => Promise<{ letter; mode }>`.
  - `SearchReport`: удалены `rejectedPlatform`, `rejectedNotAnalyst`, `rejectedJuniorOnly`; добавлены `rejectedStopword: number`, `stopwordHits: Record<string, number>`, `rejectedTitle: number`.
  - `Queue.insertPending(v, score, matched, letter, letterMode, specialty = BA_SPECIALTY_ID)`; `QueueRow.specialty: string`.
  - `cli.ts`: `buildSearchQueries(settings: Settings, args: readonly string[]): SearchQuery[]` — без аргументов: фразы всех включённых специальностей; с аргументами: одна фраза, специальность из `--specialty "<название>"` или первая включённая. Бросает `Error`, если включённых нет или название не найдено.

- [ ] **Step 1: Queue — колонка specialty (тест)**

В `tests/queue.test.ts` добавь:

```ts
describe('Queue — специальность строки', () => {
  it('insertPending пишет специальность, по умолчанию — бизнес-аналитик', () => {
    const q = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-q-sp-')), 't.db'));
    q.insertPending(mkVacancy('1'), 50, [], 'п', 'hybrid');
    q.insertPending(mkVacancy('2'), 50, [], 'п', 'full', 'product-manager');
    const rows = q.listByStatus('pending');
    expect(rows.find((r) => r.sourceId === '1')!.specialty).toBe('business-analyst');
    expect(rows.find((r) => r.sourceId === '2')!.specialty).toBe('product-manager');
    q.close();
  });
});
```

(`mkVacancy` — хелпер вакансии, уже объявленный в начале tests/queue.test.ts.)

Run: `npx vitest run tests/queue.test.ts` — Expected: FAIL (`specialty` undefined).

- [ ] **Step 2: Queue — реализация**

В `src/core/queue.ts`:
- импорт `import { BA_SPECIALTY_ID } from './specialty-defaults.js';`
- в `QueueRow` поле `specialty: string;` с комментарием «id специальности из data/settings.json; у строк до 2026-09-18 — бизнес-аналитик»;
- в `DbRow` поле `specialty: string | null;`
- в конструкторе после миграции `skip_archived_at`:

```ts
    try {
      this.db.exec('ALTER TABLE applications ADD COLUMN specialty TEXT');
    } catch {
      // колонка уже есть
    }
```

- `insertPending` — последний параметр `specialty: string = BA_SPECIALTY_ID`, в INSERT колонку `specialty` и значение;
- в `toQueueRow`: `specialty: r.specialty ?? BA_SPECIALTY_ID,`.

Run: `npx vitest run tests/queue.test.ts` — Expected: PASS.

- [ ] **Step 3: Pipeline — тесты**

В `tests/pipeline.test.ts`:
- замени все `rep.rejectedPlatform` на `rep.rejectedStopword`, `rep.rejectedNotAnalyst` на `rep.rejectedTitle`;
- тесты с `constraints: { juniorOnly: true }` переведи на специальность с опытом 0: `queries: [{ query: 'системный аналитик', specialty: { ...DEFAULT_SPECIALTY, experienceYears: 0 } }]`, ожидания `rejectedJuniorOnly` → `rejectedExperience` (опыт) или `rejectedGrade` («Старший» в заголовке) — по тому, что именно отсекает конкретный тест;
- добавь импорт `import { DEFAULT_SPECIALTY } from '../src/core/specialty-defaults.js'; import type { Specialty } from '../src/core/specialty.js';`
- добавь тесты:

```ts
describe('runSearch — специальности', () => {
  const PM: Specialty = {
    ...DEFAULT_SPECIALTY,
    id: 'product-manager', name: 'Менеджер продукта', legacyLetters: false,
    titleWords: ['менеджер продукта', 'product manager'],
    skills: [{ id: 'roadmap', name: 'Роадмап', synonyms: ['роадмап'], weight: 30, core: true }],
  };

  function titled(title: string, description: string): Adapter {
    return {
      name: 'hh',
      async search() {
        return [normalizeVacancy({
          source: 'hh', sourceId: title, title, company: 'C', url: 'u', description,
          geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
        })];
      },
      async apply() { return { status: 'sent' }; },
    };
  }

  it('вакансию оценивает специальность её фразы: навыки, слова заголовка, id в очереди', async () => {
    const seen: string[] = [];
    const rep = await runSearch({
      queue: q, config: CONFIG, queries: [{ query: 'product manager', specialty: PM }],
      adapters: [titled('Менеджер продукта', 'Ведём роадмап')],
      generate: async (_v, matched, mode, specialty) => {
        seen.push(`${specialty.id}:${matched.join()}:${mode}`);
        return { letter: 'письмо', mode };
      },
    });
    expect(rep.queued).toBe(1);
    // не legacyLetters — письмо всегда целиком (спека 3.7)
    expect(seen).toEqual(['product-manager:roadmap:full']);
    expect(q.listByStatus('pending')[0]!.specialty).toBe('product-manager');
  });

  it('стоп-слова из опций, причина считается по слову', async () => {
    const rep = await runSearch({
      queue: q, config: CONFIG, queries: [{ query: 'аналитик' }], stopWords: ['вахта'],
      adapters: [titled('Бизнес-аналитик, вахта', PROCESS_LANGUAGE)],
      generate: async () => ({ letter: 'п', mode: 'hybrid' as const }),
    });
    expect(rep.rejectedStopword).toBe(1);
    expect(rep.stopwordHits).toEqual({ вахта: 1 });
  });

  it('адаптер получает стаж специальности в experienceYears', async () => {
    let got: number | undefined;
    const spy: Adapter = {
      name: 'hh',
      async search(f: SearchFilters) { got = f.experienceYears; return []; },
      async apply() { return { status: 'sent' }; },
    };
    await runSearch({
      queue: q, config: CONFIG,
      queries: [{ query: 'системный аналитик', specialty: { ...DEFAULT_SPECIALTY, experienceYears: 0 } }],
      adapters: [spy], generate: async () => ({ letter: '', mode: 'none' as const }),
    });
    expect(got).toBe(0);
  });
});
```

Run: `npx vitest run tests/pipeline.test.ts` — Expected: FAIL (нет `rejectedStopword`, `generate` не получает специальность).

- [ ] **Step 4: Pipeline — реализация**

В `src/pipeline.ts`:

1. Импорты: убери `SearchQueryConfig` и `isJuniorExperience, isAboveJuniorTitle`; добавь

```ts
import type { Specialty } from './core/specialty.js';
import { DEFAULT_SPECIALTY, DEFAULT_STOP_WORDS } from './core/specialty-defaults.js';
```

2. Перед `SearchReport`:

```ts
/**
 * Одна фраза поиска и специальность, от имени которой она ищет. Специальность
 * решает, как вакансию оценивать: навыки и веса, слова заголовка, стаж
 * (спека 3.2). Без неё — бизнес-аналитик, как до 2026-09-18.
 */
export interface SearchQuery {
  query: string;
  specialty?: Specialty;
}
```

3. В `SearchReport` удали `rejectedPlatform`, `rejectedNotAnalyst`, `rejectedJuniorOnly` (с комментариями) и добавь:

```ts
  /** Сработало стоп-слово из настроек (спека 3.5). Раньше — rejectedPlatform для 1С/Битрикса. */
  rejectedStopword: number;
  /** Какое стоп-слово сколько раз сработало — отчёт называет слово, а не «платформу». */
  stopwordHits: Record<string, number>;
  /** Заголовок не называет специальность (слова заголовка). Раньше — rejectedNotAnalyst. */
  rejectedTitle: number;
```

В комментарии к `rejectedExperience`/`rejectedGrade` допиши: с 2026-09-18 сюда же попадает то, что раньше считалось `rejectedJuniorOnly` (опыт 0 у специальности).

4. `RunSearchOptions`: `queries: SearchQuery[];`, новое поле

```ts
  /** Стоп-слова из настроек. undefined — прежние 1С и Битрикс. */
  stopWords?: readonly string[];
```

и сигнатура `generate`:

```ts
  generate: (v: Vacancy, matched: string[], mode: LetterMode, specialty: Specialty)
    => Promise<{ letter: string; mode: LetterMode }>;
```

5. В `runSearch`: инициализацию `report` замени на

```ts
  const report: SearchReport = {
    found: 0, queued: 0, duplicates: 0, belowThreshold: 0, noCoreMatch: 0,
    rejectedExperience: 0, rejectedGrade: 0, rejectedStopword: 0, stopwordHits: {},
    rejectedTitle: 0, rejectedInternship: 0,
    adapterErrors: [], stoppedBecause: 'exhausted',
  };
  const stopWords = opts.stopWords ?? DEFAULT_STOP_WORDS;
```

`interface Task` — поле `qc: SearchQuery;`. В вызове `adapter.search` добавь `experienceYears: (task.qc.specialty ?? DEFAULT_SPECIALTY).experienceYears,`.

6. Тело цикла по вакансиям — от `const key = vacancyKey(v);` до конца — замени на:

```ts
      const key = vacancyKey(v);
      if (seenThisRun.has(key)) { report.duplicates++; continue; }
      seenThisRun.add(key);

      if (opts.queue.has(v)) { report.duplicates++; continue; }

      const specialty = task.qc.specialty ?? DEFAULT_SPECIALTY;
      const screen = screenVacancy(v, {
        titleWords: specialty.titleWords,
        experienceYears: specialty.experienceYears,
        stopWords,
      });
      if (!screen.passed) {
        // Каждая причина — своей строкой: ссыпать их в одну кучу значило бы
        // врать в отчёте.
        if (screen.reason === 'experience') report.rejectedExperience++;
        else if (screen.reason === 'grade') report.rejectedGrade++;
        else if (screen.reason === 'not_title') report.rejectedTitle++;
        else if (screen.reason === 'internship') report.rejectedInternship++;
        else {
          report.rejectedStopword++;
          const word = screen.stopWord ?? '?';
          report.stopwordHits[word] = (report.stopwordHits[word] ?? 0) + 1;
        }
        continue;
      }

      const { score, matched, hasCoreMatch } = scoreVacancy(v, specialty.skills);
      if (score < opts.config.minScore) { report.belowThreshold++; continue; }
      if (!hasCoreMatch) { report.noCoreMatch++; continue; }

      // Скелеты писем и выбор hybrid/full — только у засеянных специальностей
      // (legacyLetters). У остальных скелетов нет, письмо пишется целиком
      // (спека 3.7).
      const mode = specialty.legacyLetters ? pickMode(score, opts.config.letterFullThreshold) : 'full';
      const { letter, mode: usedMode } = await opts.generate(v, matched, mode, specialty);

      if (opts.queue.insertPending(v, score, matched, letter, usedMode, specialty.id)) {
        report.queued++;
        deliveredByQuery[task.queryIndex]!++;
      } else {
        report.duplicates++;
      }
```

Обнови шапочный комментарий `runSearch` (порядок фильтров: дедуп → screening по профилю специальности → scoring навыками специальности → generate).

Run: `npx vitest run tests/pipeline.test.ts` — Expected: PASS.

- [ ] **Step 5: CLI — тесты**

В `tests/cli.test.ts`:
- `BASE_REPORT`: `rejectedPlatform: 0` → `rejectedStopword: 0, stopwordHits: {}`, `rejectedNotAnalyst: 0` → `rejectedTitle: 0`, убери `rejectedJuniorOnly`;
- тесты `resolveSearchQueries` замени тестами `buildSearchQueries`:

```ts
import { seedSettings } from '../src/core/settings.js';

describe('buildSearchQueries', () => {
  const settings = seedSettings([
    { query: 'бизнес-аналитик' },
    { query: 'системный аналитик', constraints: { juniorOnly: true } },
  ], null);

  it('без аргументов — фразы всех включённых специальностей, каждая со своей специальностью', () => {
    const qs = buildSearchQueries(settings, []);
    expect(qs.map((q) => `${q.specialty!.id}:${q.query}`)).toEqual([
      'business-analyst:бизнес-аналитик', 'system-analyst:системный аналитик',
    ]);
  });

  it('выключенная специальность не ищет', () => {
    const s = structuredClone(settings);
    s.specialties[1]!.enabled = false;
    expect(buildSearchQueries(s, []).map((q) => q.query)).toEqual(['бизнес-аналитик']);
  });

  it('явная фраза — от первой включённой специальности', () => {
    const [q] = buildSearchQueries(settings, ['аналитик', 'данных']);
    expect(q).toMatchObject({ query: 'аналитик данных' });
    expect(q!.specialty!.id).toBe('business-analyst');
  });

  it('--specialty выбирает специальность по названию без учёта регистра', () => {
    const [q] = buildSearchQueries(settings, ['sa', '--specialty', 'системный АНАЛИТИК']);
    expect(q!.query).toBe('sa');
    expect(q!.specialty!.id).toBe('system-analyst');
  });

  it('неизвестная специальность и «нет включённых» — ошибки с объяснением', () => {
    expect(() => buildSearchQueries(settings, ['x', '--specialty', 'повар'])).toThrow(/повар/);
    const off = structuredClone(settings);
    for (const s of off.specialties) s.enabled = false;
    expect(() => buildSearchQueries(off, [])).toThrow(/включ/);
  });
});
```

- тест `formatSearchReport` про фильтры: ожидай строку `Отсеяно (стоп-слова):   2 (1С: 1, Битрикс: 1)` при `rejectedStopword: 2, stopwordHits: { '1С': 1, 'Битрикс': 1 }` и строку `Отсеяно (заголовок):    N` вместо «не аналитик».

Run: `npx vitest run tests/cli.test.ts` — Expected: FAIL.

- [ ] **Step 6: CLI — реализация**

В `src/cli.ts`:

1. Импорты: `import { runSearch, type SearchReport, type SearchQuery } from './pipeline.js';`, `import { loadSettings, seedSettings, enabledSpecialties, SETTINGS_PATH, type Settings } from './core/settings.js';`, `import type { Specialty } from './core/specialty.js';`. Убери `SearchQueryConfig` из импорта config.

2. `resolveSearchQueries` удали, вместо него:

```ts
/**
 * Фразы поиска из настроек (спека 3.2). Без аргументов — фразы всех
 * включённых специальностей, каждая со своей специальностью. С аргументами —
 * одна фраза для быстрой проверки; от чьего имени она ищет, задаёт
 * `--specialty "<название>"`, иначе первая включённая.
 */
export function buildSearchQueries(settings: Settings, args: readonly string[]): SearchQuery[] {
  const enabled = enabledSpecialties(settings);
  if (enabled.length === 0) {
    throw new Error('Нет включённых специальностей — включи хотя бы одну во вкладке «Настройки».');
  }

  const i = args.indexOf('--specialty');
  const wanted = i === -1 ? undefined : args[i + 1];
  const words = args.filter((_, j) => j !== i && j !== i + 1);
  const text = words.join(' ').trim();

  let specialty: Specialty = enabled[0]!;
  if (wanted !== undefined) {
    const found = settings.specialties.find((s) => s.name.toLowerCase() === wanted.trim().toLowerCase());
    if (found === undefined) {
      throw new Error(`Специальность «${wanted}» не найдена. Есть: ${settings.specialties.map((s) => s.name).join(', ')}`);
    }
    specialty = found;
  }

  if (text === '') {
    const from = wanted === undefined ? enabled : [specialty];
    return from.flatMap((s) => s.queries.map((query) => ({ query, specialty: s })));
  }
  return [{ query: text, specialty }];
}
```

`formatQueryLabel` — тип параметра `readonly SearchQuery[]`.

3. `formatSearchReport`: строки платформы и «не аналитик» замени на

```ts
  const hits = Object.entries(report.stopwordHits).map(([w, n]) => `${w}: ${n}`).join(', ');
  lines.push(`Отсеяно (стоп-слова):   ${report.rejectedStopword}${hits === '' ? '' : ` (${hits})`}`);
  lines.push(`Отсеяно (заголовок):    ${report.rejectedTitle}`);
```

4. `SearchCommandDeps`: `queries: SearchQuery[];` и новое поле `stopWords: readonly string[];`. В `runSearchCommand` передай `stopWords: deps.stopWords` в `runSearch`, а `generate` прими четвёртым аргументом `specialty` (использование — в Task 6; пока просто прокинь его и не используй).

5. В `main()` для `panel` и `search`: настройки загружаются так —

```ts
    const settings = loadSettings(SETTINGS_PATH, () => seedSettings(config.searchQueries, defaultBaResumePdf()));
```

где рядом с `RESUME_PATH` объяви

```ts
/**
 * PDF резюме БА для засева настроек (спека 3.7). Путь владельца; если файла
 * нет — null, и в панели поле останется пустым.
 */
function defaultBaResumePdf(): string | null {
  const p = join(homedir(), 'OneDrive', 'Рабочий стол', 'Резюме', 'CV_кандидат_Бизнес-аналитик.pdf');
  return existsSync(p) ? p : null;
}
```

(импорты `join` из `node:path`, `homedir` из `node:os`, `existsSync` из `node:fs`). В `search`: `const queries = buildSearchQueries(settings, rest.filter((a, i) => a !== '--limit' && rest[i - 1] !== '--limit'));` и `stopWords: settings.stopWords`. В `panel` поиск запускается так: `startSearch: (limit) => { const s = loadSettings(SETTINGS_PATH, …тот же засев…); return runSearchCommand({ …, queries: buildSearchQueries(s, []), stopWords: s.stopWords, … }); }` — настройки читаются на каждый запуск (снимок на старте, спека 3.1). Сообщение справки в конце `main()` допиши: `search [запрос] [--specialty "название"]`.

6. `src/ui/panel.html`, строки со сводкой отсева в `pollSearch`:

```js
      const rejected = (r.rejectedExperience ?? 0) + (r.rejectedGrade ?? 0)
        + (r.rejectedStopword ?? 0) + (r.rejectedTitle ?? 0) + (r.rejectedInternship ?? 0);
      if (rejected) parts.push(`отсеяно фильтрами ${rejected}`);
      const hits = Object.entries(r.stopwordHits ?? {}).map(([w, n]) => `${w} ${n}`).join(', ');
      if (hits) parts.push(`стоп-слова: ${hits}`);
```

- [ ] **Step 7: Run all tests + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: всё PASS, tsc без ошибок. Если tsc ругается на `scripts/*.ts`, использующие удалённые функции — поправь импорт там же на новые (`isExperienceWithin`, `findStopWord`).

- [ ] **Step 8: Commit**

```bash
git add src/pipeline.ts src/core/queue.ts src/cli.ts src/ui/panel.html tests/pipeline.test.ts tests/queue.test.ts tests/cli.test.ts
git commit -m "feat: search runs per specialty from settings, stop-words named in the report"
```

---

### Task 6: Общий вызов OpenRouter и письма по специальности

**Files:**
- Create: `src/core/openrouter.ts`, `tests/openrouter.test.ts`
- Modify: `src/core/letter.ts`, `src/cli.ts` (generate, fillEmptyLetters), `tests/letter.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: `Specialty` (Task 2), `createProxiedFetch` (`src/core/proxy.ts`), `describeHttpFailure` (letter.ts — переезжает в openrouter.ts, из letter.ts реэкспортируется).
- Produces:
  - `openrouter.ts`: `interface ChatMessage { role: 'system' | 'user'; content: string }`; `interface CompletionOptions { models: string[]; attemptsPerModel?: number; timeoutMs?: number; fetchImpl?: typeof fetch }`; `complete(messages: ChatMessage[], options: CompletionOptions, reject?: (text: string) => string | null): Promise<{ ok: true; text: string; model: string } | { ok: false; failure: string }>`; `describeHttpFailure`, `isProxyBlockPage` (переехали).
  - `letter.ts`: `LetterInput.role?: string` — название специальности для инструкции; `undefined` — прежний текст «вакансии бизнес-аналитика».
  - `cli.ts`: `SearchCommandDeps.resumeFor: (specialty: Specialty) => string` и `FillLettersDeps.resumeFor` + `FillLettersDeps.specialtyById: (id: string) => Specialty` вместо поля `resume`.

- [ ] **Step 1: Write the failing test**

`tests/openrouter.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { complete } from '../src/core/openrouter.js';

const KEY = process.env['OPENROUTER_API_KEY'];
afterEach(() => {
  if (KEY === undefined) delete process.env['OPENROUTER_API_KEY'];
  else process.env['OPENROUTER_API_KEY'] = KEY;
});

function reply(text: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status });
}

describe('complete', () => {
  it('без ключа — отказ с объяснением, в сеть не ходит', async () => {
    delete process.env['OPENROUTER_API_KEY'];
    let calls = 0;
    const r = await complete([{ role: 'user', content: 'x' }], {
      models: ['m'], fetchImpl: async () => { calls++; return reply('ok'); },
    });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.failure).toMatch(/OPENROUTER_API_KEY/);
    expect(calls).toBe(0);
  });

  it('отвергнутый ответ — пробует дальше, первый принятый возвращается с моделью', async () => {
    process.env['OPENROUTER_API_KEY'] = 'k';
    const texts = ['плохо', 'хорошо'];
    const r = await complete([{ role: 'user', content: 'x' }], {
      models: ['a', 'b'], attemptsPerModel: 1,
      fetchImpl: async () => reply(texts.shift()!),
    }, (t) => (t === 'плохо' ? 'не годится' : null));
    expect(r).toEqual({ ok: true, text: 'хорошо', model: 'b' });
  });

  it('все модели провалились — последняя причина с именем модели', async () => {
    process.env['OPENROUTER_API_KEY'] = 'k';
    const r = await complete([{ role: 'user', content: 'x' }], {
      models: ['a'], attemptsPerModel: 1, fetchImpl: async () => new Response('', { status: 429 }),
    });
    expect(!r.ok && r.failure).toMatch(/^a: лимит запросов/);
  });
});
```

Run: `npx vitest run tests/openrouter.test.ts` — Expected: FAIL (нет модуля).

- [ ] **Step 2: Implement openrouter.ts**

`src/core/openrouter.ts` — перенос цикла из `generateLetter` без изменения поведения:

```ts
import { createProxiedFetch } from './proxy.js';

/**
 * Один вызов OpenRouter с перебором моделей. Вынесено из letter.ts
 * 2026-09-18: кроме писем модель теперь зовут «Предложить навыки»
 * (core/suggest.ts), а дальше — личные сообщения рекрутёрам. Логика перебора,
 * таймаутов и причин отказа — та же, что была у писем, и держится в одном
 * месте, чтобы не разойтись.
 */

export interface ChatMessage { role: 'system' | 'user'; content: string }

export interface CompletionOptions {
  /** Модели OpenRouter, в порядке попытки. */
  models: string[];
  /** Попыток на модель, по умолчанию 3 — `openrouter/free` каждый раз выбирает новую модель. */
  attemptsPerModel?: number;
  /** Потолок на попытку, мс, по умолчанию 90 000: бесплатные модели умеют висеть минутами. */
  timeoutMs?: number;
  /** Подмена fetch для тестов. По умолчанию — через прокси, найденный в момент запроса. */
  fetchImpl?: typeof fetch;
}

export type CompletionResult =
  | { ok: true; text: string; model: string }
  | { ok: false; failure: string };

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const proxiedFetch = createProxiedFetch();
```

Затем перенеси из `letter.ts` дословно (вместе с их комментариями) `extractText`, `isProxyBlockPage`, `describeHttpFailure` и добавь `export` к последним двум. После них:

```ts
/**
 * Пробует модели по порядку, каждую — `attemptsPerModel` раз. `reject`
 * возвращает причину, по которой ответ негоден, или null: негодный ответ —
 * такая же неудача, как HTTP-ошибка, и перебор идёт дальше. Не бросает
 * никогда: любой сбой превращается в `{ ok: false, failure }` с последней
 * причиной — её показывают человеку.
 */
export async function complete(
  messages: ChatMessage[],
  options: CompletionOptions,
  reject: (text: string) => string | null = () => null,
): Promise<CompletionResult> {
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) {
    return { ok: false, failure: 'OPENROUTER_API_KEY не найден — положи ключ в .env рядом с package.json' };
  }

  let failure = 'ни одна модель из letterModels не ответила пригодным текстом';
  const fetchImpl = options.fetchImpl ?? proxiedFetch;
  const attempts = options.attemptsPerModel ?? 3;
  const timeoutMs = options.timeoutMs ?? 90_000;

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
        if (text === undefined) {
          failure = `${model}: ответ без текста`;
          continue;
        }
        const why = reject(text);
        if (why !== null) {
          failure = `${model}: ${why}`;
          continue;
        }
        return { ok: true, text, model };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failure = `${model}: ${msg.includes('timeout') || msg.includes('aborted')
          ? `модель не ответила за ${timeoutMs / 1000} с`
          : msg.slice(0, 160)}`;
      }
    }
  }
  return { ok: false, failure };
}
```

- [ ] **Step 3: generateLetter поверх complete**

В `src/core/letter.ts`:
- удали `OPENROUTER_URL`, `extractText`, `proxiedFetch`, тела `isProxyBlockPage`/`describeHttpFailure` и импорт `createProxiedFetch`; добавь
  `import { complete, type CompletionOptions } from './openrouter.js';` и `export { describeHttpFailure, isProxyBlockPage } from './openrouter.js';`
- `GenerateLetterOptions` замени на `export type GenerateLetterOptions = CompletionOptions;`
- тело `generateLetter`:

```ts
export async function generateLetter(
  input: LetterInput,
  options: GenerateLetterOptions,
): Promise<{ letter: string; mode: LetterMode; failure?: string }> {
  const r = await complete(buildPrompt(input).messages, options, (text) =>
    // Внешне правдоподобное письмо бывает бесполезным: вырезанные вставки,
    // испорченный скелет, выдуманный факт. Такой ответ — неудача, пробуем
    // следующую модель (см. isUsableLetter).
    isUsableLetter(text, input)
      ? null
      : 'письмо не прошло проверку (вырезаны вставки, испорчен скелет или выдуман факт)');
  return r.ok ? { letter: r.text, mode: input.mode } : { ...EMPTY_RESULT, failure: r.failure };
}
```

- `LetterInput` — поле

```ts
  /**
   * Название специальности для инструкции модели. undefined — «вакансии
   * бизнес-аналитика», как до 2026-09-18: у засеянных специальностей промпт
   * не меняется ни на символ.
   */
  role?: string;
```

- `INSTRUCTION_HYBRID` и `INSTRUCTION_FULL` превращаются в функции `instructionHybrid(role?: string)` и `instructionFull(role?: string)`, первая строка каждой:

```ts
const roleLine = (role?: string): string => (role === undefined
  ? 'Ты помогаешь кандидату откликаться на вакансии бизнес-аналитика.'
  : `Ты помогаешь кандидату откликаться на вакансии по специальности «${role}».`);
```

  остальной текст инструкций — без изменений. В `buildPrompt`: `const instruction = input.mode === 'full' ? instructionFull(input.role) : instructionHybrid(input.role);`

Run: `npx vitest run tests/letter.test.ts tests/openrouter.test.ts`
Expected: PASS. Если какой-то тест letter.test.ts проверял дословную строку причины «ответ без текста письма» — это единственное изменение текста; поправь ожидание на «ответ без текста».

Добавь в `tests/letter.test.ts`:

```ts
describe('buildPrompt — специальность', () => {
  it('без role — прежняя первая строка про бизнес-аналитика', () => {
    const p = buildPrompt({ vacancy: mk(), matched: [], mode: 'full', resume: RESUME, template: '' });
    expect(p.messages[0].content).toMatch(/^Ты помогаешь кандидату откликаться на вакансии бизнес-аналитика\./);
  });

  it('с role — специальность в инструкции', () => {
    const p = buildPrompt({ vacancy: mk(), matched: [], mode: 'full', resume: RESUME, template: '', role: 'Менеджер продукта' });
    expect(p.messages[0].content).toContain('по специальности «Менеджер продукта»');
    expect(p.messages[0].content).not.toContain('бизнес-аналитика.');
  });
});
```

- [ ] **Step 4: CLI — письма по специальности**

В `src/cli.ts`:
- `SearchCommandDeps.resume: string` замени на `resumeFor: (specialty: Specialty) => string;`
- `generate` в `runSearchCommand`:

```ts
    generate: async (v, matched, mode, specialty) => {
      // Скелеты — только у засеянных специальностей (legacyLetters); остальным
      // конвейер уже выставил mode 'full', и скелет модели не показывается.
      const template = specialty.legacyLetters ? deps.readTemplate(deps.pickTemplateFn(v, matched)) : '';
      const result = await deps.generateLetterFn(
        {
          vacancy: v, matched, mode, template,
          resume: deps.resumeFor(specialty),
          role: specialty.legacyLetters ? undefined : specialty.name,
        },
        { models: deps.config.letterModels },
      );
      if (result.mode === 'none') {
        emptyLetters++;
        letterFailure = result.failure ?? letterFailure;
      }
      return result;
    },
```

- `FillLettersDeps.resume` замени на `resumeFor: (specialty: Specialty) => string; specialtyById: (id: string) => Specialty;`. В цикле `fillEmptyLetters`:

```ts
    const specialty = deps.specialtyById(row.specialty);
    const mode = specialty.legacyLetters ? pickMode(row.score, deps.config.letterFullThreshold) : 'full';
    const template = specialty.legacyLetters ? deps.readTemplate(deps.pickTemplateFn(row.vacancy, row.matched)) : '';
    const result = await deps.generateLetterFn(
      {
        vacancy: row.vacancy, matched: row.matched, mode, template,
        resume: deps.resumeFor(specialty),
        role: specialty.legacyLetters ? undefined : specialty.name,
      },
      { models: deps.config.letterModels },
    );
```

- В `main()` пока (до Task 7) `resumeFor: () => readFileSync(RESUME_PATH, 'utf8')` и `specialtyById: (id) => settings.specialties.find((s) => s.id === id) ?? DEFAULT_SPECIALTY` (импорт `DEFAULT_SPECIALTY`). Специальность удалена из настроек — письмо дописывается как для БА.
- `tests/cli.test.ts`: там, где тесты передают `resume: 'R'`, передай `resumeFor: () => 'R'` и для `fillEmptyLetters` ещё `specialtyById: () => DEFAULT_SPECIALTY`.

Run: `npx vitest run && npx tsc --noEmit`
Expected: всё PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/openrouter.ts src/core/letter.ts src/cli.ts tests/openrouter.test.ts tests/letter.test.ts tests/cli.test.ts
git commit -m "refactor: one OpenRouter caller; letters name the specialty they apply for"
```

---

### Task 7: Резюме из PDF

**Files:**
- Create: `src/core/resume.ts`, `tests/resume.test.ts`, `tests/fixtures/resume-sample.pdf`
- Modify: `package.json` (зависимость `unpdf`), `src/cli.ts` (resumeFor)

**Interfaces:**
- Consumes: `Specialty` (Task 2).
- Produces:
  - `LEGACY_RESUME_MD = 'CV кандидат Бизнес-аналитик.md'`, `RESUME_CACHE_DIR = 'data/resumes'`
  - `extractPdfText(path: string): Promise<string>`
  - `refreshResumeCache(specialty: Specialty, cacheDir?: string): Promise<{ ok: true; chars: number } | { ok: false; error: string }>` — извлекает текст, если кеша нет или PDF новее кеша.
  - `resumeTextFor(specialty: Specialty, opts?: { cacheDir?: string; legacyMdPath?: string }): string` — `legacyLetters` → `.md`; есть кеш → он; иначе `.md` БА.

- [ ] **Step 1: Зависимость и фикстура**

```bash
npm install unpdf@1.8.1
```

Фикстура — небольшой PDF с кириллицей, собранный Chromium'ом (без личных данных):

```bash
node -e "
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.setContent('<meta charset=utf-8><h1>Иван Тестов, менеджер продукта</h1><p>Роадмап, метрики, CJM. Пять лет в финтехе.</p>');
  await p.pdf({ path: 'tests/fixtures/resume-sample.pdf', format: 'A4' });
  await b.close();
})();
"
```

- [ ] **Step 2: Write the failing test**

`tests/resume.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractPdfText, refreshResumeCache, resumeTextFor } from '../src/core/resume.js';
import { DEFAULT_SPECIALTY } from '../src/core/specialty-defaults.js';
import type { Specialty } from '../src/core/specialty.js';

const PDF = 'tests/fixtures/resume-sample.pdf';

function pm(resumePdf: string | null): Specialty {
  return { ...DEFAULT_SPECIALTY, id: 'pm', name: 'Менеджер продукта', legacyLetters: false, resumePdf };
}

describe('extractPdfText', () => {
  it('достаёт кириллицу из PDF', async () => {
    const text = await extractPdfText(PDF);
    expect(text).toContain('менеджер продукта');
    expect(text).toContain('Роадмап');
  });

  it('несуществующий файл — ошибка с путём', async () => {
    await expect(extractPdfText('нет/такого.pdf')).rejects.toThrow('нет/такого.pdf');
  });
});

describe('refreshResumeCache + resumeTextFor', () => {
  it('кеш создаётся, и письма берут текст из него', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaa-cv-'));
    const r = await refreshResumeCache(pm(PDF), dir);
    expect(r.ok && r.chars).toBeGreaterThan(20);
    expect(resumeTextFor(pm(PDF), { cacheDir: dir })).toContain('Роадмап');
  });

  it('кеш свежее PDF — повторно не извлекает', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaa-cv-'));
    await refreshResumeCache(pm(PDF), dir);
    const cache = join(dir, 'pm.txt');
    writeFileSync(cache, 'ПОМЕТКА', 'utf8');
    const future = new Date(Date.now() + 60_000);
    utimesSync(cache, future, future);
    await refreshResumeCache(pm(PDF), dir);
    expect(readFileSync(cache, 'utf8')).toBe('ПОМЕТКА');
  });

  it('битый путь — отказ с причиной, кеш не создаётся', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaa-cv-'));
    const r = await refreshResumeCache(pm('нет.pdf'), dir);
    expect(r.ok).toBe(false);
    expect(existsSync(join(dir, 'pm.txt'))).toBe(false);
  });

  it('legacyLetters — всегда .md БА, даже если PDF задан', () => {
    const md = join(mkdtempSync(join(tmpdir(), 'jaa-md-')), 'cv.md');
    writeFileSync(md, 'РЕЗЮМЕ БА', 'utf8');
    expect(resumeTextFor({ ...DEFAULT_SPECIALTY, resumePdf: PDF }, { legacyMdPath: md })).toBe('РЕЗЮМЕ БА');
  });

  it('PDF не задан или кеша нет — .md БА', () => {
    const md = join(mkdtempSync(join(tmpdir(), 'jaa-md-')), 'cv.md');
    writeFileSync(md, 'РЕЗЮМЕ БА', 'utf8');
    const empty = mkdtempSync(join(tmpdir(), 'jaa-cv-'));
    expect(resumeTextFor(pm(null), { legacyMdPath: md, cacheDir: empty })).toBe('РЕЗЮМЕ БА');
    expect(resumeTextFor(pm(PDF), { legacyMdPath: md, cacheDir: empty })).toBe('РЕЗЮМЕ БА');
  });
});
```

Run: `npx vitest run tests/resume.test.ts` — Expected: FAIL (нет модуля).

- [ ] **Step 3: Implement**

`src/core/resume.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractText, getDocumentProxy } from 'unpdf';
import type { Specialty } from './specialty.js';

/**
 * Текст резюме, по которому пишутся письма специальности (спека 3.7).
 *
 * У специальности есть PDF — он уходит вложением в Telegram, и из него же
 * извлекается текст для писем. Извлечение небыстрое, поэтому текст кешируется
 * в data/resumes/<id>.txt и обновляется, только когда PDF новее кеша.
 *
 * Засеянные специальности (legacyLetters) пишут по прежнему .md: письма БА не
 * должны поменяться от того, что текст теперь можно брать из PDF.
 */

export const LEGACY_RESUME_MD = 'CV кандидат Бизнес-аналитик.md';
export const RESUME_CACHE_DIR = 'data/resumes';

export async function extractPdfText(path: string): Promise<string> {
  let data: Uint8Array;
  try {
    data = new Uint8Array(readFileSync(path));
  } catch (e) {
    throw new Error(`${path}: не читается (${e instanceof Error ? e.message : String(e)})`);
  }
  // verbosity 0: pdf.js иначе сыплет в консоль «TT: undefined function» на
  // шрифтах, собранных генератором резюме, — шум, а не ошибка.
  const pdf = await getDocumentProxy(data, { verbosity: 0 });
  const { text } = await extractText(pdf, { mergePages: true });
  return text.trim();
}

function cachePath(specialty: Specialty, cacheDir: string): string {
  return join(cacheDir, `${specialty.id}.txt`);
}

export async function refreshResumeCache(
  specialty: Specialty,
  cacheDir: string = RESUME_CACHE_DIR,
): Promise<{ ok: true; chars: number } | { ok: false; error: string }> {
  if (specialty.resumePdf === null) return { ok: true, chars: 0 };
  const target = cachePath(specialty, cacheDir);
  try {
    if (existsSync(target) && statSync(target).mtimeMs >= statSync(specialty.resumePdf).mtimeMs) {
      return { ok: true, chars: readFileSync(target, 'utf8').length };
    }
    const text = await extractPdfText(specialty.resumePdf);
    if (text.length < 20) {
      return { ok: false, error: `${specialty.resumePdf}: текста почти нет — похоже, PDF из картинок` };
    }
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(target, text, 'utf8');
    return { ok: true, chars: text.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function resumeTextFor(
  specialty: Specialty,
  opts: { cacheDir?: string; legacyMdPath?: string } = {},
): string {
  const legacy = opts.legacyMdPath ?? LEGACY_RESUME_MD;
  if (specialty.legacyLetters || specialty.resumePdf === null) return readFileSync(legacy, 'utf8');
  const cached = cachePath(specialty, opts.cacheDir ?? RESUME_CACHE_DIR);
  // Кеша нет — резюме БА, как у специальности без PDF (спека 3.7). Поиск
  // перед стартом зовёт refreshResumeCache, так что сюда попадает только
  // PDF, который не извлёкся; панель об этом уже сказала при сохранении.
  return existsSync(cached) ? readFileSync(cached, 'utf8') : readFileSync(legacy, 'utf8');
}
```

Если `getDocumentProxy` в установленной версии `unpdf` не принимает второй аргумент (проверь `node_modules/unpdf/dist/index.d.ts`), убери `{ verbosity: 0 }` — это только шум в консоли.

- [ ] **Step 4: CLI**

В `src/cli.ts`: `RESUME_PATH` удали, вместо `readFileSync(RESUME_PATH, 'utf8')` везде — `resumeFor: (s) => resumeTextFor(s)`. Перед `runSearchCommand` в `search` и в `startSearch` панели:

```ts
      for (const s of enabledSpecialties(settings)) {
        const r = await refreshResumeCache(s);
        if (!r.ok) console.error(`Резюме «${s.name}» не извлеклось (${r.error}) — письма пойдут по резюме БА.`);
      }
```

Run: `npx vitest run && npx tsc --noEmit` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/core/resume.ts src/cli.ts tests/resume.test.ts tests/fixtures/resume-sample.pdf
git commit -m "feat: each specialty writes letters from its own PDF resume"
```

---

### Task 8: «Предложить» и ручки настроек в панели

**Files:**
- Create: `src/core/suggest.ts`, `tests/suggest.test.ts`
- Modify: `src/ui/server.ts`, `src/cli.ts` (проводка), `tests/ui-server.test.ts`

**Interfaces:**
- Consumes: `complete`, `ChatMessage` (Task 6), `Settings`, `saveSettings`, `loadSettings` (Task 4), `refreshResumeCache`, `extractPdfText`, `resumeTextFor` (Task 7).
- Produces:
  - `suggest.ts`: `interface SpecialtySuggestion { titleWords: string[]; skills: Array<{ name: string; synonyms: string[]; weight: number; core: boolean }> }`; `buildSuggestMessages(name: string, resume: string): ChatMessage[]`; `parseSuggestion(text: string): SpecialtySuggestion | null`; `suggestSpecialty(name: string, resume: string, options: CompletionOptions): Promise<{ ok: true; suggestion: SpecialtySuggestion } | { ok: false; error: string }>`.
  - `PanelDeps.settings?: { get(): Settings; save(raw: unknown): Promise<{ ok: true; settings: Settings } | { ok: false; error: string }>; suggest(name: string, resumePdf: string | null): Promise<{ ok: true; suggestion: SpecialtySuggestion } | { ok: false; error: string }> }`
  - Ручки: `GET /api/settings` → `200 Settings` или `409 {error}` без зависимости; `POST /api/settings` → `200 {ok, settings}` | `400 {error}`; `POST /api/settings/suggest {name, resumePdf}` → `200 {suggestion}` | `400/502 {error}`.

- [ ] **Step 1: Write the failing tests (suggest)**

`tests/suggest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSuggestMessages, parseSuggestion } from '../src/core/suggest.js';

describe('parseSuggestion', () => {
  const good = {
    titleWords: ['менеджер продукта', 'product manager'],
    skills: [
      { name: 'Роадмап', synonyms: ['роадмап', 'roadmap'], weight: 25, core: true },
      { name: 'Метрики', synonyms: ['метрик*'], weight: 10, core: false },
    ],
  };

  it('читает JSON и в ограде ```json', () => {
    expect(parseSuggestion(JSON.stringify(good))).toEqual(good);
    expect(parseSuggestion('Вот:\n```json\n' + JSON.stringify(good) + '\n```')).toEqual(good);
  });

  it('вес приводится к целому 0–100, пустые синонимы выкидываются', () => {
    const r = parseSuggestion(JSON.stringify({
      titleWords: ['x'],
      skills: [{ name: 'A', synonyms: ['a', ' '], weight: 140.6, core: 'да' }],
    }));
    expect(r!.skills[0]).toEqual({ name: 'A', synonyms: ['a'], weight: 100, core: false });
  });

  it.each([
    ['не JSON', 'просто текст'],
    ['без слов заголовка', JSON.stringify({ titleWords: [], skills: good.skills })],
    ['без навыков', JSON.stringify({ titleWords: ['x'], skills: [] })],
  ])('null: %s', (_l, text) => expect(parseSuggestion(text)).toBeNull());
});

describe('buildSuggestMessages', () => {
  it('в промпте название специальности, резюме и формат ответа', () => {
    const [system, user] = buildSuggestMessages('Менеджер продукта', 'РЕЗЮМЕ');
    expect(system!.content).toContain('titleWords');
    expect(system!.content).toContain('Правила совпадения');
    expect(user!.content).toContain('Менеджер продукта');
    expect(user!.content).toContain('РЕЗЮМЕ');
  });
});
```

Run: `npx vitest run tests/suggest.test.ts` — Expected: FAIL (нет модуля).

- [ ] **Step 2: Implement suggest.ts**

`src/core/suggest.ts`:

```ts
import { complete, type ChatMessage, type CompletionOptions } from './openrouter.js';

/**
 * «Предложить» (спека 3.3): один вызов модели заполняет слова заголовка и
 * навыки новой специальности по резюме. Ответ подставляется в форму
 * НЕсохранённым — человек правит и сохраняет сам, так что ошибка модели
 * стоит одной правки, а не испорченного поиска.
 */

export interface SpecialtySuggestion {
  titleWords: string[];
  skills: Array<{ name: string; synonyms: string[]; weight: number; core: boolean }>;
}

const SYSTEM = `Ты настраиваешь фильтр вакансий для соискателя. По названию специальности и резюме
верни JSON строго такого вида, без пояснений:
{"titleWords": ["..."], "skills": [{"name": "...", "synonyms": ["..."], "weight": 0, "core": false}]}

titleWords — 2–5 слов или коротких фраз, которые стоят в ЗАГОЛОВКЕ подходящей вакансии
(по-русски и по-английски). Вакансия без них в заголовке будет отброшена.

skills — 6–10 навыков, по которым вакансию оценивают. Для каждого:
- synonyms — как навык пишут в текстах вакансий, 1–6 вариантов;
- weight — целое 1–30: насколько навык отличает эту специальность; сумма всех весов около 110;
- core — true у 1–3 навыков, без которых вакансия точно не про эту специальность.
Опирайся на резюме: навыки, которых у человека нет, не делай ядром.

Правила совпадения, под которые пишутся синонимы:
- регистр не важен; слово ищется с начала слова: «регламент» найдёт «регламенты»;
- русское слово от 5 букв само теряет окончание: «процессная модель» найдёт «процессной модели»;
- аббревиатура заглавными и слова до 3 букв ищутся только целиком: «SQL», «CJM»;
- «*» в конце — любые буквы дальше: «метрик*»;
- дефис во фразе ищется как дефис: «бизнес-процесс» не найдёт «бизнес процесс», дай оба.`;

export function buildSuggestMessages(name: string, resume: string): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Специальность: ${name}\n\n=== РЕЗЮМЕ ===\n${resume}` },
  ];
}

function strings(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x !== '')
    : [];
}

export function parseSuggestion(text: string): SpecialtySuggestion | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const titleWords = strings(obj['titleWords']);
  const skills: SpecialtySuggestion['skills'] = [];
  for (const k of Array.isArray(obj['skills']) ? obj['skills'] : []) {
    if (typeof k !== 'object' || k === null) continue;
    const s = k as Record<string, unknown>;
    const name = typeof s['name'] === 'string' ? s['name'].trim() : '';
    const synonyms = strings(s['synonyms']);
    const w = typeof s['weight'] === 'number' && Number.isFinite(s['weight']) ? Math.round(s['weight']) : 0;
    if (name === '' || synonyms.length === 0) continue;
    skills.push({ name, synonyms, weight: Math.max(0, Math.min(100, w)), core: s['core'] === true });
  }
  if (titleWords.length === 0 || skills.length === 0) return null;
  return { titleWords, skills };
}

export async function suggestSpecialty(
  name: string,
  resume: string,
  options: CompletionOptions,
): Promise<{ ok: true; suggestion: SpecialtySuggestion } | { ok: false; error: string }> {
  let parsed: SpecialtySuggestion | null = null;
  const r = await complete(buildSuggestMessages(name, resume), options, (text) => {
    parsed = parseSuggestion(text);
    return parsed === null ? 'ответ не похож на JSON с titleWords и skills' : null;
  });
  if (!r.ok || parsed === null) return { ok: false, error: r.ok ? 'пустой ответ' : r.failure };
  return { ok: true, suggestion: parsed };
}
```

Run: `npx vitest run tests/suggest.test.ts` — Expected: PASS.

- [ ] **Step 3: Write the failing tests (server)**

В `tests/ui-server.test.ts` добавь:

```ts
import { seedSettings, validateSettings, type Settings } from '../src/core/settings.js';

describe('панель — настройки', () => {
  let stored: Settings;
  let settingsPanel: { port: number; close(): Promise<void> };
  const suggestCalls: string[] = [];

  beforeEach(async () => {
    stored = seedSettings(undefined, null);
    settingsPanel = await startPanel(q, 0, {
      settings: {
        get: () => stored,
        save: async (raw) => {
          const r = validateSettings(raw);
          if (r.ok) stored = r.settings;
          return r;
        },
        suggest: async (name) => {
          suggestCalls.push(name);
          return name === 'сбой'
            ? { ok: false, error: 'VPN выключен' }
            : { ok: true, suggestion: { titleWords: ['x'], skills: [{ name: 'A', synonyms: ['a'], weight: 10, core: true }] } };
        },
      },
    });
  });
  afterEach(async () => { await settingsPanel.close(); });

  const url = (p: string) => `http://127.0.0.1:${settingsPanel.port}${p}`;

  it('GET /api/settings отдаёт настройки', async () => {
    const body = await (await fetch(url('/api/settings'))).json() as Settings;
    expect(body.specialties[0]!.name).toBe('Бизнес-аналитик');
  });

  it('POST /api/settings сохраняет правку веса', async () => {
    const next = structuredClone(stored);
    next.specialties[0]!.skills[0]!.weight = 30;
    const res = await post(url('/api/settings'), next);
    expect(res.status).toBe(200);
    expect(stored.specialties[0]!.skills[0]!.weight).toBe(30);
  });

  it('плохие настройки — 400 с причиной, сохранённое не меняется', async () => {
    const bad = structuredClone(stored);
    bad.specialties[0]!.name = '';
    const res = await post(url('/api/settings'), bad);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/название/);
    expect(stored.specialties[0]!.name).toBe('Бизнес-аналитик');
  });

  it('POST /api/settings/suggest — предложение или 502 с причиной', async () => {
    const ok = await post(url('/api/settings/suggest'), { name: 'Менеджер продукта', resumePdf: null });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { suggestion: { titleWords: string[] } }).suggestion.titleWords).toEqual(['x']);
    const fail = await post(url('/api/settings/suggest'), { name: 'сбой', resumePdf: null });
    expect(fail.status).toBe(502);
    expect((await fail.json() as { error: string }).error).toBe('VPN выключен');
  });

  it('suggest без названия — 400, модель не зовётся', async () => {
    const before = suggestCalls.length;
    const res = await post(url('/api/settings/suggest'), { name: '  ' });
    expect(res.status).toBe(400);
    expect(suggestCalls.length).toBe(before);
  });
});

describe('панель без настроек', () => {
  it('GET /api/settings — 409, а не падение', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/settings`);
    expect(res.status).toBe(409);
  });
});
```

Run: `npx vitest run tests/ui-server.test.ts` — Expected: FAIL.

- [ ] **Step 4: Implement server routes**

В `src/ui/server.ts`:
- импорты `import type { Settings } from '../core/settings.js'; import type { SpecialtySuggestion } from '../core/suggest.js';`
- в `PanelDeps`:

```ts
  /**
   * Вкладка «Настройки» (спека 3.8). Чтение, сохранение с проверкой и
   * «Предложить». Собирается в cli.ts: там знают путь файла, резюме и модели.
   * Без неё вкладка показывает «недоступно».
   */
  settings?: {
    get(): Settings;
    save(raw: unknown): Promise<{ ok: true; settings: Settings } | { ok: false; error: string }>;
    suggest(name: string, resumePdf: string | null)
      : Promise<{ ok: true; suggestion: SpecialtySuggestion } | { ok: false; error: string }>;
  };
```

- ручки перед `GET /`:

```ts
      if (req.url === '/api/settings' || req.url === '/api/settings/suggest') {
        if (!deps.settings) {
          return json(res, { error: 'Панель запущена без настроек — открой её через npm run panel.' }, 409);
        }
        if (req.method === 'GET' && req.url === '/api/settings') {
          return json(res, deps.settings.get());
        }
        if (req.method === 'POST' && req.url === '/api/settings') {
          const r = await deps.settings.save(await readJson(req));
          return r.ok ? json(res, { ok: true, settings: r.settings }) : json(res, { error: r.error }, 400);
        }
        if (req.method === 'POST' && req.url === '/api/settings/suggest') {
          const b = await readJson(req);
          const name = typeof b['name'] === 'string' ? b['name'].trim() : '';
          if (name === '') return json(res, { error: 'Сначала впиши название специальности.' }, 400);
          const pdf = typeof b['resumePdf'] === 'string' && b['resumePdf'].trim() !== '' ? b['resumePdf'].trim() : null;
          const r = await deps.settings.suggest(name, pdf);
          return r.ok ? json(res, { suggestion: r.suggestion }) : json(res, { error: r.error }, 502);
        }
      }
```

- [ ] **Step 5: Проводка в cli.ts**

В `main()` ветки `panel` передай в `startPanel`:

```ts
        settings: {
          get: () => loadSettings(SETTINGS_PATH, seed),
          save: async (raw) => {
            const checked = validateSettings(raw);
            if (!checked.ok) return checked;
            // PDF проверяется до записи: сохранённая специальность с битым
            // резюме молча писала бы письма по резюме БА (спека 3.8).
            for (const s of checked.settings.specialties) {
              const r = await refreshResumeCache(s);
              if (!r.ok) return { ok: false, error: `«${s.name}»: резюме не читается — ${r.error}` };
            }
            try {
              return { ok: true, settings: saveSettings(SETTINGS_PATH, checked.settings) };
            } catch (e) {
              return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
          },
          suggest: async (name, resumePdf) => {
            let resume: string;
            try {
              resume = resumePdf === null ? readFileSync(LEGACY_RESUME_MD, 'utf8') : await extractPdfText(resumePdf);
            } catch (e) {
              return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
            const r = await suggestSpecialty(name, resume, { models: config.letterModels });
            return r.ok ? r : { ok: false, error: r.error };
          },
        },
```

где `const seed = () => seedSettings(config.searchQueries, defaultBaResumePdf());` объявлен один раз в ветке. Импорты: `validateSettings, saveSettings` из settings, `extractPdfText, LEGACY_RESUME_MD` из resume, `suggestSpecialty` из suggest.

Run: `npx vitest run && npx tsc --noEmit` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/suggest.ts src/ui/server.ts src/cli.ts tests/suggest.test.ts tests/ui-server.test.ts
git commit -m "feat: settings API for the panel, and a model that drafts a new specialty"
```

---

### Task 9: Вкладка «Настройки»

**Files:**
- Modify: `src/ui/panel.html`, `tests/panel-browser.test.ts`

**Interfaces:**
- Consumes: ручки Task 8.
- Produces: вкладка `#tab-settings` / `#pane-settings`; кнопка `#settingsSave`; карточка специальности `.spec` с полями `[data-f="name|enabled|queries|titleWords|experienceYears|resumePdf"]`, строками навыков `.skill` с полями `[data-k="name|synonyms|weight|core"]`, кнопками `.add-skill`, `.del-skill`, `.suggest`, `.del-spec`; `#addSpec`; поле `#stopWords`; строка статуса `#settingsNote`.

- [ ] **Step 1: Write the failing browser test**

В `tests/panel-browser.test.ts` добавь. `browser`, `page` и `q` там уже создаются общими beforeAll/beforeEach (строки 72–95), новый describe поднимает только свою панель:

```ts
import { seedSettings, validateSettings, type Settings } from '../src/core/settings.js';

describe('вкладка «Настройки» в настоящем браузере', () => {
  let stored: Settings;
  let sp: { port: number; close(): Promise<void> };

  beforeEach(async () => {
    stored = seedSettings(undefined, null);
    sp = await startPanel(q, 0, {
      settings: {
        get: () => stored,
        save: async (raw) => { const r = validateSettings(raw); if (r.ok) stored = r.settings; return r; },
        suggest: async () => ({
          ok: true,
          suggestion: { titleWords: ['менеджер продукта'], skills: [{ name: 'Роадмап', synonyms: ['роадмап'], weight: 25, core: true }] },
        }),
      },
    });
  });
  afterEach(async () => { await sp.close(); });

  it('правка веса навыка сохраняется', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    const weight = page.locator('.spec').first().locator('.skill').first().locator('[data-k="weight"]');
    await weight.fill('30');
    await page.click('#settingsSave');
    await expect.poll(() => stored.specialties[0]!.skills[0]!.weight).toBe(30);
    await expect.poll(() => page.textContent('#settingsNote')).toMatch(/Сохранено/);
  });

  it('стоп-слово добавляется через поле списка', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await page.fill('#stopWords', '1С\nБитрикс\nBitrix\nвахта');
    await page.click('#settingsSave');
    await expect.poll(() => stored.stopWords).toEqual(['1С', 'Битрикс', 'Bitrix', 'вахта']);
  });

  it('новая специальность: «Предложить» заполняет, сохранение с названием', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await page.click('#addSpec');
    const card = page.locator('.spec').last();
    await card.locator('[data-f="name"]').fill('Менеджер продукта');
    await card.locator('.suggest').click();
    await expect.poll(() => card.locator('.skill [data-k="name"]').first().inputValue()).toBe('Роадмап');
    await page.click('#settingsSave');
    await expect.poll(() => stored.specialties.map((s) => s.name)).toContain('Менеджер продукта');
    expect(stored.specialties.at(-1)!.legacyLetters).toBe(false);
  });

  it('ошибка проверки показывается человеку, а не глотается', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await page.locator('.spec').first().locator('[data-f="name"]').fill('');
    await page.click('#settingsSave');
    await expect.poll(() => page.textContent('#settingsNote')).toMatch(/название/);
  });
});
```

Run: `npx vitest run tests/panel-browser.test.ts` — Expected: FAIL (нет вкладки).

- [ ] **Step 2: Разметка вкладки**

В `src/ui/panel.html`:
- в `<nav>` после «Отменённые»:

```html
      <button class="tab" role="tab" id="tab-settings" aria-selected="false" aria-controls="pane-settings">Настройки</button>
```

- после `#pane-skipped`:

```html
  <section id="pane-settings" role="tabpanel" aria-labelledby="tab-settings" hidden>
    <div class="actions">
      <button id="settingsSave">Сохранить</button>
      <button id="addSpec">Добавить специальность</button>
      <span class="hint" id="settingsNote">Правка действует со следующего поиска.</span>
    </div>
    <div id="specList"></div>
    <div class="card slim settings-block">
      <label for="stopWords"><strong>Стоп-слова</strong>
        <span class="hint">по одному в строке. Отсекают вакансию, если слово в заголовке или 2+ раза в описании.</span></label>
      <textarea id="stopWords" rows="5"></textarea>
    </div>
  </section>
```

- в `<style>`:

```css
    .spec { background: #fff; margin: 16px 20px; padding: 16px; border: 1px solid #ddd; border-radius: 8px; }
    .spec .row { display: grid; grid-template-columns: 170px 1fr; gap: 8px; align-items: start; margin-bottom: 8px; }
    .spec .row > label { font-size: 13px; color: #555; padding-top: 5px; }
    .spec input[type=text], .spec input[type=number] { font: inherit; font-size: 14px; padding: 4px 6px; border: 1px solid #ccc; border-radius: 4px; }
    .spec textarea { min-height: 60px; font: 13px/1.4 system-ui, sans-serif; }
    .skills { width: 100%; border-collapse: collapse; font-size: 13px; }
    .skills th { text-align: left; font-weight: 500; color: #666; padding: 4px; }
    .skills td { padding: 3px 4px; vertical-align: top; }
    .skills input[data-k="synonyms"] { width: 100%; }
    .skills input[data-k="weight"] { width: 64px; }
    .settings-block { display: block; }
    .settings-block textarea { min-height: 110px; margin-top: 6px; }
```

- `const TABS = ['pending', 'approved', 'skipped', 'settings'];` — вкладка из адреса уже восстанавливается строкой `showTab(TABS.includes(location.hash.slice(1)) ? …)`, так что `#settings` заработает сам.

- [ ] **Step 3: Скрипт вкладки**

В конец `<script>` (перед его закрытием):

```js
// ============================================================================
// Настройки (спека 3.8). Форма — это просто отражение data/settings.json:
// рисуется из GET /api/settings, собирается обратно целиком и уходит одним
// POST. Проверку делает сервер; его причина показывается как есть.
// ============================================================================

let settingsLoaded = null;

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function lines(text) {
  return text.split('\n').map((s) => s.trim()).filter((s) => s !== '');
}

function skillRow(k) {
  return `<tr class="skill" data-id="${esc(k.id ?? '')}">
    <td><input type="text" data-k="name" value="${esc(k.name)}"></td>
    <td><input type="text" data-k="synonyms" value="${esc(k.synonyms.join(', '))}"></td>
    <td><input type="number" data-k="weight" min="0" max="100" step="1" value="${k.weight}"></td>
    <td><input type="checkbox" data-k="core" ${k.core ? 'checked' : ''}></td>
    <td><button class="del-skill" title="Удалить навык">×</button></td>
  </tr>`;
}

function specCard(s) {
  const el = document.createElement('div');
  el.className = 'spec';
  el.dataset.id = s.id ?? '';
  el.dataset.legacy = String(s.legacyLetters === true);
  el.innerHTML = `
    <div class="row"><label>Название</label>
      <div><input type="text" data-f="name" value="${esc(s.name)}" size="32">
        <label><input type="checkbox" data-f="enabled" ${s.enabled ? 'checked' : ''}> искать</label>
        <button class="del-spec">Удалить специальность</button></div></div>
    <div class="row"><label>Фразы поиска<br><span class="hint">по одной в строке</span></label>
      <textarea data-f="queries">${esc(s.queries.join('\n'))}</textarea></div>
    <div class="row"><label>Слова заголовка<br><span class="hint">через запятую</span></label>
      <input type="text" data-f="titleWords" value="${esc(s.titleWords.join(', '))}"></div>
    <div class="row"><label>Мой опыт, лет</label>
      <input type="number" data-f="experienceYears" min="0" max="50" step="1" value="${s.experienceYears}"></div>
    <div class="row"><label>Резюме (PDF)<br><span class="hint">полный путь к файлу</span></label>
      <input type="text" data-f="resumePdf" value="${esc(s.resumePdf ?? '')}"></div>
    <div class="row"><label>Навыки<br><span class="hint">синонимы через запятую; вес 0–100; «ядро» — без него вакансия отсекается</span></label>
      <div>
        <table class="skills"><thead><tr><th>Навык</th><th>Синонимы</th><th>Вес</th><th>Ядро</th><th></th></tr></thead>
          <tbody>${s.skills.map(skillRow).join('')}</tbody></table>
        <button class="add-skill">Добавить навык</button>
        <button class="suggest">Предложить</button>
        <span class="hint suggest-note"></span>
      </div></div>`;

  el.querySelector('.add-skill').onclick = () => {
    el.querySelector('tbody').insertAdjacentHTML('beforeend', skillRow({ name: '', synonyms: [], weight: 10, core: false }));
  };
  el.querySelector('.del-spec').onclick = () => {
    if (confirm('Удалить специальность «' + el.querySelector('[data-f="name"]').value + '»? Сохранение — отдельной кнопкой.')) el.remove();
  };
  el.addEventListener('click', (e) => {
    if (e.target.classList.contains('del-skill')) e.target.closest('tr').remove();
  });
  el.querySelector('.suggest').onclick = async () => {
    const note = el.querySelector('.suggest-note');
    note.textContent = 'Модель думает…';
    const res = await post('/api/settings/suggest', {
      name: el.querySelector('[data-f="name"]').value,
      resumePdf: el.querySelector('[data-f="resumePdf"]').value,
    });
    const body = await res.json();
    if (!res.ok) { note.textContent = 'Не вышло: ' + body.error; return; }
    el.querySelector('[data-f="titleWords"]').value = body.suggestion.titleWords.join(', ');
    el.querySelector('tbody').innerHTML = body.suggestion.skills.map(skillRow).join('');
    note.textContent = 'Заполнено, но не сохранено — поправь и нажми «Сохранить».';
  };
  return el;
}

function renderSettings(s) {
  settingsLoaded = s;
  const list = document.getElementById('specList');
  list.innerHTML = '';
  for (const spec of s.specialties) list.appendChild(specCard(spec));
  document.getElementById('stopWords').value = s.stopWords.join('\n');
}

function collectSettings() {
  const specialties = [...document.querySelectorAll('#specList .spec')].map((el) => {
    const f = (name) => el.querySelector(`[data-f="${name}"]`);
    return {
      id: el.dataset.id || undefined,
      name: f('name').value,
      enabled: f('enabled').checked,
      queries: lines(f('queries').value),
      titleWords: f('titleWords').value.split(',').map((x) => x.trim()).filter(Boolean),
      experienceYears: Number(f('experienceYears').value),
      resumePdf: f('resumePdf').value.trim() || null,
      legacyLetters: el.dataset.legacy === 'true',
      skills: [...el.querySelectorAll('.skill')].map((tr) => ({
        id: tr.dataset.id || undefined,
        name: tr.querySelector('[data-k="name"]').value,
        synonyms: tr.querySelector('[data-k="synonyms"]').value.split(',').map((x) => x.trim()).filter(Boolean),
        weight: Number(tr.querySelector('[data-k="weight"]').value),
        core: tr.querySelector('[data-k="core"]').checked,
      })),
    };
  });
  return { version: 1, specialties, stopWords: lines(document.getElementById('stopWords').value) };
}

async function loadSettings() {
  const note = document.getElementById('settingsNote');
  const res = await fetch('/api/settings');
  const body = await res.json();
  if (!res.ok) { note.textContent = body.error; return; }
  renderSettings(body);
}

document.getElementById('addSpec').onclick = () => {
  document.getElementById('specList').appendChild(specCard({
    name: '', enabled: true, queries: [], titleWords: [], skills: [], experienceYears: 1, resumePdf: null,
  }));
};

document.getElementById('settingsSave').onclick = async () => {
  const note = document.getElementById('settingsNote');
  note.textContent = 'Сохраняю…';
  const res = await post('/api/settings', collectSettings());
  const body = await res.json();
  if (!res.ok) { note.textContent = 'Не сохранено: ' + body.error; return; }
  renderSettings(body.settings);
  note.textContent = 'Сохранено. Действует со следующего поиска.';
};

loadSettings();
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/panel-browser.test.ts tests/panel-html.test.ts`
Expected: PASS.

- [ ] **Step 5: Живая проверка**

Запусти панель на временном порту с копией настроек (реальный `data/settings.json` не трогать):

```bash
npx tsx -e "import('./src/ui/server.ts').then(async ({startPanel}) => { const {Queue} = await import('./src/core/queue.ts'); const s = await import('./src/core/settings.ts'); let st = s.seedSettings(undefined, null); await startPanel(new Queue('data/_try.db'), 4399, { settings: { get: () => st, save: async (r) => { const v = s.validateSettings(r); if (v.ok) st = v.settings; return v; }, suggest: async () => ({ ok: false, error: 'проверка' }) } }); console.log('http://127.0.0.1:4399/#settings'); })"
```

Открой в браузере, проверь: карточки БА и системного аналитика, таблица навыков с весами 28/24/22…, сохранение, ошибка на пустом названии. Останови процесс, удали `data/_try.db`.

- [ ] **Step 6: Commit**

```bash
git add src/ui/panel.html tests/panel-browser.test.ts
git commit -m "feat: settings tab — specialties, skill weights, experience, stop-words"
```

---

### Task 10: Документация и навык /jobs

**Files:**
- Modify: `.claude/skills/jobs/SKILL.md`, `config.json` (комментарий нельзя — только если нужно убрать `searchQueries`: НЕ убирать, он нужен для засева), `docs/superpowers/specs/2026-08-27-job-autoapply-design.md` (одна строка)

- [ ] **Step 1: /jobs**

В `.claude/skills/jobs/SKILL.md`:
- в таблицу команд: `npm run search -- "фраза" --specialty "Менеджер продукта" --limit 6`;
- раздел «Фильтры отбора» переписать: что теперь в настройках (специальности: фразы, слова заголовка, навыки с весами и ядром, опыт в годах, PDF резюме; стоп-слова общим списком, правило «заголовок или 2+ в описании»), что осталось в коде (стажировки, lead/head/ведущий); `juniorOnly` больше нет — это «опыт 0» у специальности; настройки лежат в `data/settings.json`, правятся во вкладке «Настройки», засеваются из `config.json#searchQueries` один раз;
- в «Известные пробелы»: отклик на hh.ru уходит с резюме аккаунта hh, а не с PDF специальности (спека 10).

- [ ] **Step 2: Исходная спека**

В `docs/superpowers/specs/2026-08-27-job-autoapply-design.md`, раздел 5.2 `core/scorer.ts`, после абзаца про веса допиши:

```markdown
> 2026-09-18: веса и ключевики переехали в настройки специальности (`data/settings.json`), см. `2026-09-18-search-settings-telegram-autoapply-design.md`, раздел 3.
```

- [ ] **Step 3: Полный прогон**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, tsc чистый.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/jobs/SKILL.md docs/superpowers/specs/2026-08-27-job-autoapply-design.md
git commit -m "docs: the jobs skill and the original design know about specialties"
```
