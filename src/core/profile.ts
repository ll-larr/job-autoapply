/**
 * Имя кандидата для промптов: письма, личные сообщения, анкеты работодателя и
 * ответы бота рекрутёру. До 2026-09-20 оно было вписано в текст промптов в
 * четырёх файлах — копию проекта нельзя было отдать другому человеку, не
 * правя код.
 *
 * Живёт в модуле, а не в аргументах каждого билдера промпта, по той же
 * причине, что и ключ OpenRouter (openrouter.ts): зовущих мест восемь, а
 * значение во всём процессе одно — имя того, от чьего лица пишут. Ставится в
 * одной точке, из настроек (cli.ts#currentSettings).
 */

let name: string | null = null;

export function setCandidateName(value: string | null): void {
  name = value === null || value.trim() === '' ? null : value.trim();
}

/** Полное имя или null, если человек его не вписал. */
export function candidateName(): string | null {
  return name;
}

/**
 * Как обратиться в подписи короткого сообщения: первое слово имени. Для
 * «Имя Фамилия» — «Имя». Имя не задано — null.
 */
export function candidateShortName(): string | null {
  return name === null ? null : (name.split(/\s+/)[0] ?? null);
}

/**
 * Строка промпта, называющая кандидата, или пустая строка. Пустую склеивающий
 * помощник `withCandidate` выбрасывает — без имени промпт говорит просто
 * «кандидат», и это честнее, чем заглушка, которую модель примет за настоящее
 * имя и впишет в письмо.
 */
export function candidateLine(): string {
  return name === null ? '' : `Кандидат: ${name}.\n`;
}

/** Приклеивает строку с именем к тексту промпта, не оставляя пустой строки. */
export function withCandidate(text: string): string {
  const who = candidateLine();
  return who === '' ? text : `${text}
${who}`;
}
