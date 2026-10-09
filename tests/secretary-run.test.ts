import { describe, it, expect } from 'vitest';
import { runBot, performAction, type RunBotOptions } from '../src/bot/run.js';
import { BotApi } from '../src/bot/api.js';
import { SecretaryRuntime } from '../src/bot/secretary-run.js';
import { businessKey } from '../src/bot/state.js';
import { SECRETARY_TEXTS as T } from '../src/bot/texts.js';
import type { TgBotUpdate } from '../src/bot/types.js';
import { makeHarness, bizConn, bizMsg, ownerMsg, bizUpdate, seedSent, T0, type HarnessOptions } from './support/secretary.js';

interface Call { method: string; body: Record<string, unknown> }
const KEY = businessKey(77);

interface Setup {
  secretary?: HarnessOptions['secretary'];
  /** Секунд между кругами getUpdates на подменённых часах. */
  tick?: number;
  connection?: ReturnType<typeof bizConn>;
  idleRounds?: number;
  /** Отказы отправки по порядку: число — HTTP-статус с описанием, 'network' — обрыв связи. */
  sendFails?: Array<number | 'network'>;
  noSecretary?: boolean;
}

function setup(rounds: TgBotUpdate[][], s: Setup = {}) {
  const h = makeHarness({ secretary: { debounceMs: 0, maxDebounceMs: 0, ...s.secretary } });
  const calls: Call[] = [];
  const logs: string[] = [];
  let round = 0;
  const fails = [...(s.sendFails ?? [])];
  const ok = (result: unknown): Response => new Response(JSON.stringify({ ok: true, result }));
  const fetchImpl: typeof fetch = async (url, init) => {
    const method = String(url).split('/').pop() ?? '';
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ method, body });
    if (method === 'getWebhookInfo') return ok({ url: '' });
    if (method === 'getMe') return ok({ id: 1, is_bot: true, username: 'lar_autoapply_bot', can_connect_to_business: true });
    if (method === 'getBusinessConnection') return ok(s.connection ?? bizConn());
    if (method === 'getUpdates') {
      h.clock.now += (s.tick ?? 0) * 1000;
      const batch = rounds[round] ?? [];
      round += 1;
      return ok(batch);
    }
    if (method === 'sendMessage' || method === 'sendDocument') {
      const fail = fails.shift();
      if (fail === 'network') throw new Error('socket hang up');
      if (typeof fail === 'number') {
        return new Response(JSON.stringify({ ok: false, description: 'Bad Request: BUSINESS_PEER_USAGE_MISSING' }), { status: fail });
      }
    }
    return ok({ message_id: 1 });
  };
  const api = new BotApi('T', { fetchImpl });
  const runOpts: RunBotOptions = {
    api, store: h.store, deps: h.deps, ownerChatId: 999, log: (l) => logs.push(l),
    stopAfterIdleRounds: s.idleRounds ?? 1, sleep: async () => {},
  };
  if (s.noSecretary !== true) {
    runOpts.secretary = new SecretaryRuntime({
      api, store: h.store, deps: h.deps, perform: (a) => performAction(a, runOpts), log: (l) => logs.push(l),
      now: () => h.clock.now, sleep: async () => {},
    });
  }
  const sends = (): Call[] => calls.filter((c) => c.method === 'sendMessage' || c.method === 'sendDocument');
  return { h, calls, logs, sends, run: () => runBot(runOpts) };
}

const seconds = (n: number): number => Math.floor((T0 + n * 1000) / 1000);

describe('секретарь в цикле бота', () => {
  it('ответ уходит в чат аккаунта: business_connection_id, chat_id собеседника, без клавиатуры', async () => {
    const t = setup([[bizUpdate(1, { business_message: bizMsg({ text: 'Привет!' }) })]]);
    await t.run();
    const [only] = t.sends();
    expect(t.sends()).toHaveLength(1);
    expect(only!.body).toMatchObject({ chat_id: 77, text: T.greeting, business_connection_id: 'c1' });
    expect(only!.body).not.toHaveProperty('reply_markup');
    const poll = t.calls.find((c) => c.method === 'getUpdates')!.body;
    expect(poll['allowed_updates']).toEqual(['message', 'business_connection', 'business_message', 'edited_business_message']);
    expect(poll['timeout']).toBe(30);
  });

  it('сообщение самого аккаунта ответа не вызывает, но попадает в память', async () => {
    const t = setup([[bizUpdate(1, { business_message: ownerMsg({ text: 'Здравствуйте! Давайте обсудим.' }) })]]);
    await t.run();
    expect(t.sends()).toHaveLength(0);
    expect(t.h.memory.recent(KEY, T0).map((x) => x.who)).toEqual(['owner']);
  });

  it('наше первое сообщение с GramJS узнаётся по письму из очереди и помечается как реплика Хаера', async () => {
    const t = setup([[bizUpdate(1, { business_message: ownerMsg({
      message_id: 2, text: 'Привет! Я - Хаер, ИИ ассистент кандидата. Пишу тебе по вакансии X',
    }) })]]);
    seedSent(t.h, { letter: 'Привет! Я - Хаер, ИИ ассистент кандидата. Пишу тебе по вакансии X' });
    await t.run();
    expect(t.h.memory.recent(KEY, T0).map((x) => x.who)).toEqual(['agent']);
  });

  it('неизвестное соединение читается один раз через getBusinessConnection, дальше берётся из кеша', async () => {
    const t = setup([
      [bizUpdate(1, { business_message: bizMsg({ message_id: 1, text: 'Привет!' }) })],
      [bizUpdate(2, { business_message: bizMsg({ message_id: 2, text: 'Спасибо' }) })],
    ], { idleRounds: 2 });
    await t.run();
    expect(t.calls.filter((c) => c.method === 'getBusinessConnection')).toHaveLength(1);
    expect(t.h.store.connection('c1')).toMatchObject({ userId: 500, username: 'hire_agent', canReply: true, isEnabled: true });
  });

  it('апдейт business_connection сохраняется; выключенное соединение молчит', async () => {
    const t = setup([[
      bizUpdate(1, { business_connection: bizConn({ is_enabled: false }) }),
      bizUpdate(2, { business_message: bizMsg({ text: 'Привет!' }) }),
    ]]);
    await t.run();
    expect(t.h.store.connection('c1')?.isEnabled).toBe(false);
    expect(t.sends()).toHaveLength(0);
    expect(t.calls.filter((c) => c.method === 'getBusinessConnection')).toHaveLength(0);
  });

  it('чужой аккаунт — тишина и одна строка в лог', async () => {
    const t = setup([[bizUpdate(1, { business_message: bizMsg({ text: 'Привет!' }) })]], {
      connection: bizConn({ user: { id: 9, is_bot: false, username: 'someone_else' } }),
    });
    await t.run();
    expect(t.sends()).toHaveLength(0);
    expect(t.logs.filter((l) => l.includes('someone_else'))).toHaveLength(1);
  });

  it('нет права отвечать — тишина, сообщение отмечено; право по старому полю can_reply тоже читается', async () => {
    const denied = setup([[bizUpdate(1, { business_message: bizMsg({ text: 'Привет!' }) })]], {
      connection: bizConn({ rights: { can_reply: false } }),
    });
    await denied.run();
    expect(denied.sends()).toHaveLength(0);
    expect(denied.h.store.seen(KEY, 1)?.outcome).toBe('silent');

    const legacy = setup([[bizUpdate(1, { business_message: bizMsg({ text: 'Привет!' }) })]], {
      connection: bizConn({ rights: undefined, can_reply: true }),
    });
    await legacy.run();
    expect(legacy.sends()).toHaveLength(1);
  });

  it('окно 24 часа: сообщение старше 23 часов остаётся без ответа', async () => {
    const old = Math.floor(T0 / 1000) - 24 * 3600;
    const t = setup([[bizUpdate(1, { business_message: bizMsg({ text: 'Привет!', date: old }) })]]);
    await t.run();
    expect(t.sends()).toHaveLength(0);
    expect(t.h.store.seen(KEY, 1)?.outcome).toBe('silent');
  });

  it('повторная доставка апдейта — один ответ', async () => {
    const u = bizUpdate(1, { business_message: bizMsg({ text: 'Привет!' }) });
    const t = setup([[u], [{ ...u, update_id: 2 }]], { idleRounds: 2 });
    await t.run();
    expect(t.sends()).toHaveLength(1);
  });

  it('правка обычного сообщения повторно не отвечается', async () => {
    const t = setup([
      [bizUpdate(1, { business_message: bizMsg({ message_id: 3, text: 'Привет!' }) })],
      [bizUpdate(2, { edited_business_message: bizMsg({ message_id: 3, text: 'Привет, друг!', edit_date: seconds(1) }) })],
    ], { idleRounds: 2 });
    await t.run();
    expect(t.sends()).toHaveLength(1);
  });

  it('пачка: два сообщения подряд — один ответ на обе реплики после паузы тишины', async () => {
    const t = setup([
      [bizUpdate(1, { business_message: bizMsg({ message_id: 1, text: 'Расскажите про Jira?', date: seconds(0) }) })],
      [bizUpdate(2, { business_message: bizMsg({ message_id: 2, text: 'И про Confluence тоже', date: seconds(6) }) })],
    ], { secretary: { debounceMs: 10_000, maxDebounceMs: 45_000 }, tick: 6, idleRounds: 4 });
    await t.run();
    expect(t.sends()).toHaveLength(1);
    expect(t.h.asked).toHaveLength(1);
    expect(t.h.asked[0]![1]!.content).toContain('Расскажите про Jira?\nИ про Confluence тоже');
    // Мозг видел пачку целиком одним обращением.
    expect(t.h.store.seen(KEY, 1)?.outcome).toBe('answered');
    expect(t.h.store.seen(KEY, 2)?.outcome).toBe('answered');
  });

  it('Telegram не даёт ответить (400 на business-вызове) — не падаем и не шлём общий текст сбоя', async () => {
    const t = setup([[bizUpdate(1, { business_message: bizMsg({ text: 'Привет!' }) })]], { sendFails: [400] });
    await t.run();
    expect(t.sends()).toHaveLength(1);
    expect(t.logs.some((l) => l.includes('не даёт ответить'))).toBe(true);
    expect(t.logs.join('\n')).not.toContain('Не получается ответить');
  });

  it('сбой сети при отправке — те же действия повторяются через 30 секунд, мозг не запускается заново', async () => {
    const t = setup([
      [bizUpdate(1, { business_message: bizMsg({ text: 'Расскажите про Jira?' }) })],
      [], [],
    ], { sendFails: ['network'], tick: 31, idleRounds: 3 });
    await t.run();
    expect(t.sends()).toHaveLength(2);
    expect(t.h.asked).toHaveLength(1);
    expect(t.sends()[1]!.body).toMatchObject({ text: 'ответ модели', business_connection_id: 'c1' });
  });

  it('резюме по просьбе: отправка документа в чат аккаунта', async () => {
    const t = setup([[bizUpdate(1, { business_message: bizMsg({ text: 'скиньте резюме' }) })]]);
    // PDF нет → бот честно пишет, что приложить не может, и тоже через соединение.
    await t.run();
    expect(t.sends()[0]!.body).toMatchObject({ chat_id: 77, text: T.cvMissing, business_connection_id: 'c1' });
  });

  it('запись на собеседование: ответ рекрутёру, затем пинг владельцу с пометкой «личка @HIRE_agent»', async () => {
    const t = setup([[bizUpdate(1, { business_message: bizMsg({ text: 'давай созвонимся завтра в 15' }) })]]);
    seedSent(t.h);
    await t.run();
    const toRecruiter = t.sends().find((c) => c.body['chat_id'] === 77)!;
    expect(String(toRecruiter.body['text'])).toContain('Записал: 10 октября (суббота), 15:00');
    const ping = t.sends().find((c) => c.body['chat_id'] === 999)!;
    expect(String(ping.body['text'] ?? ping.body['caption'] ?? '')).toContain('Рекрутёр: @rec (личка @HIRE_agent)');
    expect(t.h.store.pendingMeetings()).toEqual([]);
  });

  it('обычный чат с ботом работает как раньше — с клавиатурой', async () => {
    const t = setup([[bizUpdate(1, { message: { message_id: 1, date: seconds(0), chat: { id: 5, type: 'private' }, from: { id: 5, is_bot: false }, text: '/start' } })]]);
    await t.run();
    expect(t.sends()[0]!.body).toMatchObject({ chat_id: 5 });
    expect(t.sends()[0]!.body['reply_markup']).toBeDefined();
    expect(t.sends()[0]!.body).not.toHaveProperty('business_connection_id');
  });

  it('секретарь выключен в config — сообщение из личной переписки не обрабатывается, причина в логе один раз', async () => {
    const t = setup([[
      bizUpdate(1, { business_message: bizMsg({ message_id: 1 }) }),
      bizUpdate(2, { business_message: bizMsg({ message_id: 2 }) }),
    ]], { noSecretary: true });
    await t.run();
    expect(t.sends()).toHaveLength(0);
    expect(t.logs.filter((l) => l.includes('секретарь выключен'))).toHaveLength(1);
  });

  it('при старте бот сообщает про Secretary Mode и про подключение', async () => {
    const t = setup([[]]);
    await t.run();
    expect(t.logs.some((l) => l.includes('секретарь включён для аккаунта @HIRE_agent'))).toBe(true);
    expect(t.logs.some((l) => l.includes('подключения пока не видел'))).toBe(true);
  });

  it('в логе нет текстов рекрутёров', async () => {
    const t = setup([[bizUpdate(1, { business_message: bizMsg({ text: 'Секретная фраза рекрутёра про Jira?' }) })]]);
    await t.run();
    expect(t.logs.join('\n')).not.toContain('Секретная фраза');
  });
});
