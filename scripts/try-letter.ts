import { readFileSync } from 'node:fs';
import { normalizeVacancy } from '../src/core/vacancy.js';
import { loadConfig } from '../src/core/config.js';
import { scoreVacancy } from '../src/core/scorer.js';
import { generateLetter, pickMode, pickTemplate } from '../src/core/letter.js';

/**
 * Живая проверка генерации письма: настоящая вакансия, настоящий скоринг,
 * настоящий вызов модели по бесплатной цепочке из config.json.
 *
 * Ключ берётся только из OPENROUTER_API_KEY и никуда не печатается.
 *
 * Run: npx tsx scripts/try-letter.ts <файл_с_описанием_вакансии>
 * Файл: первая строка — заголовок, вторая — компания, третья — город,
 * дальше текст вакансии.
 */

const path = process.argv[2];
if (path === undefined) {
  console.error('Использование: npx tsx scripts/try-letter.ts <файл>');
  process.exit(2);
}

const raw = readFileSync(path, 'utf8').split('\n');
const [title = '', company = '', geo = ''] = raw;
const description = raw.slice(3).join('\n').trim();

const config = loadConfig();
// Резюме лежит в корне проекта: пользователь положил актуальный .md туда
// 2026-08-30, чтобы у конвейера был один постоянный источник вместо
// вытаскивания текста из DOCX на рабочем столе.
const resume = readFileSync('CV кандидат Бизнес-аналитик.md', 'utf8');

const vacancy = normalizeVacancy({
  source: 'hh',
  sourceId: 'try',
  title,
  company,
  url: 'https://hh.ru/vacancy/try',
  description,
  geo,
  postedAt: new Date().toISOString(),
});

const { score, matched, hasCoreMatch } = scoreVacancy(vacancy);
const mode = pickMode(score, config.letterFullThreshold);
const templateName = pickTemplate(vacancy, matched);

console.log(`Вакансия:   ${title} / ${company}`);
console.log(`Скор:       ${score}`);
console.log(`Совпало:    ${matched.join(', ') || '(ничего)'}`);
console.log(`Core-гейт:  ${hasCoreMatch ? 'ПРОШЛА' : 'ОТСЕЯНА (процессной/требовательной лексики нет)'}`);
console.log(`Режим:      ${mode}`);
console.log(`Скелет:     ${templateName}`);
console.log(`Модели:     ${config.letterModels.join(' -> ')}`);
console.log(`Ключ:       ${process.env['OPENROUTER_API_KEY'] ? 'найден в окружении' : 'НЕ НАЙДЕН'}`);
console.log('');

const started = Date.now();
const result = await generateLetter(
  {
    vacancy,
    matched,
    mode,
    resume,
    template: readFileSync(`templates/${templateName}.md`, 'utf8'),
  },
  { models: config.letterModels },
);
const secs = ((Date.now() - started) / 1000).toFixed(1);

console.log(`Готово за ${secs}с, режим на выходе: ${result.mode}`);
console.log('='.repeat(72));
console.log(result.letter === '' ? '(письмо пустое — генерация не удалась)' : result.letter);
console.log('='.repeat(72));
