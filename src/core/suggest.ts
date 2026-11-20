import { complete, type ChatMessage, type CompletionOptions } from './openrouter.js';
import { MAX_FILTER_SALARY } from './specialty.js';

/**
 * «Заполнить с ИИ» (спека 3.3, редизайн 2026-11-19): один вызов модели
 * заполняет по резюме всё, что из резюме выводится, — должность (если её не
 * вписали), поисковые запросы, слова заголовка, опыт, навыки и зарплату, если
 * она в резюме указана. Предпочтения (занятость, график, формат) модель не
 * трогает: из резюме их не вывести, это выбор человека. Ответ подставляется в
 * форму НЕсохранённым — человек правит и сохраняет сам, так что ошибка модели
 * стоит одной правки, а не испорченного поиска.
 */

export interface SpecialtySuggestion {
  /** Должность. null — модель не предложила; панель подставляет её, только если поле пустое. */
  name: string | null;
  /** Фразы для поиска на hh.ru; пусто — модель не предложила. */
  queries: string[];
  titleWords: string[];
  skills: Array<{ name: string; synonyms: string[]; weight: number; core: boolean }>;
  /** Целое 0–50; null — из резюме не понять. */
  experienceYears: number | null;
  /** Рубли в месяц, только если желаемая зарплата прямо указана в резюме. */
  salaryFrom: number | null;
}

const MAX_EXPERIENCE_YEARS = 50;

const SYSTEM = `Ты настраиваешь фильтр вакансий для соискателя. По названию специальности и резюме
верни JSON строго такого вида, без пояснений:
{"name": "...", "queries": ["..."], "titleWords": ["..."], "skills": [{"name": "...", "synonyms": ["..."], "weight": 0, "core": false}], "experienceYears": 0, "salaryFrom": null}

name — должность, которую человек ищет. Если специальность названа — верни это же название
без изменений. Если не названа — предложи должность по резюме, как её пишут в вакансиях
(«Бизнес-аналитик», «Менеджер продукта»).

queries — 2–5 фраз для поиска на hh.ru: так, как человек вбил бы их в строку поиска.

titleWords — 2–5 слов или коротких фраз, которые стоят в ЗАГОЛОВКЕ подходящей вакансии
(по-русски и по-английски). Вакансия без них в заголовке будет отброшена.

skills — 6–10 навыков, по которым вакансию оценивают. Для каждого:
- synonyms — как навык пишут в текстах вакансий, 1–6 вариантов;
- weight — целое 1–30: насколько навык отличает эту специальность; сумма всех весов около 110;
- core — true у 1–3 навыков, без которых вакансия точно не про эту специальность.
Опирайся на резюме: навыки, которых у человека нет, не делай ядром.

experienceYears — целое число лет опыта работы по этой специальности по резюме (0–50);
null, если из резюме не понять.

salaryFrom — желаемая зарплата в рублях в месяц, ТОЛЬКО если она прямо указана в резюме;
иначе null. Не угадывай по рынку.

Правила совпадения, под которые пишутся синонимы:
- регистр не важен; слово ищется с начала слова: «регламент» найдёт «регламенты»;
- русское слово от 5 букв само теряет окончание: «процессная модель» найдёт «процессной модели»;
- аббревиатура заглавными и слова до 3 букв ищутся только целиком: «SQL», «CJM»;
- «*» в конце — любые буквы дальше: «метрик*»;
- дефис во фразе ищется как дефис: «бизнес-процесс» не найдёт «бизнес процесс», дай оба.`;

export function buildSuggestMessages(name: string, resume: string): ChatMessage[] {
  const title = name.trim();
  const head = title === ''
    ? 'Специальность: не указана — предложи должность по резюме'
    : `Специальность: ${title}`;
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${head}\n\n=== РЕЗЮМЕ ===\n${resume}` },
  ];
}

function strings(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x !== '')
    : [];
}

/** Число из ответа модели: она пишет и 5, и "5", и "5 лет" — берём только чистое число. */
function numberOf(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && /^\s*\d+(?:[.,]\d+)?\s*$/.test(raw)) return Number(raw.replace(',', '.'));
  return null;
}

/**
 * titleWords и skills обязательны: без них ответ бесполезен. Остальное
 * необязательно — мусор в нём становится null / [], а не отказом всего ответа:
 * лишняя правка руками дешевле повторного вызова модели.
 */
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

  const nameRaw = typeof obj['name'] === 'string' ? obj['name'].trim() : '';
  const years = numberOf(obj['experienceYears']);
  const salary = numberOf(obj['salaryFrom']);
  const salaryFrom = salary === null ? null : Math.round(salary);
  return {
    name: nameRaw === '' ? null : nameRaw,
    queries: strings(obj['queries']),
    titleWords,
    skills,
    experienceYears: years === null ? null : Math.max(0, Math.min(MAX_EXPERIENCE_YEARS, Math.round(years))),
    // Сверх потолка валидации настроек — мусор (годовая сумма, копейки, опечатка):
    // подставленное в «От», оно сорвало бы сохранение всего фильтра.
    salaryFrom: salaryFrom !== null && salaryFrom > 0 && salaryFrom <= MAX_FILTER_SALARY ? salaryFrom : null,
  };
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
