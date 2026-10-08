import { readFileSync } from 'node:fs';
import type { Vacancy } from './vacancy.js';
import { complete, type ChatMessage, type CompletionOptions } from './openrouter.js';
import { COMMON_WRITING_RULES, findForbiddenClaim } from './letter.js';

/**
 * Первое личное сообщение рекрутёру в Telegram (спека 2026-09-18, 5.1). Не
 * сопроводительное письмо: у рекрутёра десятки вакансий, поэтому в скелете
 * `templates/tg-dm.md` есть {{VACANCY}} — какая именно и ссылка на пост. Пишет
 * его не кандидат, а «HIRE! Agent» — ИИ агент, поэтому о кандидате говорится в
 * третьем лице. Часть правил письма здесь неверна («не начинай с вакансии»,
 * «не заканчивай „резюме прикреплено“») и не передаётся; запреты на выдумки и
 * обороты — общие.
 *
 * Модель пишет только строку для {{VACANCY}} и текст для {{FIT}}, а сообщение
 * собирает код. Живой прогон
 * 2026-10-08: когда модель возвращала всё сообщение целиком, скелет в 600
 * символов не дошёл дословно ни в одном из девяти ответов — «самые лучше»
 * исправлялось на «лучшие», дефис становился длинным тире, пропадали «!» и
 * эмодзи. Скелет — утверждённый человеком голос, поэтому его переписывает не
 * модель, а подстановка.
 */

export const DM_MAX_LENGTH = 1200;
export const DM_TEMPLATE_PATH = 'templates/tg-dm.md';

/** Короче этого на месте {{FIT}} — не предложение о вакансии, а обрывок. */
const MIN_FIT_LENGTH = 40;

export function readDmTemplate(path: string = DM_TEMPLATE_PATH): string {
  return readFileSync(path, 'utf8');
}

/**
 * Что встаёт вместо {{VACANCY}}, когда модель своего не дала: название
 * вакансии и ссылка на неё (у рекрутёра их много). Данные известны и без
 * модели.
 */
function vacancyRef(vacancy: Vacancy): string {
  return `${vacancy.title}: ${vacancy.url}`;
}

/**
 * Готовое сообщение: скелет дословно, вместо {{VACANCY}} название и ссылка
 * (строка модели `vacancyText`, а нет её — vacancyRef), вместо {{FIT}} текст
 * модели. Подстановка за один проход: текст, который встал на место одного
 * плейсхолдера, другим не разбирается. Нет {{VACANCY}} в скелете — вакансия и
 * ссылка идут первой строкой: сообщение без ссылки на пост проверку не пройдёт.
 */
export function assembleDm(template: string, fit: string, vacancy: Vacancy, vacancyText?: string): string {
  const body = template.trim().replace(/\{\{(VACANCY|FIT)\}\}/g, (_slot, name: string) =>
    name === 'VACANCY' ? (vacancyText ?? vacancyRef(vacancy)) : fit.trim());
  return template.includes('{{VACANCY}}')
    ? body
    : `Вакансия: ${vacancy.title}\nСсылка на пост: ${vacancy.url}\n\n${body}`;
}

/**
 * Сколько символов остаётся на {{FIT}}, чтобы всё сообщение уложилось в
 * DM_MAX_LENGTH: модель не умеет считать, а скелет занимает больше половины.
 */
export function fitLimit(template: string, vacancy: Vacancy): number {
  return Math.max(0, DM_MAX_LENGTH - assembleDm(template, '', vacancy).length);
}

/** system promp */
const INSTRUCTION = (role: string, template: string, fitChars: number): string => 
`Ты — ИИ агент кандидата, тебя зовут «HIRE! Agent»: ИИ агент, а не человек и не сам кандидат. 
Твоя задача - выходить на первый контакт с рекрутёрами, рассказывать про опыт кандидата, согласно фактам из его резюме.
Должность (специальность) кандидата, чье резюме ты используешь для ответа на вопросы - ${role.toLowerCase()}.
О кандидате говори только в третьем лице — «он»/«она» (в зависимости от имени кандидата), а не «я» и не «мой опыт».
С рекрутёром общайся на «ты», не «вы».
Резюме кандидата написано от первого лица — пересказывай его строго в третьем лице.
Имени рекрутёра ты не знаешь, поэтому здоровайся и обращайся к нему без имени.
При описании опыта кандидата оперируй конкретными проектами, инструментами и цифрами из резюме. Чего в резюме нет - не выдумывай, скажи «Этого не смог найти в резюме кандидата, лучше уточните у него сами».

Структура сообщения собрана в скелете "${template.trim()}". В скелете первого сообщения содержится плейсхолдер {{VACANCY}} и {{FIT}}. Вместо {{VACANCY}} напиши название вакансии и приложи ссылку на сообщение с вакансией. 
Вместо {{FIT}} напиши два-три предложения, связывающих опыт из резюме кандидата с конкретными требованиями вакансии. 
В {{FIT}} обязательно должна быть хотя бы одна конкретная опора из резюме: названный проект или инструмент, привязанный к тому, что вакансия реально просит.
Не выдумывай фактов, которых нет в резюме. Плейсхолдер обязательно должен быть ЗАМЕНЕН на живой текст.
Удалить его и вернуть скелет без него — это провал задачи, а не её решение: без {{FIT}} сообщение не содержит ни слова про конкретную вакансию, и весь смысл теряется.

Весь текст должен занимать не больше ${DM_MAX_LENGTH} символов.

Что именно ты возвращаешь: только название вакансии с ссылкой на нее вместо плейсхолдера {{VACANCY}} и текст, который встанет вместо {{FIT}}, — два-три предложения, не длиннее ${fitChars} символов. 
Строку с вакансией и ссылкой, весь остальной скелет программа подставит сама, дословно, поэтому в ответ их не включай. Без кавычек, приветствия и подписи.

${COMMON_WRITING_RULES}`;


export function buildDmMessages(input: { vacancy: Vacancy; resume: string; role: string; template: string }): ChatMessage[] {
  const v = input.vacancy;
  // Запас в десятую долю: модель промахивается со счётом, а проверка точная.
  const fitChars = Math.floor((fitLimit(input.template, v) * 0.9) / 10) * 10;
  return [
    { role: 'system', content: `${INSTRUCTION(input.role, input.template, fitChars)}\n\n=== РЕЗЮМЕ ===\n${input.resume}` },
    {
      role: 'user',
      content: [
        `Вакансия: ${v.title}`,
        `Ссылка на пост: ${v.url}`,
        v.channel === null ? '' : `Чат: ${v.channel}`,
        '',
        '=== ТЕКСТ ПОСТА ===',
        v.description,
      ].filter((s) => s !== '').join('\n'),
    },
  ];
}

/**
 * Слово, в котором латинские и кириллические буквы стоят вплотную. Слабые
 * модели иногда подменяют одну букву другим алфавитом: живой прогон 2026-10-08
 * отдал «Figма» (латиница + кириллическая «м»), и рекрутёр увидел бы опечатку,
 * которую не замечает ни ссылка, ни скелет. Слова через дефис («BPMN-схемы»)
 * не затрагиваются: дефис разрывает соседство.
 */
const MIXED_SCRIPT_WORD = /[A-Za-zА-Яа-яЁё]*(?:[A-Za-z][А-Яа-яЁё]|[А-Яа-яЁё][A-Za-z])[A-Za-zА-Яа-яЁё]*/;

/** Готовое сообщение целиком: то, что уйдёт рекрутёру. */
export function isUsableDm(text: string, vacancy: Vacancy): string | null {
  const t = text.trim();
  if (t === '') return 'пустой ответ';
  if (t.length > DM_MAX_LENGTH) return `длиннее ${DM_MAX_LENGTH} символов`;
  if (!t.includes(vacancy.url)) return 'нет ссылки на пост';
  const claim = findForbiddenClaim(t);
  if (claim !== null) return `выдуман навык: ${claim}`;
  const mixed = MIXED_SCRIPT_WORD.exec(t);
  if (mixed !== null) return `в слове «${mixed[0]}» смешаны латиница и кириллица`;
  return null;
}

/** Ответ модели — только текст вместо {{FIT}}; кавычки вокруг него (скелет в промпте стоит в кавычках) снимаются. */
function cleanFit(text: string): string {
  return text.trim().replace(/^["«“]([^"«»“”]*)["»”]$/, '$1').trim();
}

/**
 * Ответ модели. Промпт велит вернуть название вакансии со ссылкой (на место
 * {{VACANCY}}) и текст для {{FIT}}; живой прогон 2026-10-09 — все ответы
 * одинаковы: первая строка «название (ссылка)», дальше текст. Первая строка
 * без ссылки на вакансию значит, что модель вернула один только {{FIT}}: тогда
 * весь ответ — текст, а {{VACANCY}} подставит код.
 */
export function parseDmAnswer(text: string, vacancy: Vacancy): { vacancy: string | null; fit: string } {
  const [first = '', ...rest] = text.trim().split('\n');
  return first.includes(vacancy.url)
    ? { vacancy: first.trim(), fit: cleanFit(rest.join('\n')) }
    : { vacancy: null, fit: cleanFit(text) };
}

/** Что не так со строкой модели на месте {{VACANCY}}; null — годна. */
export function vacancyTextProblem(text: string, vacancy: Vacancy): string | null {
  if (/\{\{[^}]*\}\}/.test(text)) return 'в строке с вакансией остался плейсхолдер';
  if (text.split(vacancy.url).length !== 2) return 'в строке с вакансией ссылка должна быть одна';
  // Название и ссылка с парой знаков вокруг; всё, что длиннее, — уже не строка с вакансией.
  if (text.length > vacancy.title.length + vacancy.url.length + 60) return 'строка с вакансией длиннее названия и ссылки';
  return null;
}

/** Что не так с текстом на месте {{FIT}}; null — годен. `limit` — fitLimit скелета. */
export function fitProblem(fit: string, vacancy: Vacancy, limit: number): string | null {
  if (fit === '') return 'пустой ответ';
  if (/\{\{[^}]*\}\}/.test(fit)) return 'в ответе остался плейсхолдер';
  if (fit.includes(vacancy.url)) return 'в ответе лишняя ссылка: строку с вакансией ставит программа';
  if (fit.length < MIN_FIT_LENGTH) return `{{FIT}} не заполнен: меньше ${MIN_FIT_LENGTH} символов`;
  if (fit.length > limit) return `{{FIT}} длиннее ${limit} символов: со скелетом сообщение не уместится в ${DM_MAX_LENGTH}`;
  return null;
}

export async function generateDm(
  input: { vacancy: Vacancy; resume: string; role: string; readTemplate?: () => string },
  options: CompletionOptions,
): Promise<{ letter: string; mode: 'dm' | 'none'; failure?: string }> {
  const fail = (failure: string) => ({ letter: '', mode: 'none' as const, failure });
  let template: string;
  try {
    template = (input.readTemplate ?? readDmTemplate)();
  } catch (e) {
    // Файл правит человек: нет скелета — пустое сообщение с причиной, а не упавший поиск.
    return fail(`скелет ${DM_TEMPLATE_PATH} не читается: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!template.includes('{{FIT}}')) return fail(`в скелете ${DM_TEMPLATE_PATH} нет {{FIT}}: модели некуда писать`);

  const v = input.vacancy;
  const limit = fitLimit(template, v);
  // Проверяется и текст модели, и то, что из него соберётся и уйдёт рекрутёру.
  const r = await complete(
    buildDmMessages({ vacancy: v, resume: input.resume, role: input.role, template }),
    options,
    (text) => {
      const a = parseDmAnswer(text, v);
      return (a.vacancy === null ? null : vacancyTextProblem(a.vacancy, v))
        ?? fitProblem(a.fit, v, limit)
        ?? isUsableDm(assembleDm(template, a.fit, v, a.vacancy ?? undefined), v);
    },
  );
  if (!r.ok) return fail(r.failure);
  const a = parseDmAnswer(r.text, v);
  return { letter: assembleDm(template, a.fit, v, a.vacancy ?? undefined), mode: 'dm' };
}
