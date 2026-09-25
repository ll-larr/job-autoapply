import { Api } from 'telegram';
import { describe, it, expect } from 'vitest';
import { fakeDialog, toDialogMessages } from '../src/telegram/interview-session.js';

describe('fakeDialog', () => {
  it('history отдаёт только сообщения новее minId, от старых к новым', async () => {
    const d = fakeDialog([
      { id: 1, date: new Date(), text: 'первое', urls: [], out: false, hasButtons: false },
      { id: 5, date: new Date(), text: 'второе', urls: [], out: false, hasButtons: false },
      { id: 9, date: new Date(), text: 'третье', urls: [], out: false, hasButtons: false },
    ]);
    const got = await d.history(5);
    expect(got.map((m) => m.id)).toEqual([9]);
  });

  it('send копит отправленное', async () => {
    const d = fakeDialog();
    await d.send('привет');
    expect(d.sent).toEqual(['привет']);
  });

  it('send появляется в history с out: true', async () => {
    const d = fakeDialog();
    await d.send('привет');
    const got = await d.history(0);
    expect(got).toEqual([expect.objectContaining({ text: 'привет', out: true })]);
  });

  it('onMessage получает новые сообщения и отписывается', () => {
    const d = fakeDialog();
    const seen: string[] = [];
    const off = d.onMessage((m) => seen.push(m.text));
    d.push('раз');
    off();
    d.push('два');
    expect(seen).toEqual(['раз']);
  });

  it('push с hasButtons: true отдаётся с этим признаком', async () => {
    const d = fakeDialog();
    d.push('вопрос', { hasButtons: true });
    const got = await d.history(0);
    expect(got[0]?.hasButtons).toBe(true);
    expect(got[0]?.out).toBe(false);
  });
});

describe('toDialogMessages', () => {
  it('оставляет только Api.Message с текстом; служебные, удалённые и медиа без подписи отбрасывает', () => {
    const real = new Api.Message({ id: 10, peerId: undefined, date: 1_700_000_000, message: 'привет', out: false });
    const service = new Api.MessageService({ id: 11, peerId: undefined, date: 1_700_000_000, action: undefined });
    const empty = new Api.MessageEmpty({ id: 12 });
    const noCaption = new Api.Message({ id: 13, peerId: undefined, date: 1_700_000_000, message: '' });
    const noMessageField = new Api.Message({ id: 14, peerId: undefined, date: 1_700_000_000 });

    const got = toDialogMessages([real, service, empty, noCaption, noMessageField]);

    expect(got.map((m) => m.id)).toEqual([10]);
    expect(got[0]?.text).toBe('привет');
    expect(got[0]?.out).toBe(false);
  });

  it('отдаёт hasButtons: true для Api.Message с replyMarkup', () => {
    const withButtons = new Api.Message({
      id: 20, peerId: undefined, date: 1_700_000_000, message: 'выбери один из вариантов',
      replyMarkup: new Api.ReplyInlineMarkup({ rows: [] }),
    });

    const got = toDialogMessages([withButtons]);

    expect(got[0]?.hasButtons).toBe(true);
  });

  it('кнопки — только настоящие: инлайн и клавиатура да; снятие клавиатуры и «ответить» нет (I1)', () => {
    const withMarkup = (id: number, replyMarkup: Api.TypeReplyMarkup | undefined): Api.Message => new Api.Message({
      id, peerId: undefined, date: 1_700_000_000, message: `сообщение ${id}`, replyMarkup,
    });
    const got = toDialogMessages([
      withMarkup(30, new Api.ReplyInlineMarkup({ rows: [] })),
      withMarkup(31, new Api.ReplyKeyboardMarkup({ rows: [] })),
      withMarkup(32, new Api.ReplyKeyboardHide({})),
      withMarkup(33, new Api.ReplyKeyboardForceReply({})),
      withMarkup(34, undefined),
    ]);
    expect(got.map((m) => [m.id, m.hasButtons])).toEqual([
      [30, true], [31, true], [32, false], [33, false], [34, false],
    ]);
  });

  it('значения, которые вообще не Api.Message (null, объект, строка), не роняют функцию', () => {
    expect(toDialogMessages([null, undefined, {}, 'строка', 42])).toEqual([]);
  });
});
