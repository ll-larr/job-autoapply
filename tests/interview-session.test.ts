import { Api } from 'telegram';
import { describe, it, expect, vi } from 'vitest';
import {
  fakeDialog, toDialogMessages, openFailureReason, findCallbackButton, pressCallback,
} from '../src/telegram/interview-session.js';

describe('fakeDialog', () => {
  it('history отдаёт только сообщения новее minId, от старых к новым', async () => {
    const d = fakeDialog([
      { id: 1, date: new Date(), text: 'первое', urls: [], out: false, hasButtons: false, buttons: [] },
      { id: 5, date: new Date(), text: 'второе', urls: [], out: false, hasButtons: false, buttons: [] },
      { id: 9, date: new Date(), text: 'третье', urls: [], out: false, hasButtons: false, buttons: [] },
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

describe('openFailureReason (G1)', () => {
  it('протухшая или пустая сессия интервью — подсказка входа именно в неё, а не в рабочую', () => {
    const path = 'data/telegram-interview.session';
    for (const reason of ['auth', 'no_session'] as const) {
      const r = openFailureReason({ reason, message: 'сессия Telegram протухла — перелогинься: npm run tg:login' }, path);
      expect(r).toContain('npm run tg:login -- --session data/telegram-interview.session');
    }
  });

  it('VPN и ключи — причина как есть', () => {
    expect(openFailureReason({ reason: 'no_proxy', message: 'VPN выключен' }, 'x.session')).toBe('VPN выключен');
    expect(openFailureReason({ reason: 'no_keys', message: 'нет TG_API_ID' }, 'x.session')).toBe('нет TG_API_ID');
  });
});

describe('кнопки сообщения (G2)', () => {
  const withMarkup = (id: number, replyMarkup: Api.TypeReplyMarkup | undefined): Api.Message => new Api.Message({
    id, peerId: undefined, date: 1_700_000_000, message: `сообщение ${id}`, replyMarkup,
  });
  const cb = (text: string, data = text): Api.KeyboardButtonCallback =>
    new Api.KeyboardButtonCallback({ text, data: Buffer.from(data) });

  it('тексты кнопок по строкам и по порядку: инлайн и обычная клавиатура; без кнопок — пусто', () => {
    const inline = new Api.ReplyInlineMarkup({
      rows: [
        new Api.KeyboardButtonRow({ buttons: [cb('1. Системный аналитик'), cb('2. Data analyst')] }),
        new Api.KeyboardButtonRow({ buttons: [cb('Далее')] }),
      ],
    });
    const keyboard = new Api.ReplyKeyboardMarkup({
      rows: [new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButton({ text: 'Да' })] })],
    });
    const got = toDialogMessages([
      withMarkup(40, inline),
      withMarkup(41, keyboard),
      withMarkup(42, new Api.ReplyKeyboardHide({})),
      withMarkup(43, undefined),
    ]);
    expect(got.map((m) => [m.id, m.hasButtons, m.buttons])).toEqual([
      [40, true, ['1. Системный аналитик', '2. Data analyst', 'Далее']],
      [41, true, ['Да']],
      [42, false, []],
      [43, false, []],
    ]);
  });

  it('findCallbackButton: только инлайн-кнопка с данными и ровно этим текстом', () => {
    const url = new Api.KeyboardButtonUrl({ text: '1. Системный аналитик', url: 'https://example.com' });
    const secret = new Api.KeyboardButtonCallback({ text: '2. Data analyst', data: Buffer.from('x'), requiresPassword: true });
    const target = cb('1. Системный аналитик', 'vacancy-1');
    const inline = new Api.ReplyInlineMarkup({ rows: [new Api.KeyboardButtonRow({ buttons: [url, secret, target] })] });
    expect(findCallbackButton(inline, '1. Системный аналитик')).toBe(target);
    // Кнопка с паролем (как у BotFather) и несуществующий текст — не нажимаются.
    expect(findCallbackButton(inline, '2. Data analyst')).toBeUndefined();
    expect(findCallbackButton(inline, '1. Системный')).toBeUndefined();
    // Обычная клавиатура шлёт свой текст сообщением — это не проверенный валидатором текст.
    const keyboard = new Api.ReplyKeyboardMarkup({
      rows: [new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButton({ text: 'Далее' })] })],
    });
    expect(findCallbackButton(keyboard, 'Далее')).toBeUndefined();
    expect(findCallbackButton(undefined, 'Далее')).toBeUndefined();
  });

  it('pressCallback: messages.GetBotCallbackAnswer с данными кнопки; таймаут ответа бота — нажатие состоялось', async () => {
    const peer = new Api.InputPeerSelf();
    const button = cb('1. Системный аналитик', 'vacancy-1');
    const invoke = vi.fn(async (_r: Api.messages.GetBotCallbackAnswer) => ({}));
    expect(await pressCallback(invoke, peer, 77, button)).toBe(true);
    const req = invoke.mock.calls[0]![0];
    expect(req).toBeInstanceOf(Api.messages.GetBotCallbackAnswer);
    expect(req.msgId).toBe(77);
    expect(req.peer).toBe(peer);
    expect(Buffer.from(req.data!).toString()).toBe('vacancy-1');

    const timeout = vi.fn(async () => { throw Object.assign(new Error('timeout'), { errorMessage: 'BOT_RESPONSE_TIMEOUT' }); });
    expect(await pressCallback(timeout, peer, 77, button)).toBe(true);
    const broken = vi.fn(async () => { throw Object.assign(new Error('flood'), { errorMessage: 'FLOOD_WAIT_30' }); });
    await expect(pressCallback(broken, peer, 77, button)).rejects.toThrow('flood');
  });
});

describe('fakeDialog: кнопки, нажатия и правка сообщения (G2)', () => {
  it('push с кнопками — hasButtons и тексты; своё сообщение — без кнопок', async () => {
    const d = fakeDialog();
    d.push('Выберите вакансию', { buttons: ['1. Системный аналитик', 'Далее'] });
    await d.send('ответ');
    const got = await d.history(0);
    expect(got.map((m) => [m.hasButtons, m.buttons])).toEqual([[true, ['1. Системный аналитик', 'Далее']], [false, []]]);
  });

  it('pressButton записывает нажатие и зовёт сценарий бота; чужой текст или id — false, без записи', async () => {
    const d = fakeDialog();
    const id = d.push('Выберите вакансию', { buttons: ['1. Системный аналитик'] });
    const seen: [number, string][] = [];
    d.onPress = (messageId, button) => { seen.push([messageId, button]); };
    expect(await d.pressButton(id, '1. Системный аналитик')).toBe(true);
    expect(await d.pressButton(id, '2. Data analyst')).toBe(false);
    expect(await d.pressButton(id + 100, '1. Системный аналитик')).toBe(false);
    expect(d.presses).toEqual([{ messageId: id, button: '1. Системный аналитик' }]);
    expect(seen).toEqual([[id, '1. Системный аналитик']]);
  });

  it('edit меняет сообщение на месте: тот же id и дата, новый текст, кнопки сняты; getMessage видит правку', async () => {
    const d = fakeDialog();
    const id = d.push('Выберите вакансию', { buttons: ['1. Системный аналитик'] });
    const before = (await d.history(0))[0]!;
    d.edit(id, { text: 'Спасибо за выбор вакансии!', buttons: [] });
    const after = (await d.history(0))[0]!;
    expect([after.id, after.date, after.text, after.hasButtons, after.buttons])
      .toEqual([id, before.date, 'Спасибо за выбор вакансии!', false, []]);
    expect((await d.getMessage(id))?.text).toBe('Спасибо за выбор вакансии!');
    expect(await d.getMessage(id + 100)).toBeNull();
    expect(await d.pressButton(id, '1. Системный аналитик')).toBe(false);
  });
});
