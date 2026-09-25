import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fakeDialog, type DialogMessage } from '../src/telegram/interview-session.js';
import {
  answerOnce, readState, writeState, openWindow, runInterview, backoffFor, POLL_MS, type RunnerState, type RunOptions,
} from '../src/core/interview-runner.js';
import { LOCK_MAX_AGE_MS } from '../src/core/interview-lock.js';
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
    writeState({ lastMessageId: 6, windowUntil: 0, lastPollAt: 0, capTrippedAt: 0 }, statePath);

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
  if (state !== undefined) writeState({ lastMessageId: 0, windowUntil: 0, lastPollAt: 0, capTrippedAt: 0, ...state }, statePath);
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

  it('в транскрипт не попадает прошлое интервью старше суток — только свежий разговор (M3)', async () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * MIN);
    const h = harness([
      msg(1, 'Вопрос прошлого интервью', { date: old }),
      msg(2, 'Ответ про другую вакансию', { out: true, date: old }),
      msg(3, 'Спасибо за интервью!', { date: old }),
      msg(4, 'Здравствуйте! Почему ищете работу?'),
      msg(5, 'Хочу больше масштаба.', { out: true }),
      msg(6, 'Какой у вас опыт с Kafka?'),
    ]);
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.generate.mock.calls[0]![0].transcript).toEqual([
      { who: 'bot', text: 'Здравствуйте! Почему ищете работу?' },
      { who: 'me', text: 'Хочу больше масштаба.' },
    ]);
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

describe('runInterview: потолок ответов и конец интервью (C1)', () => {
  /**
   * ГигаРекрутёр — тоже модель: на каждый наш ответ приходит встречная
   * реплика. Возвращает функцию, которая его успокаивает.
   */
  function chatty(h: ReturnType<typeof harness>): () => void {
    const send = h.dialog.send;
    let n = 0;
    h.dialog.send = async (text) => { await send(text); h.dialog.push(`Встречная реплика ${++n}`); };
    return () => { h.dialog.send = send; };
  }

  it('бот отвечает на каждый ответ — уходит ровно maxRepliesPerSession ответов, строка в журнал, выход', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.dialog.push('Первый вопрос');
    chatty(h);
    await h.run();
    expect(h.dialog.sent).toHaveLength(12);
    expect(CFG.maxRepliesPerSession).toBe(12);
    expect(h.journal()).toMatch(/потолок 12 ответов/);
    // Двенадцатый ответ ушёл на 12 × 40 с паузы + 11 × 5 с поллинга — и сразу выход,
    // не дожидаясь ни тишины, ни конца окна.
    expect(h.now()).toBe(h.t0 + 12 * 40_000 + 11 * POLL_MS);
  });

  it('потолок берётся из конфига', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.dialog.push('Первый вопрос');
    chatty(h);
    await h.run({ config: { ...CFG, maxRepliesPerSession: 3 } });
    expect(h.dialog.sent).toHaveLength(3);
  });

  it('потолок запоминается: следующий поллинг с новыми входящими не отвечает — одна строка и выход (FR-6)', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.dialog.push('Первый вопрос');
    chatty(h);
    await h.run({ config: { ...CFG, maxRepliesPerSession: 3 } });
    expect(h.dialog.sent).toHaveLength(3);
    expect(readState(h.statePath).capTrippedAt).toBe(h.now());

    // Четыре часа спустя поллинг: в чате встречная реплика и ещё один вопрос.
    h.dialog.push('Ещё вопрос');
    const later = (): number => h.now() + 4 * 60 * MIN;
    const linesBefore = h.journal().trim().split('\n').length;
    h.openDialog.mockClear();
    h.generate.mockClear();
    await h.run({ now: later });
    expect(h.dialog.sent).toHaveLength(3);
    expect(h.openDialog).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
    const added = h.journal().trim().split('\n').slice(linesBefore);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/потолок/);
    expect(existsSync(h.lockPath)).toBe(false);
  });

  it('потолок запомнен, окно ещё открыто, но не новое — тоже ничего (FR-6)', async () => {
    const h = harness([msg(1, 'Вопрос')], { windowUntil: Date.now() + 60 * MIN, capTrippedAt: Date.now() - MIN });
    await h.run();
    expect(h.dialog.sent).toEqual([]);
    expect(h.openDialog).not.toHaveBeenCalled();
    expect(h.journal()).toMatch(/потолок/);
  });

  it('новое окно (отклик на Сбер или --window) снимает запомненный потолок — следующий запуск отвечает (FR-6)', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.dialog.push('Первый вопрос');
    const calm = chatty(h);
    await h.run({ config: { ...CFG, maxRepliesPerSession: 3 } });
    expect(readState(h.statePath).capTrippedAt).toBeGreaterThan(0);
    calm();

    const later = (): number => h.now() + 4 * 60 * MIN;
    openWindow(later(), CFG.windowMinutes, h.statePath);
    expect(readState(h.statePath).capTrippedAt).toBe(0);
    h.dialog.push('Здравствуйте! Это новое интервью.');
    await h.run({ now: later });
    expect(h.dialog.sent).toHaveLength(4);
    expect(readState(h.statePath).capTrippedAt).toBe(0);
  });

  it('после ответа пришли прощание и оценка с кнопками — не отвечается ничего, метка за обоими, выход', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push('Почему ищете работу?'));
    h.at(5 * MIN, () => {
      h.dialog.push('Спасибо за интервью!');
      h.dialog.push('Оцените собеседование', { hasButtons: true });
    });
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.generate).toHaveBeenCalledTimes(1);
    const rating = (await h.dialog.history(0)).at(-1)!;
    expect(rating.text).toBe('Оцените собеседование');
    expect(readState(h.statePath).lastMessageId).toBe(rating.id);
    expect(h.journal()).toMatch(/конец интервью/);
    expect(h.now()).toBe(h.t0 + 5 * MIN);
    // Обычный конец интервью — не потолок: следующий отклик отвечается как обычно.
    expect(readState(h.statePath).capTrippedAt).toBe(0);
  });

  it('оценка пришла во время паузы перед ответом на прощание — прощание тоже остаётся без ответа', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push('Почему ищете работу?'));
    h.at(5 * MIN, () => h.dialog.push('Спасибо за интервью!'));
    h.at(5 * MIN + 20_000, () => h.dialog.push('Оцените собеседование', { hasButtons: true }));
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    const rating = (await h.dialog.history(0)).at(-1)!;
    expect(readState(h.statePath).lastMessageId).toBe(rating.id);
    expect(h.journal()).toMatch(/конец интервью/);
  });

  it('кнопки до первого ответа (выбор вакансии) сессию не заканчивают — вопрос после них отвечается', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push('Выберите вакансию', { hasButtons: true }));
    h.at(2 * MIN, () => h.dialog.push('Почему ищете работу?'));
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.journal()).not.toMatch(/конец интервью/);
  });
});

describe('runInterview: конец интервью виден и новому процессу (H2)', () => {
  const ago = (ms: number): Date => new Date(Date.now() - ms);
  const DAY = 24 * 60 * MIN;

  it('(a) сессия погасла по тишине, потом пришли прощание и оценка — новый процесс не отвечает ничего', async () => {
    // Прошлая сессия ответила 30 минут назад и сдвинула метку за свой ответ.
    const h = harness([
      msg(1, 'Почему ищете работу?', { date: ago(40 * MIN) }),
      msg(2, 'Хочу больше масштаба.', { out: true, date: ago(30 * MIN) }),
      msg(3, 'Спасибо за интервью!'),
      msg(4, 'Оцените собеседование', { hasButtons: true }),
    ], { lastMessageId: 2 });
    await h.run();
    expect(h.dialog.sent).toEqual([]);
    expect(h.generate).not.toHaveBeenCalled();
    expect(readState(h.statePath).lastMessageId).toBe(4);
    expect(h.journal().match(/конец интервью/g)).toHaveLength(1);
    expect(h.now()).toBe(h.t0);
    expect(readState(h.statePath).capTrippedAt).toBe(0);
  });

  it('(a) то же, когда метка стоит на вопросе, а наш ответ ещё в пачке', async () => {
    const h = harness([
      msg(1, 'Почему ищете работу?', { date: ago(40 * MIN) }),
      msg(2, 'Хочу больше масштаба.', { out: true, date: ago(30 * MIN) }),
      msg(3, 'Спасибо за интервью!'),
      msg(4, 'Оцените собеседование', { hasButtons: true }),
    ], { lastMessageId: 1 });
    await h.run();
    expect(h.dialog.sent).toEqual([]);
    expect(readState(h.statePath).lastMessageId).toBe(4);
    expect(h.journal()).toMatch(/конец интервью/);
  });

  it('(b) окно переоткрыли посреди интервью (счётчик ответов сброшен) — прощание с оценкой без ответа', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push('Почему ищете работу?'));
    // Новый отклик на Сбер открыл окно заново, пока шло интервью.
    h.at(3 * MIN, () => openWindow(h.now(), CFG.windowMinutes, h.statePath));
    h.at(5 * MIN, () => {
      h.dialog.push('Спасибо за интервью!');
      h.dialog.push('Оцените собеседование', { hasButtons: true });
    });
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.generate).toHaveBeenCalledTimes(1);
    const rating = (await h.dialog.history(0)).at(-1)!;
    expect(readState(h.statePath).lastMessageId).toBe(rating.id);
    expect(h.journal().match(/конец интервью/g)).toHaveLength(1);
    expect(h.now()).toBe(h.t0 + 5 * MIN);
    expect(readState(h.statePath).capTrippedAt).toBe(0);
  });

  it('(c) наш ответ двухдневной давности, старая оценка, новый выбор вакансии и вопрос — вопрос отвечается, это не конец', async () => {
    const h = harness([
      msg(1, 'Вопрос прошлого интервью', { date: ago(2 * DAY + 10 * MIN) }),
      msg(2, 'Ответ про другую вакансию', { out: true, date: ago(2 * DAY) }),
      msg(3, 'Оцените собеседование', { hasButtons: true, date: ago(2 * DAY - MIN) }),
      msg(4, 'Выберите вакансию', { hasButtons: true }),
      msg(5, 'Почему ищете работу?'),
    ], { lastMessageId: 3 });
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.generate.mock.calls[0]![0].question).toBe('Почему ищете работу?');
    expect(h.journal()).toMatch(/пропущено сообщение с кнопками 4/);
    expect(h.journal()).not.toMatch(/конец интервью/);
  });

  it('(c) то же без файла состояния: старые сообщения в пачке, наш ответ старше суток — не конец', async () => {
    const h = harness([
      msg(1, 'Вопрос прошлого интервью', { date: ago(2 * DAY + 10 * MIN) }),
      msg(2, 'Ответ про другую вакансию', { out: true, date: ago(2 * DAY) }),
      msg(3, 'Оцените собеседование', { hasButtons: true, date: ago(2 * DAY - MIN) }),
      msg(4, 'Выберите вакансию', { hasButtons: true }),
      msg(5, 'Почему ищете работу?'),
    ]);
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.journal()).not.toMatch(/конец интервью/);
  });

  it('(c) новое интервью в тот же день: выбор вакансии идёт за оценкой бота, а не за нашим ответом — не конец', async () => {
    const h = harness([
      msg(1, 'Вопрос прошлого интервью', { date: ago(3 * 60 * MIN + 5 * MIN) }),
      msg(2, 'Ответ про другую вакансию', { out: true, date: ago(3 * 60 * MIN) }),
      msg(3, 'Спасибо за интервью!', { date: ago(3 * 60 * MIN - MIN) }),
      msg(4, 'Оцените собеседование', { hasButtons: true, date: ago(3 * 60 * MIN - MIN) }),
      msg(5, 'Выберите вакансию', { hasButtons: true }),
      msg(6, 'Почему ищете работу?'),
    ], { lastMessageId: 4 });
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.journal()).not.toMatch(/конец интервью/);
  });

  it('(c) выбор вакансии сразу за нашим ответом старше суток — не конец, вопрос отвечается', async () => {
    const h = harness([
      msg(1, 'Вопрос прошлого интервью', { date: ago(DAY + 70 * MIN) }),
      msg(2, 'Ответ про другую вакансию', { out: true, date: ago(DAY + 60 * MIN) }),
      msg(3, 'Выберите вакансию', { hasButtons: true }),
      msg(4, 'Почему ищете работу?'),
    ], { lastMessageId: 2 });
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.journal()).not.toMatch(/конец интервью/);
  });

  it('(d) новый процесс: прощание пришло одно, оценка — во время паузы перед ответом; не уходит ничего', async () => {
    const h = harness([
      msg(1, 'Почему ищете работу?', { date: ago(40 * MIN) }),
      msg(2, 'Хочу больше масштаба.', { out: true, date: ago(30 * MIN) }),
    ], { lastMessageId: 2 });
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push('Спасибо за интервью!'));
    // Пауза перед ответом — 40 с (random = 0): оценка приходит посреди неё.
    h.at(1 * MIN + 20_000, () => h.dialog.push('Оцените собеседование', { hasButtons: true }));
    await h.run();
    expect(h.dialog.sent).toEqual([]);
    expect(h.generate).toHaveBeenCalledTimes(1);
    const rating = (await h.dialog.history(0)).at(-1)!;
    expect(rating.text).toBe('Оцените собеседование');
    expect(readState(h.statePath).lastMessageId).toBe(rating.id);
    expect(h.journal()).toMatch(/пересобирается/);
    expect(h.journal().match(/конец интервью/g)).toHaveLength(1);
    expect(readState(h.statePath).capTrippedAt).toBe(0);
  });
});

describe('runInterview: сбои history() (D2)', () => {
  /** history() падает на вызовах, для номера которых (с единицы) `fails` вернула true. */
  function flaky(h: ReturnType<typeof harness>, fails: (call: number) => boolean): { calls: () => number } {
    const history = h.dialog.history;
    let calls = 0;
    h.dialog.history = async (minId) => {
      calls += 1;
      if (fails(calls)) throw new Error('ECONNRESET');
      return history(minId);
    };
    return { calls: () => calls };
  }

  it('три сбоя подряд терпятся: строка в журнал на каждый, 5 с между попытками, разговор идёт', async () => {
    const h = harness([msg(1, 'Вопрос')]);
    flaky(h, (n) => n <= 3);
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.journal().match(/ECONNRESET/g)).toHaveLength(3);
    expect(h.sleeps.slice(0, 3)).toEqual([POLL_MS, POLL_MS, POLL_MS]);
  });

  it('четвёртый сбой подряд заканчивает сессию, как раньше', async () => {
    const h = harness([msg(1, 'Вопрос')]);
    const f = flaky(h, () => true);
    const close = vi.spyOn(h.dialog, 'close');
    await h.run();
    expect(f.calls()).toBe(4);
    expect(h.dialog.sent).toEqual([]);
    expect(h.journal()).toMatch(/сессия прервана ошибкой: ECONNRESET/);
    expect(close).toHaveBeenCalledTimes(1);
    expect(existsSync(h.lockPath)).toBe(false);
  });

  it('успешное чтение обнуляет счётчик: 3 сбоя, успех, ещё 3 сбоя — сессия жива, вопрос отвечен', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    flaky(h, (n) => [1, 2, 3, 5, 6, 7].includes(n));
    h.at(1 * MIN, () => h.dialog.push('Вопрос'));
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.journal()).not.toMatch(/прервана/);
  });

  it('сбой при перечитывании перед отправкой — ответ не уходит вслепую, пересобирается и уходит один раз', async () => {
    const h = harness([msg(1, 'Вопрос')]);
    // 1 — поллинг, 2 — транскрипт, 3 — перечитывание после паузы.
    flaky(h, (n) => n === 3);
    await h.run();
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(h.dialog.sent).toHaveLength(1);
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

  /** Окно на 120 минут: Q1 в 1:00 отвечается, Q2 приходит в 5:00. */
  function afterFirstAnswer(failQ2Until: number) {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push('Первый вопрос'));
    h.at(5 * MIN, () => h.dialog.push('Второй вопрос'));
    h.generate.mockImplementation(async ({ question }) => (
      question.includes('Второй') && h.now() < h.t0 + failQ2Until
        ? { ok: false, failure: 'm: 429' }
        : { ok: true, text: 'Ответ.' }));
    const sentAt: number[] = [];
    const send = h.dialog.send;
    h.dialog.send = async (text) => { sentAt.push(h.now()); await send(text); };
    return { h, sentAt };
  }

  it('после первого ответа модели легли на Q2 — повторы идут, пока открыто окно, а не 10 минут', async () => {
    const { h, sentAt } = afterFirstAnswer(40 * MIN);
    await h.run();
    expect(h.dialog.sent).toHaveLength(2);
    // Q2: 5:00, 5:30, 7:30, 12:30, 27:30 — брак; 42:30 — годный, после паузы уходит в 43:10.
    expect(sentAt[1]).toBe(h.t0 + 43 * MIN + 10_000);
    expect(h.journal()).not.toMatch(/сессия закрыта: ответов 1/);
    expect(h.now()).toBe(h.t0 + 53 * MIN + 10_000);
  });

  it('после первого ответа модели лежат до конца — сессия гаснет по windowUntil, на Q2 не уходит ничего', async () => {
    const { h } = afterFirstAnswer(Number.POSITIVE_INFINITY);
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    // 5:00, 5:30, 7:30, 12:30, дальше каждые 15 минут до 117:30; последний сон обрезан концом окна.
    expect(h.generate.mock.calls.filter((c) => c[0].question.includes('Второй'))).toHaveLength(11);
    expect(h.now()).toBe(h.t0 + 120 * MIN);
  });

  it('поллинг: модели лежат — сессия по-прежнему гаснет через idleMinutes', async () => {
    const h = harness([msg(1, 'Вопрос')]);
    h.generate.mockResolvedValue({ ok: false, failure: 'm: 429' });
    await h.run();
    expect(h.dialog.sent).toEqual([]);
    // 0:00, 0:30, 2:30, 7:30 — брак; сон обрезан до 10:00, конец сессии.
    expect(h.generate).toHaveBeenCalledTimes(4);
    expect(h.now()).toBe(h.t0 + 10 * MIN);
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
    expect(JSON.parse(during)).toEqual({ pid: 4242, at: h.t0 });
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

  it('блокировка живого процесса старше трёх часов считается брошенной и перехватывается (D1)', async () => {
    const h = harness([msg(1, 'Вопрос')]);
    writeFileSync(h.lockPath, JSON.stringify({ pid: 999, at: h.t0 - LOCK_MAX_AGE_MS - 1 }), 'utf8');
    await h.run({ isAlive: () => true });
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.journal()).toMatch(/перехвач/);
    expect(existsSync(h.lockPath)).toBe(false);
  });

  it('живой цикл продлевает метку блокировки — длинная сессия брошенной не считается', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    let at = 0;
    h.at(30 * MIN, () => { at = (JSON.parse(readFileSync(h.lockPath, 'utf8')) as { at: number }).at; });
    await h.run();
    expect(at).toBe(h.t0 + 30 * MIN - POLL_MS);
  });

  it('блокировку перехватили посреди сессии — цикл выходит и чужую блокировку не снимает', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    const foreign = JSON.stringify({ pid: 7, at: h.t0 });
    h.at(10 * MIN, () => writeFileSync(h.lockPath, foreign, 'utf8'));
    h.at(20 * MIN, () => h.dialog.push('Вопрос'));
    await h.run();
    expect(h.dialog.sent).toEqual([]);
    expect(h.journal()).toMatch(/другой экземпляр/);
    expect(readFileSync(h.lockPath, 'utf8')).toBe(foreign);
    expect(h.now()).toBe(h.t0 + 10 * MIN);
  });

  it('блокировку перехватили во время паузы перед ответом — ответ не уходит, метка не двигается, выход (FR-5)', async () => {
    const h = harness([msg(1, 'Вопрос')]);
    const foreign = JSON.stringify({ pid: 7, at: h.t0 });
    // Пауза перед ответом — 40 с; перехват посреди неё.
    h.at(20_000, () => writeFileSync(h.lockPath, foreign, 'utf8'));
    await h.run();
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.dialog.sent).toEqual([]);
    // Вопрос остаётся новому владельцу: метка за него не ушла.
    expect(readState(h.statePath).lastMessageId).toBe(0);
    expect(h.journal()).toMatch(/другой экземпляр/);
    expect(readFileSync(h.lockPath, 'utf8')).toBe(foreign);
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
