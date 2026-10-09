import { describe, it, expect } from 'vitest';
import { classifyMessage, messageKey, readChatMessages, type FrameLike, type ItemLike } from '../src/hh/chat.js';
import { CHAT_MESSAGE_CANDIDATES } from '../src/hh/inbox-selectors.js';

interface Msg { text: string; attrs?: Record<string, string> }

/** Фрейм-пустышка: для каждого селектора — свой список сообщений. */
function frame(bySelector: Record<string, Msg[]>): FrameLike {
  return {
    locator(selector: string) {
      const list = bySelector[selector] ?? [];
      return {
        count: async () => list.length,
        nth(i: number): ItemLike {
          const m = list[i]!;
          return {
            innerText: async () => m.text,
            getAttribute: async (name: string) => m.attrs?.[name] ?? null,
          };
        },
      };
    },
  };
}

const NONE = { letter: null, replies: [] as string[] };

describe('classifyMessage', () => {
  it('текст, начинающийся с нашего письма, — наш, независимо от пробелов и регистра', () => {
    const letter = 'Здравствуйте! Меня зовут Иван, откликаюсь на вакансию аналитика.';
    expect(classifyMessage('здравствуйте!  меня зовут иван, откликаюсь на вакансию аналитика. Резюме во вложении', { letter, replies: [] }))
      .toBe('ours');
  });

  it('наш прошлый ответ — наш', () => {
    expect(classifyMessage('Спасибо, жду звонка', { letter: null, replies: ['Спасибо, жду звонка'] })).toBe('ours');
  });

  it('служебная строка hh — system', () => {
    expect(classifyMessage('Работодатель посмотрел ваше резюме', NONE)).toBe('system');
  });

  it('остальное — входящее', () => {
    expect(classifyMessage('Добрый день, когда удобно созвониться?', NONE)).toBe('incoming');
  });
});

describe('messageKey', () => {
  it('id из разметки главнее хэша', () => {
    expect(messageKey(5, 'текст', ' 42 ')).toBe('id:42');
  });

  it('без id — хэш: не содержит текста, зависит от чата и стабилен к пробелам', () => {
    const a = messageKey(5, 'Добрый день!', null);
    expect(a).toMatch(/^h:[0-9a-f]{40}$/);
    expect(a).not.toContain('Добрый');
    expect(messageKey(5, '  добрый   день! ', null)).toBe(a);
    expect(messageKey(6, 'Добрый день!', null)).not.toBe(a);
  });

  it('пустой id считается отсутствующим', () => {
    expect(messageKey(5, 'x', '   ')).toMatch(/^h:/);
  });
});

describe('readChatMessages', () => {
  it('ничего не нашлось — selector null и ноль сообщений', async () => {
    const r = await readChatMessages(frame({}), 1, NONE);
    expect(r).toEqual({ selector: null, messages: [] });
  });

  it('первый кандидат с совпадениями выигрывает', async () => {
    const f = frame({
      [CHAT_MESSAGE_CANDIDATES[1]!]: [{ text: 'Привет' }],
      [CHAT_MESSAGE_CANDIDATES[2]!]: [{ text: 'Другое' }],
    });
    const r = await readChatMessages(f, 1, NONE);
    expect(r.selector).toBe(CHAT_MESSAGE_CANDIDATES[1]);
    expect(r.messages.map((m) => m.text)).toEqual(['Привет']);
  });

  it('пустые сообщения (разделители) пропускаются, id берётся из атрибута', async () => {
    const f = frame({
      [CHAT_MESSAGE_CANDIDATES[0]!]: [
        { text: '   ' },
        { text: 'Здравствуйте', attrs: { 'data-message-id': '901' } },
      ],
    });
    const r = await readChatMessages(f, 7, NONE);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ key: 'id:901', direction: 'incoming' });
  });

  it('читает только последние limit сообщений', async () => {
    const msgs = Array.from({ length: 25 }, (_, i) => ({ text: `m${i}` }));
    const r = await readChatMessages(frame({ [CHAT_MESSAGE_CANDIDATES[0]!]: msgs }), 1, NONE, 10);
    expect(r.messages).toHaveLength(10);
    expect(r.messages[0]!.text).toBe('m15');
    expect(r.messages.at(-1)!.text).toBe('m24');
  });

  it('направление: письмо отклика — наше, ответ работодателя — входящее', async () => {
    const letter = 'Здравствуйте, откликаюсь на вакансию';
    const f = frame({
      [CHAT_MESSAGE_CANDIDATES[0]!]: [{ text: `${letter}. Готов к звонку` }, { text: 'Добрый день, расскажите об опыте' }],
    });
    const r = await readChatMessages(f, 1, { letter, replies: [] });
    expect(r.messages.map((m) => m.direction)).toEqual(['ours', 'incoming']);
  });
});
