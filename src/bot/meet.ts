/**
 * Разбор ответа на /set_meet. Формат владельца — `дд.мм;чч:мм`, но рекрутёр
 * печатает с телефона: пробел вместо `;` и точка вместо `:` встречаются чаще
 * опечаток. Придираться к разделителю — терять собеседование, поэтому
 * принимаем варианты, а год выбираем сами: ближайший, при котором дата в
 * будущем. Спрашивать год у человека, который и так делает одолжение, лишнее.
 */

const RE = /(\d{1,2})[.,](\d{1,2})\s*[;,\s]\s*(\d{1,2})[:.](\d{2})/;

export function parseMeetTime(raw: string, now: Date): { at: Date; pretty: string } | null {
  const m = RE.exec(raw);
  if (m === null) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const hour = Number(m[3]);
  const minute = Number(m[4]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59) return null;

  for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
    const at = new Date(year, month - 1, day, hour, minute, 0, 0);
    // Проверка на 31.02: Date молча переносит такую дату на 03.03. Не
    // отказываем сразу, а пробуем следующий год: 29.02 существует только в
    // високосном, и «29.02» в декабре 2027-го — валидная просьба на 2028-й.
    if (at.getMonth() !== month - 1 || at.getDate() !== day) continue;
    if (at.getTime() > now.getTime()) {
      const two = (n: number): string => String(n).padStart(2, '0');
      return { at, pretty: `${two(day)}.${two(month)} в ${two(hour)}:${two(minute)}` };
    }
  }
  return null;
}
