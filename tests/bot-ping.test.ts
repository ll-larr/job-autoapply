import { describe, it, expect } from 'vitest';
import { meetingPing } from '../src/bot/ping.js';
import type { Meeting } from '../src/bot/state.js';
import type { QueueRow } from '../src/core/queue.js';
import type { Vacancy } from '../src/core/vacancy.js';

const SENT_AT = new Date(2026, 8, 20, 20, 58).getTime();

const meeting = (over: Partial<Meeting> = {}): Meeting => ({
  id: 3,
  chatId: 645954522,
  username: 'll_larr',
  queueId: 197,
  meetAt: new Date(2026, 9, 6, 11, 0).getTime(),
  raw: '06.10; 11:00',
  createdAt: new Date(2026, 9, 5, 16, 49).getTime(),
  ...over,
});

/** Строка очереди как её кладёт бот: вакансия, присланная рекрутёром текстом. */
const botRow = (over: Partial<QueueRow> = {}, vac: Partial<Vacancy> = {}): QueueRow => ({
  id: 197,
  source: 'tg-bot',
  sourceId: '645954522:30',
  vacancy: {
    source: 'tg-bot', sourceId: '645954522:30', title: 'Бизнес анализ процессов банка',
    company: '', url: '', description: 'Бизнес анализ процессов банка', geo: '',
    postedAt: new Date(SENT_AT), salaryFrom: null, salaryTo: null, currency: null,
    isRemote: false, hasSponsorship: false, experience: null, contact: 'll_larr',
    contentHash: null, channel: null, ...vac,
  },
  score: 0,
  matched: [],
  letter: '',
  letterMode: 'none',
  status: 'skipped',
  error: null,
  specialty: 'business-analyst',
  contact: 'll_larr',
  approvedBy: null,
  createdAt: SENT_AT,
  sentAt: null,
  ...over,
});

describe('meetingPing — время', () => {
  it('называет разобранное время и дословно слова рекрутёра: ошибку разбора видно сразу', () => {
    // «в час дня» бот прочитал как 13:00 — владелец видит и то, и другое.
    const p = meetingPing(
      meeting({ raw: '10.10 в час дня', meetAt: new Date(2026, 9, 10, 13, 0).getTime() }),
      null,
    );
    expect(p.text).toContain('10 октября (суббота), 13:00');
    expect(p.text).toContain('«10.10 в час дня»');
  });

  it('чужой год называется явно, свой — нет', () => {
    const nextYear = meetingPing(meeting({ meetAt: new Date(2027, 0, 5, 10, 0).getTime() }), null);
    expect(nextYear.text).toContain('5 января 2027 (вторник), 10:00');
    const sameYear = meetingPing(meeting(), null);
    expect(sameYear.text).toContain('6 октября (вторник), 11:00');
    expect(sameYear.text).not.toContain('2026');
  });
});

describe('meetingPing — вакансия не прикреплялась', () => {
  it('говорит об этом прямо и файла не прикладывает', () => {
    const p = meetingPing(
      meeting({
        queueId: null, username: 'HIRE_agent', raw: '06.10; 10:00',
        meetAt: new Date(2026, 9, 6, 10, 0).getTime(),
      }),
      null,
    );
    expect(p.text).toContain('«06.10; 10:00»');
    expect(p.text).toContain('@HIRE_agent');
    expect(p.text).toContain('вакансию он не присылал');
    expect(p.file).toBeNull();
  });

  it('рекрутёр без @username назван по id, а не пустым «@»', () => {
    const p = meetingPing(meeting({ queueId: null, username: null }), null);
    expect(p.text).toContain('id 645954522');
    expect(p.text).not.toContain('@\n');
  });
});

describe('meetingPing — вакансия прикреплялась', () => {
  it('строка уже skipped: пинг всё равно называет вакансию, а текст идёт файлом', () => {
    // Живой случай 2026-10-05: «вакансия #197» без названия, потому что строка
    // была skipped. Название, номер и дата отправки — в самом пинге.
    const p = meetingPing(meeting(), botRow({ status: 'skipped' }));
    expect(p.text).toContain('#197');
    expect(p.text).toContain('Бизнес анализ процессов банка');
    expect(p.text).toContain('20.09 в 20:58');
    expect(p.file?.name).toBe('vacancy-197.txt');
  });

  it('файл содержит весь текст вакансии, а не выдержку', () => {
    const description = `Бизнес-аналитик в банк\n${'Требования: BPMN, SQL, интеграции. '.repeat(120)}`;
    const p = meetingPing(meeting(), botRow({}, { title: 'Бизнес-аналитик в банк', description }));
    expect(description.length).toBeGreaterThan(4000);
    expect(p.file?.content.endsWith(description)).toBe(true);
  });

  it('файл называет вакансию и отправителя; пустые компания и ссылка строк не дают', () => {
    const p = meetingPing(meeting(), botRow());
    const content = p.file?.content ?? '';
    expect(content).toContain('Вакансия #197');
    expect(content).toContain('Бизнес анализ процессов банка');
    expect(content).toContain('@ll_larr');
    expect(content).toContain('20.09 в 20:58');
    expect(content).not.toContain('Компания:');
    expect(content).not.toContain('Ссылка:');
  });

  it('компания и ссылка, если они есть, попадают в файл', () => {
    const p = meetingPing(
      meeting(),
      botRow({}, { company: 'Сбер', url: 'https://hh.ru/vacancy/123456' }),
    );
    expect(p.file?.content).toContain('Компания: Сбер');
    expect(p.file?.content).toContain('Ссылка: https://hh.ru/vacancy/123456');
  });

  it('строки вакансии в очереди больше нет: пинг остаётся, файла нет, «не присылал» не врёт', () => {
    const p = meetingPing(meeting({ queueId: 197 }), null);
    expect(p.text).toContain('#197');
    expect(p.text).not.toContain('не присылал');
    expect(p.file).toBeNull();
  });
});

describe('meetingPing — предел подписи Telegram', () => {
  it('длинные ответ рекрутёра и название не выталкивают рекрутёра и номер вакансии за 1024 символа', () => {
    // Текст пинга едет подписью к документу, а подпись Telegram режет жёстко.
    // Сообщение рекрутёра с датой может быть любой длины — до 4096 символов.
    const p = meetingPing(
      meeting({ raw: `06.10; 11:00 ${'и ещё много слов '.repeat(200)}` }),
      botRow({}, { title: 'Очень длинное название '.repeat(60) }),
    );
    expect(p.text.length).toBeLessThanOrEqual(1024);
    expect(p.text).toContain('@ll_larr');
    expect(p.text).toContain('#197');
    expect(p.text).toContain('06.10; 11:00');
  });
});
