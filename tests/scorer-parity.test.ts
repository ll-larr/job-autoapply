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
