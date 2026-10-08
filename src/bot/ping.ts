import type { Meeting } from './state.js';
import { formatMeetTime } from './meet.js';
import type { QueueRow } from '../core/queue.js';

/**
 * Пинг владельцу о собеседовании: что сказать и что приложить. Чистая функция —
 * отправка и повторы живут в bot/run.ts.
 *
 * Текст едет подписью к документу, а подпись в Telegram — не больше 1024
 * символов. Ответ рекрутёра с датой бывает любой длины (до 4096), поэтому его
 * кусок и название вакансии обрезаются заранее: иначе рекрутёр и номер
 * вакансии, стоящие после них, вытолкнулись бы за предел.
 */

export interface MeetingPing {
  text: string;
  /** Текст вакансии файлом; null — вакансию не прикрепляли или её строки в очереди уже нет. */
  file: { name: string; content: string } | null;
}

const RAW_MAX = 300;
const TITLE_MAX = 200;

const two = (n: number): string => String(n).padStart(2, '0');

/** «20.09 в 20:58», по местному времени: так владелец видит время и в Telegram. */
function when(ms: number): string {
  const d = new Date(ms);
  return `${two(d.getDate())}.${two(d.getMonth() + 1)} в ${two(d.getHours())}:${two(d.getMinutes())}`;
}

const cut = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

function vacancyFile(row: QueueRow): { name: string; content: string } {
  const v = row.vacancy;
  const head = [
    `Вакансия #${row.id}`,
    `Название: ${v.title}`,
    ...(v.company === '' ? [] : [`Компания: ${v.company}`]),
    ...(v.url === '' ? [] : [`Ссылка: ${v.url}`]),
    `Прислана: ${when(row.createdAt)}${row.contact === null ? '' : ` от @${row.contact}`}`,
  ];
  return { name: `vacancy-${row.id}.txt`, content: `${head.join('\n')}\n\n${v.description}` };
}

/**
 * `row` — строка очереди по `m.queueId` в любом статусе (Queue.byId); null,
 * когда вакансию не прикрепляли или строка пропала.
 */
export function meetingPing(m: Meeting, row: QueueRow | null): MeetingPing {
  const who = m.username === null ? `id ${m.chatId}` : `@${m.username}`;
  const attached = m.queueId === null ? null : row;
  let vacancy: string;
  if (m.queueId === null) {
    vacancy = 'вакансию он не присылал';
  } else if (attached === null) {
    vacancy = `вакансия #${m.queueId}`;
  } else {
    vacancy = `вакансия #${m.queueId} — ${cut(attached.vacancy.title, TITLE_MAX)} (прислана ${when(attached.createdAt)})`;
  }
  return {
    text: [
      // Время — то, как его разобрал бот; слова рекрутёра рядом, дословно: «в час
      // дня» бот мог понять не так, и владелец должен увидеть расхождение до встречи.
      `Собеседование: ${formatMeetTime(new Date(m.meetAt), new Date(m.createdAt))}`,
      `Рекрутёр: ${who}`,
      `Он написал: «${cut(m.raw, RAW_MAX)}»`,
      vacancy,
    ].join('\n'),
    file: attached === null ? null : vacancyFile(attached),
  };
}
