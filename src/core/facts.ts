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
// Даты должны быть реальными: месяц 01-12, год 1900-2099, день 01-31
const DATE_DDMMYYYY_RE = /\b(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])\.(?:19|20)\d{2}\b/g;
const DATE_MMYYYY_RE = /\b(?:0?[1-9]|1[0-2])\.(?:19|20)\d{2}\b/g;

/** Текстово отсекает ведущие нули, оставляя хотя бы один. */
function canonicalizeInteger(s: string): string {
  return s.replace(/^0+(?=\d)/, '') || '0';
}

/** Текстово нормализует число: ведущие нули из целой части, хвостовые из дробной. */
function canonicalizeNumber(s: string): string {
  const normalized = s.replace(',', '.');
  const parts = normalized.split('.');
  if (parts.length === 1) {
    // Целое число: отсечь ведущие нули
    return canonicalizeInteger(parts[0]!);
  }
  // Дробное: отсечь ведущие из целой, хвостовые из дробной
  const integer = canonicalizeInteger(parts[0]!);
  const frac = parts[1]!.replace(/0+$/, '');
  if (frac === '') {
    return integer;
  }
  return integer + '.' + frac;
}

/**
 * Числа текста в канонической форме. Дробная часть — точка, плюс отсечены
 * ведущие и хвостовые нули (85,50 → 85.5, 07.2025 → 7 и 2025 отдельно).
 *
 * Почему нужна каноника: резюме пишется '07–12.2025' (диапазон месяцев, месяц
 * отдельно), ответ модели — '07.2025' (дата месяца, вместе). Без канонизации
 * первое даёт {07, 12.2025}, второе {07.2025, 12.2025}, и модель отбраковывается
 * за «выдуманное число» хотя ответ правдив. Дата разбивается на компоненты
 * (ДД.ММ.ГГГГ → 12, 10, 2025) чтобы как резюме так и ответ давали одно и то же.
 *
 * Канонизация текстовая, не через Number(), чтобы не потерять точность в длинных
 * последовательностях цифр (123456789012345678 != Number(123456789012345678)).
 */
export function extractNumbers(text: string): Set<string> {
  const out = new Set<string>();
  let remaining = text;

  // Первый проход: даты в точках разбираем на компоненты в каноничной форме
  for (const match of text.matchAll(DATE_DDMMYYYY_RE)) {
    const parts = match[0].split('.');
    for (const part of parts) {
      out.add(canonicalizeInteger(part));
    }
  }

  for (const match of text.matchAll(DATE_MMYYYY_RE)) {
    const parts = match[0].split('.');
    for (const part of parts) {
      out.add(canonicalizeInteger(part));
    }
  }

  // Удаляем обработанные даты перед вторым проходом
  remaining = remaining.replace(DATE_DDMMYYYY_RE, ' ').replace(DATE_MMYYYY_RE, ' ');

  // Второй проход: остальные числа в канонической форме
  for (const m of remaining.matchAll(NUMBER_RE)) {
    out.add(canonicalizeNumber(m[0]));
  }

  return out;
}

/** Нет файла — не ошибка: значит фактов пока нет, отвечаем только по резюме. */
export function readFacts(path: string = FACTS_PATH): Facts {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  return { text, numbers: extractNumbers(text) };
}
