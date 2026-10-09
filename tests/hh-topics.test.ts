import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractJsonArray, parseTopicList } from '../src/hh/topics.js';

const fixture = readFileSync('tests/fixtures/hh-negotiations.html', 'utf8');

const page = (list: string): string => `<html><script>window.x={"a":1,"topicList":${list},"b":2}</script></html>`;

describe('parseTopicList: настоящая страница откликов', () => {
  const topics = parseTopicList(fixture)!;

  it('разбирает все 20 откликов', () => {
    expect(topics).toHaveLength(20);
  });

  it('состояния: 17 откликов, 2 приглашения, 1 отказ', () => {
    const by = (s: string): number => topics.filter((t) => t.lastState === s).length;
    expect(by('RESPONSE')).toBe(17);
    expect(by('INTERVIEW')).toBe(2);
    expect(by('DISCARD')).toBe(1);
  });

  it('новых сообщений на снимке нет', () => {
    expect(topics.filter((t) => t.hasNew)).toHaveLength(0);
  });

  it('номер вакансии — строка, номер отклика — число', () => {
    for (const t of topics) {
      expect(typeof t.vacancyId).toBe('string');
      expect(t.vacancyId).toMatch(/^\d+$/);
      expect(Number.isInteger(t.topicId)).toBe(true);
      expect(t.messagesCount).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('parseTopicList: сломанная и необычная разметка', () => {
  it('нет списка — null', () => {
    expect(parseTopicList('<html>ничего</html>')).toBeNull();
  });

  it('битый JSON — null', () => {
    expect(parseTopicList(page('[{"id":1,'))).toBeNull();
  });

  it('пустой список — пустой массив, не ошибка', () => {
    expect(parseTopicList(page('[]'))).toEqual([]);
  });

  it('запись без id или номера вакансии пропускается, остальные читаются', () => {
    const list = '[{"id":1,"vacancyId":10,"lastState":"RESPONSE"},{"vacancyId":11},{"id":3},{"id":4,"vacancyId":"12"}]';
    const topics = parseTopicList(page(list))!;
    expect(topics.map((t) => t.topicId)).toEqual([1, 4]);
    expect(topics[1]!.vacancyId).toBe('12');
  });

  it('нет полей состояния и счётчиков — разумные значения по умолчанию', () => {
    const [t] = parseTopicList(page('[{"id":5,"vacancyId":7}]'))!;
    expect(t).toMatchObject({ topicId: 5, vacancyId: '7', lastState: 'UNKNOWN', inboxState: null, messagesCount: 0, hasNew: false });
    expect(t!.lastModified).toBeNull();
  });

  it('читает флаг новых сообщений, число сообщений и время', () => {
    const list = '[{"id":9,"vacancyId":1,"lastState":"RESPONSE","hasNewMessages":true,"conversationMessagesCount":3,'
      + '"lastModifiedMillis":1700000000000,"inboxAvailabilityState":"AVAILABLE","chatId":77}]';
    expect(parseTopicList(page(list))).toEqual([{
      topicId: 9, chatId: 77, vacancyId: '1', lastState: 'RESPONSE', inboxState: 'AVAILABLE',
      messagesCount: 3, hasNew: true, lastModified: 1_700_000_000_000,
    }]);
  });
});

describe('extractJsonArray', () => {
  it('скобка внутри строки не закрывает массив', () => {
    const html = 'x"m":[{"t":"a]b","u":"\\"]"},2]y';
    expect(extractJsonArray(html, '"m":[')).toBe('[{"t":"a]b","u":"\\"]"},2]');
  });

  it('скобки не сошлись — null', () => {
    expect(extractJsonArray('"m":[1,2', '"m":[')).toBeNull();
  });

  it('маркера нет — null', () => {
    expect(extractJsonArray('ничего', '"m":[')).toBeNull();
  });
});
