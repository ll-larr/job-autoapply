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
