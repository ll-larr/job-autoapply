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
const DATE_DDMMYYYY_RE = /\b\d{1,2}\.\d{1,2}\.\d{4}\b/g;
const DATE_MMYYYY_RE = /\b\d{1,2}\.\d{4}\b/g;

/**
 * Числа текста в канонической форме. Дробная часть — точка, плюс отсечены
 * ведущие и хвостовые нули (85,50 → 85.5, 07.2025 → 7 и 2025 отдельно).
 *
 * Почему нужна каноника: резюме пишется '07–12.2025' (диапазон месяцев, месяц
 * отдельно), ответ модели — '07.2025' (дата месяца, вместе). Без канонизации
 * первое даёт {07, 12.2025}, второе {07.2025, 12.2025}, и модель отбраковывается
 * за «выдуманное число» хотя ответ правдив. Дата разбивается на компоненты
 * (ДД.ММ.ГГГГ → 12, 10, 2025) чтобы как резюме так и ответ давали одно и то же.
 */
export function extractNumbers(text: string): Set<string> {
  const out = new Set<string>();
  let remaining = text;

  // Первый проход: даты в точках разбираем на компоненты
  for (const match of text.matchAll(DATE_DDMMYYYY_RE)) {
    const parts = match[0].split('.');
    for (const part of parts) {
      out.add(String(Number(part)));
    }
  }

  for (const match of text.matchAll(DATE_MMYYYY_RE)) {
    const parts = match[0].split('.');
    for (const part of parts) {
      out.add(String(Number(part)));
    }
  }

  // Удаляем обработанные даты перед вторым проходом
  remaining = remaining.replace(DATE_DDMMYYYY_RE, ' ').replace(DATE_MMYYYY_RE, ' ');

  // Второй проход: остальные числа в канонической форме
  for (const m of remaining.matchAll(NUMBER_RE)) {
    const num = m[0].replace(',', '.');
    out.add(String(Number(num)));
  }

  return out;
}

/** Нет файла — не ошибка: значит фактов пока нет, отвечаем только по резюме. */
export function readFacts(path: string = FACTS_PATH): Facts {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  return { text, numbers: extractNumbers(text) };
}
