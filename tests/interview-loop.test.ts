import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fakeDialog, type DialogMessage } from '../src/telegram/interview-session.js';
import {
  answerOnce, readState, writeState, openWindow, runInterview, backoffFor, type RunnerState, type RunOptions,
} from '../src/core/interview-runner.js';
import { DEFAULT_GIGARECRUITER, type GigarecruiterConfig } from '../src/core/config.js';
import type { Turn } from '../src/core/interview.js';

// Реальные вопросы живого интервью ГигаРекрутёра 2026-09-15.
const QUESTIONS = [
  'Почему сейчас рассматриваете предложения о работе?',
  'Чем вас заинтересовала данная вакансия?',
  'Какой у Вас желаемый уровень заработной платы?',
  'Расскажите, как Вы используете Postman или Curl в работе?',
  'Могли бы привести пример задачи, где Вы применяли RabbitMQ или Kafka?',
  'Уточните, чем Вы занимались в период с июля 2025 по февраль 2026 года?',
];

describe('сквозной прогон шести вопросов', () => {
  it('на каждый уходит ровно один ответ, метка растёт', async () => {
    const dialog = fakeDialog();
    const statePath = join(mkdtempSync(join(tmpdir(), 'loop-')), 'state.json');
    const logPath = join(dirname(statePath), 'run.log');
    const transcript: Turn[] = [];

    for (const [i, text] of QUESTIONS.entries()) {
      const question = { id: i + 1, date: new Date(), text, urls: [], out: false, hasButtons: false };
      const r = await answerOnce({
        dialog,
        question,
        transcript,
        statePath,
        logPath,
        generate: async () => ({ ok: true as const, text: `Ответ ${i + 1}.` }),
        delay: async () => {},
      });
      expect(r).toBe('sent');
      transcript.push({ who: 'bot', text }, { who: 'me', text: `Ответ ${i + 1}.` });
    }

    expect(dialog.sent).toHaveLength(6);
    expect(readState(statePath).lastMessageId).toBe(6);
  });

  it('повторная обработка тех же вопросов ничего не досылает', async () => {
    const dialog = fakeDialog();
    const statePath = join(mkdtempSync(join(tmpdir(), 'loop2-')), 'state.json');
    const logPath = join(dirname(statePath), 'run.log');
    writeState({ lastMessageId: 6, windowUntil: 0, lastPollAt: 0 }, statePath);

    for (const [i, text] of QUESTIONS.entries()) {
      const r = await answerOnce({
        dialog,
        question: { id: i + 1, date: new Date(), text, urls: [], out: false, hasButtons: false },
        transcript: [],
        statePath,
        logPath,
        generate: async () => ({ ok: true as const, text: 'не должно уйти' }),
        delay: async () => {},
      });
      expect(r).toBe('idle');
    }
    expect(dialog.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Цикл целиком: фейковый диалог, фейковые часы, никакого реального ожидания.

const MIN = 60_000;
const CFG: GigarecruiterConfig = { username: 'Giga_recruiter_bot', vpnExe: 'vpn.exe', ...DEFAULT_GIGARECRUITER };
type Gen = NonNullable<RunOptions['generate']>;

function msg(id: number, text: string, over: Partial<DialogMessage> = {}): DialogMessage {
  return { id, date: new Date(), text, urls: [], out: false, hasButtons: false, ...over };
}

/**
 * Стенд цикла. Часы двигает только sleep: 5 секунд поллинга, пауза перед
 * ответом (random = 0 → ровно 40 с), бэкофф. События `at` срабатывают, когда
 * часы через них перешагнули.
 */
function harness(seed: DialogMessage[] = [], state?: Partial<RunnerState>) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-run-'));
  const statePath = join(dir, 'interview-state.json');
  const logPath = join(dir, 'interview.log');
  const lockPath = join(dir, 'interview.lock');
  if (state !== undefined) writeState({ lastMessageId: 0, windowUntil: 0, lastPollAt: 0, ...state }, statePath);
  const t0 = Date.now();
  let clock = t0;
  const events: { at: number; run: () => void }[] = [];
  const sleeps: number[] = [];
  const dialog = fakeDialog(seed);
  const generate = vi.fn<Gen>(async () => ({ ok: true, text: 'Ответ.' }));
  const openDialog = vi.fn<NonNullable<RunOptions['openDialog']>>(async () => ({ ok: true, dialog }));

  const now = (): number => clock;
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
    clock += ms;
    if (clock - t0 > 48 * 60 * MIN) throw new Error('цикл не остановился за двое суток');
    for (const e of events.filter((x) => x.at <= clock)) {
      events.splice(events.indexOf(e), 1);
      e.run();
    }
  };

  return {
    dialog, statePath, logPath, lockPath, t0, sleeps, generate, openDialog, now,
    /** Событие через `ms` после старта. */
    at(ms: number, run: () => void): void { events.push({ at: t0 + ms, run }); },
    journal: (): string => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''),
    run(over: Partial<RunOptions> = {}): Promise<void> {
      return runInterview({
        config: CFG,
        resume: 'резюме',
        models: ['m'],
        now,
        sleep,
        random: () => 0,
        openDialog,
        vpn: { isUp: async () => true, restart: async () => true },
        generate,
        statePath,
        logPath,
        lockPath,
        pid: 4242,
        isAlive: () => false,
        ...over,
      });
    },
  };
}

describe('runInterview: поллинг', () => {
  it('новых входящих нет — выход сразу, без отправки и без ожидания, одна строка в журнал', async () => {
    const h = harness([msg(5, 'Старый вопрос')], { lastMessageId: 5 });
    await h.run();
    expect(h.dialog.sent).toEqual([]);
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.now()).toBe(h.t0);
    expect(h.journal().trim().split('\n')).toHaveLength(1);
    expect(h.journal()).toMatch(/новых входящих нет/);
  });

  it('есть новое — отвечает и живёт до idleMinutes тишины после последнего сообщения', async () => {
    const h = harness([msg(1, 'Первый вопрос')]);
    h.at(5 * MIN, () => h.dialog.push('Второй вопрос'));
    await h.run();
    expect(h.dialog.sent).toHaveLength(2);
    // Второй ответ ушёл на 5:40, дальше десять минут тишины.
    expect(h.now()).toBe(h.t0 + 15 * MIN + 40_000);
    expect(h.journal()).toMatch(/сессия закрыта/);
  });

  it('lastPollAt ставится в конце сессии', async () => {
    const h = harness([msg(1, 'Вопрос')]);
    await h.run();
    expect(readState(h.statePath).lastPollAt).toBe(h.now());
  });
});

describe('runInterview: окно', () => {
  it('ждёт первое сообщение дольше idleMinutes, после ответа гаснет по тишине', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(30 * MIN, () => h.dialog.push('Почему ищете работу?'));
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    // Ответ на 30:40, десять минут тишины — и выход задолго до конца окна.
    expect(h.now()).toBe(h.t0 + 40 * MIN + 40_000);
  });

  it('без единого сообщения живёт ровно до windowUntil', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    await h.run();
    expect(h.dialog.sent).toEqual([]);
    expect(h.now()).toBe(h.t0 + 120 * MIN);
  });

  it('окно закрылось посреди разговора — сессия доживает до тишины, а не рвётся', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(115 * MIN, () => h.dialog.push('Вопрос под конец окна'));
    h.at(122 * MIN, () => h.dialog.push('Вопрос уже после окна'));
    await h.run();
    expect(h.dialog.sent).toHaveLength(2);
    expect(h.now()).toBe(h.t0 + 132 * MIN + 40_000);
  });

  it('окно открыли заново посреди сессии (новый отклик) — сессия держится до нового windowUntil', async () => {
    const h = harness([msg(1, 'Вопрос')]);
    h.at(2 * MIN, () => openWindow(h.now(), CFG.windowMinutes, h.statePath));
    await h.run();
    expect(h.now()).toBe(h.t0 + 122 * MIN);
  });
});

describe('runInterview: что отвечается', () => {
  it('своё исходящее не отвечается: состояние потеряно, наш ответ последний — не уходит ничего (R13)', async () => {
    const h = harness([msg(1, 'Вопрос бота'), msg(2, 'Мой ответ', { out: true })]);
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    await h.run();
    expect(h.dialog.sent).toEqual([]);
    expect(h.generate).not.toHaveBeenCalled();
    expect(readState(h.statePath).lastMessageId).toBe(2);
  });

  it('то же в поллинге: файла состояния нет вовсе — выход без отправки', async () => {
    const h = harness([msg(1, 'Вопрос бота'), msg(2, 'Мой ответ', { out: true })]);
    await h.run();
    expect(h.dialog.sent).toEqual([]);
    expect(h.now()).toBe(h.t0);
  });

  it('вопрос после нашего сообщения — отвечается, транскрипт до него со своими репликами', async () => {
    const h = harness([msg(1, 'Здравствуйте', { out: true }), msg(2, 'Вопрос бота')]);
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.generate.mock.calls[0]![0].transcript).toEqual([{ who: 'me', text: 'Здравствуйте' }]);
  });

  it('два входящих подряд — один ответ на склейку, метка на момент отправки — последний из группы (R9)', async () => {
    const h = harness([msg(1, 'Спасибо за ответ!'), msg(2, 'Расскажите про Kafka?')]);
    const atSend: number[] = [];
    const send = h.dialog.send;
    h.dialog.send = async (text) => { atSend.push(readState(h.statePath).lastMessageId); await send(text); };
    await h.run();
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.generate.mock.calls[0]![0].question).toBe('Спасибо за ответ!\nРасскажите про Kafka?');
    expect(h.dialog.sent).toHaveLength(1);
    expect(atSend).toEqual([2]);
  });

  it('продолжение пришло во время паузы перед ответом — ответ пересобирается и уходит один раз', async () => {
    const h = harness([msg(1, 'Спасибо за ответ!')]);
    h.at(20_000, () => h.dialog.push('Какой у вас опыт с Kafka?'));
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(h.generate.mock.calls[1]![0].question).toBe('Спасибо за ответ!\nКакой у вас опыт с Kafka?');
  });

  it('сообщение с кнопками не отвечается, метка уходит за него (R7)', async () => {
    const h = harness([msg(1, 'Оцените собеседование', { hasButtons: true })]);
    await h.run();
    expect(h.dialog.sent).toEqual([]);
    expect(h.generate).not.toHaveBeenCalled();
    expect(readState(h.statePath).lastMessageId).toBe(1);
    expect(h.journal().match(/кнопками/g)).toHaveLength(1);
  });

  it('кнопки рядом с вопросом — в вопрос не попадают', async () => {
    const h = harness([msg(1, 'Какой опыт с SQL?'), msg(2, 'Выберите вакансию', { hasButtons: true })]);
    await h.run();
    expect(h.generate.mock.calls[0]![0].question).toBe('Какой опыт с SQL?');
    expect(h.dialog.sent).toHaveLength(1);
  });

  it('входящее старше суток не отвечается: метка за него, строка в журнал, выход (R14)', async () => {
    const h = harness([msg(1, 'Спасибо за интервью!', { date: new Date(Date.now() - 10 * 24 * 60 * MIN) })]);
    await h.run();
    expect(h.dialog.sent).toEqual([]);
    expect(readState(h.statePath).lastMessageId).toBe(1);
    expect(h.journal()).toMatch(/старше суток/);
    expect(h.now()).toBe(h.t0);
  });

  it('возраст меряется по внедрённым часам: 25 часов — пропуск, 23 часа — ответ', async () => {
    const stale = harness([msg(1, 'Вопрос')]);
    await stale.run({ now: () => stale.now() + 25 * 60 * MIN });
    expect(stale.dialog.sent).toEqual([]);

    const fresh = harness([msg(1, 'Вопрос')]);
    await fresh.run({ now: () => fresh.now() + 23 * 60 * MIN });
    expect(fresh.dialog.sent).toHaveLength(1);
  });
});

describe('runInterview: провал моделей', () => {
  it('в чат ничего, бэкофф, повтор на следующей итерации, затем один ответ', async () => {
    const h = harness([msg(1, 'Вопрос')]);
    h.generate.mockResolvedValueOnce({ ok: false, failure: 'm: выдуманное число' });
    await h.run();
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(h.sleeps[0]).toBe(backoffFor(0));
    expect(h.dialog.sent).toEqual(['Ответ.']);
    expect(h.journal()).toMatch(/брак/);
  });

  it('модели лежат всё окно — не уходит ничего, повторы по лестнице до конца окна', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.dialog.push('Вопрос');
    h.generate.mockResolvedValue({ ok: false, failure: 'm: 429' });
    await h.run();
    expect(h.dialog.sent).toEqual([]);
    // 0; 0,5; 2,5; 7,5; дальше каждые 15 минут до 112,5; последний сон обрезан концом окна.
    expect(h.generate).toHaveBeenCalledTimes(11);
    expect(h.now()).toBe(h.t0 + 120 * MIN);
  });
});

describe('runInterview: один экземпляр и уборка', () => {
  it('блокировка взята на время работы и снята после', async () => {
    const h = harness([msg(1, 'Вопрос')]);
    let during = '';
    h.openDialog.mockImplementation(async () => {
      during = readFileSync(h.lockPath, 'utf8');
      return { ok: true, dialog: h.dialog };
    });
    await h.run();
    expect(during).toBe('4242');
    expect(existsSync(h.lockPath)).toBe(false);
  });

  it('блокировку держит живой процесс — диалог не открывается, строка в журнал', async () => {
    const h = harness([msg(1, 'Вопрос')]);
    writeFileSync(h.lockPath, '999', 'utf8');
    await h.run({ isAlive: (pid) => pid === 999 });
    expect(h.openDialog).not.toHaveBeenCalled();
    expect(h.dialog.sent).toEqual([]);
    expect(readFileSync(h.lockPath, 'utf8')).toBe('999');
    expect(h.journal()).toMatch(/pid 999/);
  });

  it('блокировка мёртвого процесса перехватывается', async () => {
    const h = harness([msg(1, 'Вопрос')]);
    writeFileSync(h.lockPath, '999', 'utf8');
    await h.run({ isAlive: () => false });
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.journal()).toMatch(/перехвач/);
    expect(existsSync(h.lockPath)).toBe(false);
  });

  it('history() бросает — ошибка в журнал, диалог закрыт, блокировка снята, промис не отклонён', async () => {
    const h = harness();
    h.dialog.history = async () => { throw new Error('AUTH_KEY_UNREGISTERED'); };
    const close = vi.spyOn(h.dialog, 'close');
    await expect(h.run()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    expect(existsSync(h.lockPath)).toBe(false);
    expect(h.journal()).toMatch(/AUTH_KEY_UNREGISTERED/);
  });

  it('send() бросает посреди сессии — метка уже сдвинута, диалог закрыт, блокировка снята', async () => {
    const h = harness([msg(1, 'Вопрос')]);
    h.dialog.send = async () => { throw new Error('FLOOD_WAIT'); };
    const close = vi.spyOn(h.dialog, 'close');
    await h.run();
    expect(readState(h.statePath).lastMessageId).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(existsSync(h.lockPath)).toBe(false);
  });

  it('VPN не поднялся — диалог не открывается, строка в журнал, блокировка снята', async () => {
    const h = harness([msg(1, 'Вопрос')]);
    const restart = vi.fn(async (_exe: string) => false);
    await h.run({ vpn: { isUp: async () => false, restart } });
    expect(restart).toHaveBeenCalledWith('vpn.exe');
    expect(h.openDialog).not.toHaveBeenCalled();
    expect(h.journal()).toMatch(/VPN не поднялся/);
    expect(existsSync(h.lockPath)).toBe(false);
  });

  it('VPN поднялся после рестарта — работа идёт дальше', async () => {
    const h = harness([msg(1, 'Вопрос')]);
    await h.run({ vpn: { isUp: async () => false, restart: async () => true } });
    expect(h.dialog.sent).toHaveLength(1);
  });

  it('диалог не открылся — причина в журнал, больше ничего', async () => {
    const h = harness([msg(1, 'Вопрос')]);
    h.openDialog.mockResolvedValue({ ok: false, reason: 'сессия протухла' });
    await h.run();
    expect(h.journal()).toMatch(/диалог не открылся: сессия протухла/);
    expect(existsSync(h.lockPath)).toBe(false);
  });
});

describe('runInterview: шесть реальных вопросов 2026-09-15 целиком через цикл', () => {
  it('каждый вопрос получает один ответ, транскрипт растёт, текст диалога в журнал не попадает', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    let n = 0;
    h.generate.mockImplementation(async () => ({ ok: true, text: `Ответ ${++n}.` }));
    for (const [i, q] of QUESTIONS.entries()) h.at((i + 1) * 5 * MIN, () => h.dialog.push(q));
    await h.run();

    expect(h.dialog.sent).toEqual(QUESTIONS.map((_, i) => `Ответ ${i + 1}.`));
    expect(h.generate.mock.calls.map((c) => c[0].question)).toEqual(QUESTIONS);
    const last = h.generate.mock.calls[5]![0].transcript;
    expect(last).toHaveLength(10);
    expect(last.at(-1)).toEqual({ who: 'me', text: 'Ответ 5.' });
    const journal = h.journal();
    for (const q of QUESTIONS) expect(journal).not.toContain(q);
  });
});
