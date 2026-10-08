import { readFileSync } from 'node:fs';
import { normalizeVacancy } from '../src/core/vacancy.js';
import { loadConfig } from '../src/core/config.js';
import { scoreVacancy } from '../src/core/scorer.js';
import { generateLetter, readLetterTemplate } from '../src/core/letter.js';
import { loadSettings, seedSettings, SETTINGS_PATH } from '../src/core/settings.js';
import { applyLlmSettings } from '../src/core/llm.js';
import { setCandidateName } from '../src/core/profile.js';
import { refreshResumeCache, resumeTextFor } from '../src/core/resume.js';
import type { Specialty } from '../src/core/specialty.js';

/**
 * Живая проверка генерации письма: настоящая вакансия, настоящий скоринг,
 * настоящий вызов модели по цепочке из config.json и настроек.
 *
 * Скелет — templates/ai-llm-ba.md, режим один (hybrid). Резюме — то, что
 * прикреплено в настройках к специальности, как в самом приложении:
 * запасного resume.md нет. Ключ — из настроек панели или OPENROUTER_API_KEY,
 * нигде не печатается.
 *
 * Run: npx tsx scripts/try-letter.ts <файл_с_описанием_вакансии> [id_специальности]
 * Файл: первая строка — заголовок, вторая — компания, третья — город,
 * дальше текст вакансии. Специальность по умолчанию — первая включённая с резюме.
 */

const path = process.argv[2];
if (path === undefined) {
  console.error('Использование: npx tsx scripts/try-letter.ts <файл> [id_специальности]');
  process.exit(2);
}

const raw = readFileSync(path, 'utf8').split('\n');
const [title = '', company = '', geo = ''] = raw.map((l) => l.replace(/\r$/, ''));
const description = raw.slice(3).join('\n').trim();

const config = loadConfig();
const settings = loadSettings(SETTINGS_PATH, () => seedSettings(config.searchQueries, null));
applyLlmSettings(config, settings);
setCandidateName(settings.profile.name);

const wanted = process.argv[3];
const specialty: Specialty | undefined = wanted !== undefined
  ? settings.specialties.find((s) => s.id === wanted)
  : settings.specialties.find((s) => s.enabled && s.resumePdf !== null);
if (specialty === undefined) {
  console.error('Не нашёл специальность с прикреплённым резюме — добавь PDF в настройках.');
  process.exit(2);
}
const cache = await refreshResumeCache(specialty);
if (!cache.ok) {
  console.error(`Резюме «${specialty.name}» не читается: ${cache.error}`);
  process.exit(2);
}
const resume = resumeTextFor(specialty);

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

const { score, matched, hasCoreMatch } = scoreVacancy(vacancy, specialty.skills);

console.log(`Вакансия:   ${title} / ${company}`);
console.log(`Специальность: ${specialty.name} (резюме: ${specialty.resumePdf})`);
console.log(`Скор:       ${score}`);
console.log(`Совпало:    ${matched.join(', ') || '(ничего)'}`);
console.log(`Core-гейт:  ${hasCoreMatch ? 'ПРОШЛА' : 'ОТСЕЯНА (нет ни одного навыка-ядра)'}`);
console.log(`Модели:     ${config.letterModels.join(' -> ')}`);
console.log('');

const started = Date.now();
const result = await generateLetter(
  { vacancy, matched, resume, template: readLetterTemplate(), role: specialty.name },
  { models: config.letterModels },
);
const secs = ((Date.now() - started) / 1000).toFixed(1);

console.log(`Готово за ${secs}с, режим на выходе: ${result.mode}`);
console.log('='.repeat(72));
console.log(result.letter === '' ? `(письмо пустое — генерация не удалась: ${result.failure ?? 'причина не названа'})` : result.letter);
console.log('='.repeat(72));
