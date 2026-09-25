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
