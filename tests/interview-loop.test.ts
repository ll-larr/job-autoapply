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

// Цикл гоняет сотни проходов на фейковых часах: под нагрузкой всего набора
// отдельный тест временами не укладывается в 5 с по умолчанию. Только этот файл.
vi.setConfig({ testTimeout: 20_000 });

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
      const question = { id: i + 1, date: new Date(), text, urls: [], out: false, hasButtons: false, buttons: [] };
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
    writeState({ lastMessageId: 6, windowUntil: 0, lastPollAt: 0, capTrippedAt: 0, interviewEndedAt: 0, currentTitle: '', interviewedTitles: [], interviewsInWindow: 0, lastStartId: 0, pressedPromptId: 0, pagedPromptId: 0, pagedSnapshot: '' }, statePath);

    for (const [i, text] of QUESTIONS.entries()) {
      const r = await answerOnce({
        dialog,
        question: { id: i + 1, date: new Date(), text, urls: [], out: false, hasButtons: false, buttons: [] },
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
const CFG: GigarecruiterConfig = {
  ...DEFAULT_GIGARECRUITER, username: 'Giga_recruiter_bot', vpnService: 'VpnService', vpnApp: 'C:\\Vpn\\Gui.exe',
};
type Gen = NonNullable<RunOptions['generate']>;

function msg(id: number, text: string, over: Partial<DialogMessage> = {}): DialogMessage {
  return { id, date: new Date(), text, urls: [], out: false, hasButtons: false, buttons: [], ...over };
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
  if (state !== undefined) writeState({ lastMessageId: 0, windowUntil: 0, lastPollAt: 0, capTrippedAt: 0, interviewEndedAt: 0, currentTitle: '', interviewedTitles: [], interviewsInWindow: 0, lastStartId: 0, pressedPromptId: 0, pagedPromptId: 0, pagedSnapshot: '', ...state }, statePath);
  const t0 = Date.now();
  let clock = t0;
  const events: { at: number; run: () => void }[] = [];
  const sleeps: number[] = [];
  // Даты новых сообщений — по фейковым часам стенда, как в живом чате (FU-9).
  const dialog = fakeDialog(seed, () => clock);
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
        // Сессия личного аккаунта есть (G1): настоящий data/ тесты не трогают.
        hasSession: () => true,
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
    expect(h.journal().match(/конец интервью/g)).toHaveLength(1);
    // Свежий конец (оценка пришла в текущем окне) заканчивает сессию сразу, хоть
    // окно и открыто, и запоминается до нового окна (FU-9).
    expect(h.now()).toBe(h.t0 + 5 * MIN);
    expect(readState(h.statePath).interviewEndedAt).toBe(h.t0 + 5 * MIN);
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
    // Оценка пришла после переоткрытия окна — свежий конец: выход сразу (FU-9).
    expect(h.now()).toBe(h.t0 + 5 * MIN);
    expect(readState(h.statePath).interviewEndedAt).toBe(h.t0 + 5 * MIN);
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

  // FU-9: конец старого интервью (оценка до открытия окна) и начало нового
  // могут прийти одной пачкой или подряд.
  const oldEndThenNew = (): DialogMessage[] => [
    msg(1, 'Почему ищете работу?', { date: ago(45 * MIN) }),
    msg(2, 'Хочу больше масштаба.', { out: true, date: ago(40 * MIN) }),
    msg(3, 'Спасибо за интервью!', { date: ago(30 * MIN) }),
    msg(4, 'Оцените собеседование', { hasButtons: true, date: ago(30 * MIN) }),
    msg(5, 'Выберите вакансию', { hasButtons: true }),
    msg(6, 'Здравствуйте! Почему рассматриваете предложения?'),
  ];

  it('(S1) старый конец до открытия окна и новое интервью одной пачкой — новый вопрос отвечается ровно один раз (FU-9)', async () => {
    const h = harness(oldEndThenNew(), { lastMessageId: 2 });
    // Отклик — 5 минут назад; новое интервью началось после него (FU-14 делит пачку по этой дате).
    openWindow(h.t0 - 5 * MIN, CFG.windowMinutes, h.statePath);
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.generate.mock.calls[0]![0].question).toBe('Здравствуйте! Почему рассматриваете предложения?');
    expect(h.journal().match(/хвост прошлого интервью/g)).toHaveLength(1);
    expect(h.journal()).toMatch(/хвост прошлого интервью.* 4 /);
    expect(h.journal()).not.toMatch(/конец интервью/);
    expect(readState(h.statePath).interviewEndedAt).toBe(0);
    expect(readState(h.statePath).capTrippedAt).toBe(0);
  });

  it('(S1) в поллинге окно в прошлом: оценка раньше его открытия — хвост, новый вопрос отвечается (FU-9)', async () => {
    // Окно открыли 3 часа назад (закрылось час назад); прошлое интервью кончилось до него.
    const h = harness([
      msg(1, 'Почему ищете работу?', { date: ago(4 * 60 * MIN + 5 * MIN) }),
      msg(2, 'Хочу больше масштаба.', { out: true, date: ago(4 * 60 * MIN) }),
      msg(3, 'Спасибо за интервью!', { date: ago(3 * 60 * MIN + 30 * MIN) }),
      msg(4, 'Оцените собеседование', { hasButtons: true, date: ago(3 * 60 * MIN + 30 * MIN) }),
      msg(5, 'Выберите вакансию', { hasButtons: true }),
      msg(6, 'Здравствуйте! Почему рассматриваете предложения?'),
    ], { lastMessageId: 2, windowUntil: Date.now() - 60 * MIN });
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.generate.mock.calls[0]![0].question).toBe('Здравствуйте! Почему рассматриваете предложения?');
    expect(h.journal()).toMatch(/хвост прошлого интервью/);
    expect(readState(h.statePath).interviewEndedAt).toBe(0);
  });

  it('хвост режется по первому сообщению с кнопками: метка встаёт на оценку, следующий проход читает после неё (FU-9)', async () => {
    const h = harness(oldEndThenNew().slice(0, 5), { lastMessageId: 2 });
    openWindow(h.t0 - 5 * MIN, CFG.windowMinutes, h.statePath);
    const minIds: number[] = [];
    const history = h.dialog.history;
    h.dialog.history = async (minId) => { minIds.push(minId); return history(minId); };
    await h.run();
    expect(h.dialog.sent).toEqual([]);
    // Первый проход читал после 2, следующий — после оценки 4, а не после клавиатуры 5.
    expect(minIds.slice(0, 3)).toEqual([2, 0, 4]);
    expect(readState(h.statePath).lastMessageId).toBe(5);
  });

  it('(S2) хвост прошлого интервью разобран при открытии окна, новое интервью через 10 минут — отвечается в окне (FU-9)', async () => {
    const h = harness(oldEndThenNew().slice(0, 4), { lastMessageId: 2 });
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(10 * MIN, () => {
      h.dialog.push('Выберите вакансию', { hasButtons: true });
      h.dialog.push('Здравствуйте! Почему рассматриваете предложения?');
    });
    const sentAt: number[] = [];
    const send = h.dialog.send;
    h.dialog.send = async (text) => { sentAt.push(h.now()); await send(text); };
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.generate.mock.calls[0]![0].question).toBe('Здравствуйте! Почему рассматриваете предложения?');
    expect(sentAt[0]!).toBeLessThan(h.t0 + 12 * MIN);
    expect(h.journal().match(/хвост прошлого интервью/g)).toHaveLength(1);
    expect(h.journal()).not.toMatch(/конец интервью/);
    expect(readState(h.statePath).interviewEndedAt).toBe(0);
  });

  it('хвост прошлого интервью после оценки («Если появятся вопросы — пишите!») не отвечается (FU-14)', async () => {
    const h = harness([
      msg(1, 'Почему ищете работу?', { date: ago(45 * MIN) }),
      msg(2, 'Хочу больше масштаба.', { out: true, date: ago(40 * MIN) }),
      msg(3, 'Спасибо за интервью!', { date: ago(30 * MIN) }),
      msg(4, 'Оцените собеседование', { hasButtons: true, date: ago(30 * MIN) }),
      msg(5, 'Если появятся вопросы — пишите!', { date: ago(29 * MIN) }),
    ], { lastMessageId: 2 });
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    await h.run();
    expect(h.dialog.sent).toEqual([]);
    expect(h.generate).not.toHaveBeenCalled();
    expect(readState(h.statePath).lastMessageId).toBe(5);
    expect(h.journal()).toMatch(/хвост прошлого интервью: сообщение с кнопками 4 .*пачка до 5 /);
    expect(readState(h.statePath).interviewEndedAt).toBe(0);
  });

  it('хвост старше открытия окна уходит под метку, а новое после открытия — остаётся и отвечается (FU-14)', async () => {
    const h = harness([
      msg(1, 'Почему ищете работу?', { date: ago(45 * MIN) }),
      msg(2, 'Хочу больше масштаба.', { out: true, date: ago(40 * MIN) }),
      msg(3, 'Спасибо за интервью!', { date: ago(30 * MIN) }),
      msg(4, 'Оцените собеседование', { hasButtons: true, date: ago(30 * MIN) }),
      msg(5, 'Если появятся вопросы — пишите!', { date: ago(29 * MIN) }),
      msg(6, 'Выберите вакансию', { hasButtons: true, date: ago(2 * MIN) }),
      msg(7, 'Здравствуйте! Почему рассматриваете предложения?', { date: ago(MIN) }),
    ], { lastMessageId: 2 });
    openWindow(h.t0 - 5 * MIN, CFG.windowMinutes, h.statePath);
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.generate.mock.calls[0]![0].question).toBe('Здравствуйте! Почему рассматриваете предложения?');
    expect(h.journal()).toMatch(/хвост прошлого интервью: сообщение с кнопками 4 .*пачка до 5 /);
  });

  it('без единого окна любой конец — свежий: пачка со старым концом и новым вопросом не отвечается (FU-9)', async () => {
    const seed = oldEndThenNew();
    const h = harness(seed, { lastMessageId: 2 });
    await h.run();
    expect(h.dialog.sent).toEqual([]);
    expect(readState(h.statePath).lastMessageId).toBe(6);
    // Время конца — дата самой оценки, а не момент разбора (FU-15).
    expect(readState(h.statePath).interviewEndedAt).toBe(seed[3]!.date.getTime());
  });
});

describe('runInterview: запомненный конец интервью (FU-9)', () => {
  /** Окно, вопрос, ответ, затем прощание и оценка на 5-й минуте: свежий конец. */
  async function endedInterview(): Promise<ReturnType<typeof harness>> {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push('Почему ищете работу?'));
    h.at(5 * MIN, () => {
      h.dialog.push('Спасибо за интервью!');
      h.dialog.push('Оцените собеседование', { hasButtons: true });
    });
    await h.run();
    return h;
  }

  it('свежий конец в окне: ничего не уходит, interviewEndedAt запомнен, сессия выходит сразу', async () => {
    const h = await endedInterview();
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.now()).toBe(h.t0 + 5 * MIN);
    expect(readState(h.statePath).interviewEndedAt).toBe(h.t0 + 5 * MIN);
    expect(readState(h.statePath).capTrippedAt).toBe(0);
    expect(h.journal().match(/конец интервью/g)).toHaveLength(1);
  });

  it('«Спасибо за оценку!» после конца — следующий поллинг не отвечает, одна строка', async () => {
    const h = await endedInterview();
    h.dialog.push('Спасибо за оценку!');
    const linesBefore = h.journal().trim().split('\n').length;
    h.openDialog.mockClear();
    h.generate.mockClear();
    await h.run({ now: () => h.now() + 30 * MIN });
    expect(h.dialog.sent).toHaveLength(1);
    // G2: Telegram открывается — в молчании FU-9 видна подсказка выбора
    // вакансии, с которой начнётся следующее интервью. Текст по-прежнему без ответа.
    expect(h.openDialog).toHaveBeenCalledTimes(1);
    expect(h.dialog.presses).toEqual([]);
    expect(h.generate).not.toHaveBeenCalled();
    const added = h.journal().trim().split('\n').slice(linesBefore);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/интервью закончилось/);
    expect(existsSync(h.lockPath)).toBe(false);
  });

  it('то же, пока окно ещё открыто: запуск в том же окне не отвечает', async () => {
    const h = await endedInterview();
    h.dialog.push('Спасибо за оценку!');
    await h.run({ now: () => h.now() + MIN });
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.journal()).toMatch(/интервью закончилось/);
  });

  it('новое окно (новый отклик) снимает конец интервью — следующий запуск отвечает', async () => {
    const h = await endedInterview();
    const later = (): number => h.now() + 60 * MIN;
    openWindow(later(), CFG.windowMinutes, h.statePath);
    expect(readState(h.statePath).interviewEndedAt).toBe(0);
    h.dialog.push('Здравствуйте! Это новое интервью.');
    await h.run({ now: later });
    expect(h.dialog.sent).toHaveLength(2);
    expect(h.generate.mock.calls.at(-1)![0].question).toBe('Здравствуйте! Это новое интервью.');
  });

  it('конец запомнили посреди сессии — следующий проход выходит одной строкой, не отвечая', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => writeState({ ...readState(h.statePath), interviewEndedAt: h.now() }, h.statePath));
    h.at(2 * MIN, () => h.dialog.push('Вопрос после конца'));
    await h.run();
    expect(h.dialog.sent).toEqual([]);
    expect(h.now()).toBeLessThan(h.t0 + 2 * MIN);
    expect(h.journal().match(/интервью закончилось/g)).toHaveLength(1);
  });

  it('новое окно, открытое между чтением состояния и записью конца, не глушится: следующий запуск отвечает (FU-15)', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push('Почему ищете работу?'));
    h.at(5 * MIN, () => {
      h.dialog.push('Спасибо за интервью!');
      h.dialog.push('Оцените собеседование', { hasButtons: true });
    });
    // Проход прочитал состояние и пачку с оценкой; в этот момент новый отклик на
    // Сбер открывает окно, и к записи конца настоящие часы уже впереди.
    let skew = 0;
    let injected = false;
    const history = h.dialog.history;
    h.dialog.history = async (minId) => {
      const r = await history(minId);
      if (!injected && r.some((m) => m.hasButtons)) {
        injected = true;
        openWindow(h.now() + 1_000, CFG.windowMinutes, h.statePath);
        skew = 2_000;
      }
      return r;
    };
    await h.run({ now: () => h.now() + skew });
    expect(injected).toBe(true);
    expect(h.dialog.sent).toHaveLength(1);
    expect(h.journal()).toMatch(/конец интервью/);
    const rating = (await history(0)).at(-1)!;
    expect(rating.text).toBe('Оцените собеседование');
    const endedAt = readState(h.statePath).interviewEndedAt;

    h.dialog.history = history;
    h.dialog.push('Здравствуйте! Это новое интервью.');
    await h.run({ now: () => h.now() + skew });
    expect(h.dialog.sent).toHaveLength(2);
    expect(h.generate.mock.calls.at(-1)![0].question).toBe('Здравствуйте! Это новое интервью.');
    // Конец записан датой самой оценки — раньше открытия нового окна.
    expect(endedAt).toBe(rating.date.getTime());
  });

  it('конец прошлого окна не мешает новому: interviewEndedAt раньше открытия окна не блокирует', async () => {
    const h = harness([msg(1, 'Вопрос')], {
      windowUntil: Date.now() + 60 * MIN, interviewEndedAt: Date.now() - 90 * MIN,
    });
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
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
    const restart = vi.fn(async (_target: { service: string; app: string }, _note: (line: string) => void) => false);
    await h.run({ vpn: { isUp: async () => false, restart } });
    // Служба и GUI — из конфига (FU-2), а не зашитые в код; журнал — цикла (FU-8).
    expect(restart).toHaveBeenCalledWith({ service: 'VpnService', app: 'C:\\Vpn\\Gui.exe' }, expect.any(Function));
    expect(h.openDialog).not.toHaveBeenCalled();
    expect(h.journal()).toMatch(/VPN не поднялся/);
    expect(existsSync(h.lockPath)).toBe(false);
  });

  it('рестарт VPN пишет коды sc.exe в журнал цикла (FU-8)', async () => {
    const h = harness([msg(1, 'Вопрос')]);
    await h.run({
      vpn: {
        isUp: async () => false,
        restart: async (_target, note) => {
          note('VPN, попытка 1/3: sc.exe stop VpnService — код 0');
          note('VPN, попытка 1/3: sc.exe start VpnService — код 5');
          return false;
        },
      },
    });
    const lines = h.journal().trim().split('\n').map((l) => l.replace(/^\S+ /, ''));
    expect(lines).toEqual([
      'VPN не отвечает, пробую перезапустить службу VpnService',
      'VPN, попытка 1/3: sc.exe stop VpnService — код 0',
      'VPN, попытка 1/3: sc.exe start VpnService — код 5',
      'VPN не поднялся за три попытки, жду следующего запуска',
    ]);
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

// ---------------------------------------------------------------------------
// G2: подсказка выбора вакансии. Тексты — живой чат ГигаРекрутёра 2026-09-27.

const CLOSING = 'Спасибо за интервью! Я передам ваше резюме и итоги нашего диалога рекрутеру. '
  + 'Статус отклика можно отслеживать в личном кабинете HR-платформы "Пульс".';
const RATING = 'Пожалуйста, оцените мою работу!';
const STARS = ['★☆☆☆☆', '★★☆☆☆', '★★★☆☆', '★★★★☆', '★★★★★'];
const FOOTER = 'Вы всегда можете сменить вакансию, по которой хотите пройти первичное интервью - для этого нажмите '
  + 'на кнопку "сменить вакансию", расположенную в "меню" рядом с полем для ввода.';
const PROMPT = 'Вижу, что вы откликнулись на несколько вакансий. По какой из них вы хотели бы продолжить диалог?\n'
  + '1. Стажер системный аналитик\n2. Системный аналитик\n3. Системный аналитик (ОКТУС)\n4. Data analyst\n'
  + '5. Middle Системный аналитик (Продукт массовых зачислений)\n'
  + FOOTER;
/** Вторая страница после «Далее»: бот правит на месте и текст, и кнопки. */
const PAGE2 = {
  text: 'По какой из них вы хотели бы продолжить диалог?\n6. Бизнес-аналитик\n7. Аналитик данных\n' + FOOTER,
  buttons: ['6. Бизнес-аналитик', '7. Аналитик данных', 'Назад', 'Далее'],
};
const OPTIONS = [
  '1. Стажер системный аналитик', '2. Системный аналитик', '3. Системный аналитик (ОКТУС)', '4. Data analyst',
  '5. Middle Системный аналитик (Продукт массовых зачислений)', 'Далее',
];
const CHOSEN = 'Спасибо за выбор вакансии! Дайте мне несколько секунд — и мы начнем диалог 👍';
const start = (title: string): string =>
  `Здравствуйте, Артём! Меня зовут ГигаРекрутёр. Получил Ваш отклик на позицию ${title}. `
  + 'Будет удобно прямо сейчас ответить на несколько вопросов по этой позиции?';
const ALL_SEEN = ['стажер системный аналитик', 'системный аналитик', 'системный аналитик (октус)', 'data analyst',
  'middle системный аналитик (продукт массовых зачислений)'];

describe('runInterview: выбор вакансии (G2)', () => {
  /** Через `ms` от нынешних часов стенда. */
  const later = (h: ReturnType<typeof harness>, ms: number, run: () => void): void => h.at(h.now() - h.t0 + ms, run);

  /**
   * Бот на нажатие варианта: правит подсказку на месте в «Спасибо за выбор…»
   * (кнопки сняты) и через 10 секунд начинает интервью по выбранной вакансии.
   * Возвращает моменты нажатий по часам стенда.
   */
  function botAnswersPress(h: ReturnType<typeof harness>, pages: Record<string, { text: string; buttons: string[] }> = {}): number[] {
    const at: number[] = [];
    h.dialog.onPress = (id, button) => {
      at.push(h.now());
      const page = pages[button];
      if (page !== undefined) { h.dialog.edit(id, page); return; }
      h.dialog.edit(id, { text: CHOSEN, buttons: [] });
      later(h, 10_000, () => h.dialog.push(start(button.replace(/^\d+\.\s*/, ''))));
    };
    return at;
  }

  /** Окно, первое интервью по «Бизнес-аналитик» с ответом, на 5-й минуте — три сообщения конца одной секундой. */
  function interviewThenEnd(h: ReturnType<typeof harness>): { promptId: () => number } {
    let promptId = 0;
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push(start('Бизнес-аналитик')));
    h.at(5 * MIN, () => {
      h.dialog.push(CLOSING);
      h.dialog.push(RATING, { buttons: STARS });
      promptId = h.dialog.push(PROMPT, { buttons: OPTIONS });
    });
    return { promptId: () => promptId };
  }

  it('пять вариантов, ничего не пройдено: через 3 минуты жмёт первый, интервью по нему отвечается (G2)', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    let promptId = 0;
    h.at(1 * MIN, () => { promptId = h.dialog.push(PROMPT, { buttons: OPTIONS }); });
    const pressedAt = botAnswersPress(h);
    await h.run();
    expect(h.dialog.presses).toEqual([{ messageId: promptId, button: '1. Стажер системный аналитик' }]);
    // Окно держит сессию всю выдержку: подсказка пришла на 1:00, нажата не раньше 4:00.
    expect(pressedAt[0]).toBeGreaterThanOrEqual(h.t0 + 4 * MIN);
    expect(pressedAt[0]).toBeLessThan(h.t0 + 4 * MIN + 2 * POLL_MS);
    expect(h.generate.mock.calls.map((c) => c[0].question)).toEqual([start('Стажер системный аналитик')]);
    expect(h.dialog.sent).toHaveLength(1);
    expect(readState(h.statePath).currentTitle).toBe('Стажер системный аналитик');
    // C2: нажатая вакансия сразу в пройденных; нажатие и его начало интервью — одно интервью за окно.
    expect(readState(h.statePath)).toMatchObject({ interviewedTitles: ['стажер системный аналитик'], interviewsInWindow: 1 });
    expect(h.journal()).toMatch(/выбор вакансии \d+: нажата «Стажер системный аналитик»/);
    expect(h.journal()).not.toContain('Вижу, что вы откликнулись');
  });

  it('первый вариант уже пройден — жмёт второй', async () => {
    const h = harness([], { interviewedTitles: ['стажер системный аналитик'] });
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push(PROMPT, { buttons: OPTIONS }));
    botAnswersPress(h);
    await h.run();
    expect(h.dialog.presses.map((p) => p.button)).toEqual(['2. Системный аналитик']);
    expect(h.generate.mock.calls.map((c) => c[0].question)).toEqual([start('Системный аналитик')]);
  });

  it('все видимые пройдены — жмёт «Далее» один раз, на новой странице — непройденный вариант', async () => {
    const h = harness([], { interviewedTitles: ALL_SEEN });
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push(PROMPT, { buttons: OPTIONS }));
    botAnswersPress(h, { 'Далее': PAGE2 });
    await h.run();
    expect(h.dialog.presses.map((p) => p.button)).toEqual(['Далее', '6. Бизнес-аналитик']);
    expect(h.generate.mock.calls.map((c) => c[0].question)).toEqual([start('Бизнес-аналитик')]);
    expect(h.journal()).toMatch(/нажата «Далее»/);
  });

  it('все пройдены и «Далее» нет — не жмёт ничего, строка в журнал, метка за подсказкой', async () => {
    const h = harness([msg(1, PROMPT, { hasButtons: true, buttons: OPTIONS.slice(0, 5), date: new Date(Date.now() - 10 * MIN) })],
      { interviewedTitles: ALL_SEEN });
    await h.run();
    expect(h.dialog.presses).toEqual([]);
    expect(h.dialog.sent).toEqual([]);
    expect(readState(h.statePath).lastMessageId).toBe(1);
    expect(h.journal().match(/все варианты уже пройдены, ничего не нажато/g)).toHaveLength(1);
  });

  it('оценку звёздами не жмёт никогда: ни после ответа, ни одну в поллинге', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push(start('Data analyst')));
    h.at(5 * MIN, () => { h.dialog.push(CLOSING); h.dialog.push(RATING, { buttons: STARS }); });
    await h.run();
    expect(h.dialog.presses).toEqual([]);
    expect(h.journal()).toMatch(/конец интервью/);

    const lone = harness([msg(1, RATING, { hasButtons: true, buttons: STARS, date: new Date(Date.now() - 10 * MIN) })]);
    await lone.run();
    expect(lone.dialog.presses).toEqual([]);
    expect(lone.dialog.sent).toEqual([]);
  });

  it('начало интервью записывает currentTitle, свежий конец переносит его в interviewedTitles', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push(start('«Data analyst»')));
    let during = '';
    h.at(3 * MIN, () => { during = readState(h.statePath).currentTitle; });
    h.at(5 * MIN, () => { h.dialog.push(CLOSING); h.dialog.push(RATING, { buttons: STARS }); });
    await h.run();
    expect(during).toBe('Data analyst');
    expect(readState(h.statePath)).toMatchObject({ currentTitle: '', interviewedTitles: ['data analyst'] });
    expect(h.journal()).toMatch(/начало интервью \d+: вакансия «Data analyst»/);
  });

  it('живой конец: прощание, оценка и подсказка одной секундой — прощание без ответа, через 3 минуты жмёт вариант, новое интервью отвечается', async () => {
    const h = harness();
    const { promptId } = interviewThenEnd(h);
    const pressedAt = botAnswersPress(h);
    await h.run();
    expect(h.dialog.presses).toEqual([{ messageId: promptId(), button: '1. Стажер системный аналитик' }]);
    expect(pressedAt[0]).toBeGreaterThanOrEqual(h.t0 + 8 * MIN);
    const questions = h.generate.mock.calls.map((c) => c[0].question);
    expect(questions).toEqual([start('Бизнес-аналитик'), start('Стажер системный аналитик')]);
    expect(h.dialog.sent).toHaveLength(2);
    for (const q of questions) {
      expect(q).not.toContain('Спасибо за интервью');
      expect(q).not.toContain('Спасибо за выбор вакансии');
    }
    // C2: нажатая вакансия уходит в пройденные сразу при нажатии, а не в конце её интервью.
    expect(readState(h.statePath)).toMatchObject({
      interviewEndedAt: 0, currentTitle: 'Стажер системный аналитик',
      interviewedTitles: ['бизнес-аналитик', 'стажер системный аналитик'], capTrippedAt: 0, interviewsInWindow: 2,
    });
    expect(h.journal().match(/конец интервью/g)).toHaveLength(1);
  });

  it.each([
    ['правит подсказку на месте в «Спасибо за выбор…»', (h: ReturnType<typeof harness>, id: number) => h.dialog.edit(id, { text: CHOSEN, buttons: [] })],
    ['присылает «Спасибо за выбор…» отдельным сообщением', (h: ReturnType<typeof harness>) => h.dialog.push(CHOSEN)],
  ])('бот выбрал сам в первую минуту (%s) — не жмёт ничего, новое интервью отвечается', async (_name, choose) => {
    const h = harness();
    const { promptId } = interviewThenEnd(h);
    h.at(5 * MIN + 40_000, () => choose(h, promptId()));
    h.at(5 * MIN + 50_000, () => h.dialog.push(start('Стажер системный аналитик')));
    await h.run();
    expect(h.dialog.presses).toEqual([]);
    const questions = h.generate.mock.calls.map((c) => c[0].question);
    expect(questions).toEqual([start('Бизнес-аналитик'), start('Стажер системный аналитик')]);
    // Начало интервью, выбранного ботом, пишет вакансию в пройденные сразу и считается в потолок (C2).
    expect(readState(h.statePath)).toMatchObject({
      interviewEndedAt: 0, interviewedTitles: ['бизнес-аналитик', 'стажер системный аналитик'], interviewsInWindow: 2,
    });
  });

  it('подсказку поправили в «Спасибо за выбор…» за миг до нажатия — перечитана по id, не нажата', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    let promptId = 0;
    h.at(1 * MIN, () => { promptId = h.dialog.push(PROMPT, { buttons: OPTIONS }); });
    const getMessage = h.dialog.getMessage;
    h.dialog.getMessage = async (id) => {
      h.dialog.edit(promptId, { text: CHOSEN, buttons: [] });
      return getMessage(id);
    };
    await h.run();
    expect(h.dialog.presses).toEqual([]);
    expect(h.journal()).toMatch(/уже выбрали без нас/);
    expect(h.dialog.sent).toEqual([]);
  });

  it('после оценки и подсказки пришёл обычный текст — не жмёт и не отвечает, молчание FU-9 держится', async () => {
    const h = harness();
    interviewThenEnd(h);
    h.at(6 * MIN, () => h.dialog.push('Если появятся вопросы — пишите!'));
    await h.run();
    expect(h.dialog.presses).toEqual([]);
    expect(h.dialog.sent).toHaveLength(1);
    expect(readState(h.statePath).interviewEndedAt).toBeGreaterThan(0);
    expect(h.journal()).toMatch(/интервью закончилось/);
  });

  it('конец без подсказки, подсказка пришла позже — следующий поллинг её жмёт и отвечает на новое интервью', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push(start('Бизнес-аналитик')));
    h.at(5 * MIN, () => { h.dialog.push(CLOSING); h.dialog.push(RATING, { buttons: STARS }); });
    await h.run();
    expect(h.now()).toBe(h.t0 + 5 * MIN);
    expect(readState(h.statePath).interviewEndedAt).toBeGreaterThan(0);

    h.dialog.push('Спасибо за оценку!');
    h.dialog.push(PROMPT, { buttons: OPTIONS });
    botAnswersPress(h);
    await h.run({ now: () => h.now() + 4 * 60 * MIN });
    expect(h.dialog.presses.map((p) => p.button)).toEqual(['1. Стажер системный аналитик']);
    expect(h.generate.mock.calls.map((c) => c[0].question)).toEqual([start('Бизнес-аналитик'), start('Стажер системный аналитик')]);
    expect(readState(h.statePath).interviewEndedAt).toBe(0);
  });

  it('поллинг: подсказка старше трёх минут жмётся сразу, моложе — сессия ждёт выдержку, а не выходит', async () => {
    const old = harness([msg(1, PROMPT, { hasButtons: true, buttons: OPTIONS, date: new Date(Date.now() - 10 * MIN) })]);
    const oldAt = botAnswersPress(old);
    await old.run();
    expect(oldAt).toEqual([old.t0]);
    expect(old.dialog.sent).toHaveLength(1);

    const young = harness([msg(1, PROMPT, { hasButtons: true, buttons: OPTIONS, date: new Date(Date.now() - 1 * MIN) })]);
    const youngAt = botAnswersPress(young);
    await young.run();
    expect(youngAt).toHaveLength(1);
    expect(youngAt[0]).toBeGreaterThanOrEqual(young.t0 + 2 * MIN);
    expect(youngAt[0]).toBeLessThan(young.t0 + 2 * MIN + 2 * POLL_MS);
    expect(young.dialog.sent).toHaveLength(1);
  });

  // C1: пробы ревью. Раньше любое сообщение с подвалом «сменить вакансию» и кнопкой
  // с буквами считалось подсказкой, и через 3 минуты жалась его первая кнопка.
  it.each([
    ['вопрос посреди интервью с подвалом и кнопками [Да, Нет]', `Готовы ли вы к переезду? ${FOOTER}`, ['Да', 'Нет']],
    ['подвал и кнопка «Сменить вакансию»', FOOTER, ['Сменить вакансию']],
    ['оценка без «оцените» в тексте, звёзды словами в кнопках', `Как вам наш диалог? ${FOOTER}`,
      ['1 звезда', '2 звезды', '3 звезды', '4 звезды', '5 звёзд']],
  ])('не подсказка — не жмёт ничего (C1): %s', async (_name, text, buttons) => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push(start('Data analyst')));
    h.at(3 * MIN, () => h.dialog.push(text, { buttons }));
    await h.run();
    expect(h.dialog.presses).toEqual([]);
    expect(h.dialog.sent).toHaveLength(1);
  });

  it('напоминание «выберите вакансию» без кнопок после ненажатой подсказки — не отвечается (M2, проба S9)', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push(PROMPT, { buttons: OPTIONS }));
    h.at(2 * MIN, () => h.dialog.push('Пожалуйста, выберите вакансию из списка выше.'));
    await h.run();
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.dialog.sent).toEqual([]);
    expect(h.dialog.presses).toEqual([]);
  });

  it('прямо перед нажатием в чате появилось новое — подсказка не нажата (M3)', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push(PROMPT, { buttons: OPTIONS }));
    const getMessage = h.dialog.getMessage;
    let pushed = false;
    h.dialog.getMessage = async (id) => {
      const m = await getMessage(id);
      // Пока цикл перечитывал подсказку, владелец написал сам.
      if (!pushed) { pushed = true; h.dialog.push('Вы тут?'); }
      return m;
    };
    await h.run();
    expect(pushed).toBe(true);
    expect(h.dialog.presses).toEqual([]);
  });

  // C2: проба ревью — начало «на вакансию» не узнавалось, вакансия не записывалась,
  // и следующая подсказка снова жала тот же вариант.
  it('нажатая вакансия записывается сразу: начало «на вакансию» не мешает, второй раз она не жмётся (C2)', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push(PROMPT, { buttons: OPTIONS }));
    h.dialog.onPress = (id, button) => {
      h.dialog.edit(id, { text: CHOSEN, buttons: [] });
      const title = button.replace(/^\d+\.\s*/, '');
      later(h, 10_000, () => h.dialog.push(`Здравствуйте! Получил Ваш отклик на вакансию ${title}. Будет удобно ответить на вопросы?`));
    };
    // Первое интервью кончается на 10-й минуте, и бот снова присылает подсказку.
    h.at(10 * MIN, () => { h.dialog.push(CLOSING); h.dialog.push(RATING, { buttons: STARS }); h.dialog.push(PROMPT, { buttons: OPTIONS }); });
    await h.run();
    expect(h.dialog.presses.map((p) => p.button)).toEqual(['1. Стажер системный аналитик', '2. Системный аналитик']);
    expect(readState(h.statePath).interviewedTitles).toEqual(['стажер системный аналитик', 'системный аналитик']);
  });

  it('«Далее» жмётся один раз на подсказку — и в следующем процессе тоже (I2)', async () => {
    // Бот на «Далее» страницу не меняет: без памяти каждый поллинг жал бы её снова.
    const h = harness([msg(1, PROMPT, { hasButtons: true, buttons: OPTIONS, date: new Date(Date.now() - 10 * MIN) })],
      { interviewedTitles: ALL_SEEN });
    await h.run();
    expect(h.dialog.presses.map((p) => p.button)).toEqual(['Далее']);
    expect(readState(h.statePath)).toMatchObject({ pagedPromptId: 1, pagedSnapshot: OPTIONS.join('\n') });
    await h.run({ now: () => h.now() + 4 * 60 * MIN });
    expect(h.dialog.presses.map((p) => p.button)).toEqual(['Далее']);
  });

  // Живое наблюдение 2026-09-27 4:35: когда вакансия осталась одна, бот подсказку
  // не шлёт — за оценкой сразу идёт начало нового интервью.
  it('прощание, оценка и сразу начало нового интервью одной пачкой — начало отвечается, прощание нет', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push(start('Бизнес-аналитик')));
    h.at(5 * MIN, () => { h.dialog.push(CLOSING); h.dialog.push(RATING, { buttons: STARS }); h.dialog.push(start('Data analyst')); });
    await h.run();
    expect(h.generate.mock.calls.map((c) => c[0].question)).toEqual([start('Бизнес-аналитик'), start('Data analyst')]);
    expect(h.dialog.presses).toEqual([]);
    expect(readState(h.statePath)).toMatchObject({
      interviewEndedAt: 0, currentTitle: 'Data analyst', interviewedTitles: ['бизнес-аналитик', 'data analyst'], interviewsInWindow: 2,
    });
    expect(h.journal().match(/конец интервью/g)).toHaveLength(1);
  });

  it('после свежего конца «Спасибо за оценку!» — без ответа, а начало нового интервью в следующем поллинге — отвечается', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push(start('Бизнес-аналитик')));
    h.at(5 * MIN, () => { h.dialog.push(CLOSING); h.dialog.push(RATING, { buttons: STARS }); });
    await h.run();
    expect(readState(h.statePath).interviewEndedAt).toBeGreaterThan(0);

    h.dialog.push('Спасибо за оценку!');
    await h.run({ now: () => h.now() + 30 * MIN });
    expect(h.dialog.sent).toHaveLength(1);

    h.dialog.push(start('Data analyst'));
    await h.run({ now: () => h.now() + 4 * 60 * MIN });
    expect(h.generate.mock.calls.map((c) => c[0].question)).toEqual([start('Бизнес-аналитик'), start('Data analyst')]);
    expect(readState(h.statePath)).toMatchObject({ interviewEndedAt: 0, currentTitle: 'Data analyst' });
  });

  it('начало интервью с подвалом «сменить вакансию» — не служебная строка: отвечается', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push(`${start('Data analyst')} ${FOOTER}`));
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    expect(readState(h.statePath).currentTitle).toBe('Data analyst');
  });

  it('начало интервью по уже пройденной вакансии отвечается и считается в потолок', async () => {
    const h = harness([], { interviewedTitles: ['data analyst'] });
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push(start('Data analyst')));
    await h.run();
    expect(h.dialog.sent).toHaveLength(1);
    expect(readState(h.statePath)).toMatchObject({ interviewsInWindow: 1, interviewedTitles: ['data analyst'] });
  });

  it('седьмое начало интервью за окно — потолок: без ответа, capTrippedAt, строка в журнал (C2)', async () => {
    const h = harness();
    openWindow(h.t0, CFG.windowMinutes, h.statePath);
    h.at(1 * MIN, () => h.dialog.push(start('Аналитик 1')));
    for (let k = 2; k <= 7; k += 1) {
      h.at((k - 1) * 10 * MIN, () => {
        h.dialog.push(CLOSING);
        h.dialog.push(RATING, { buttons: STARS });
        h.dialog.push(start(`Аналитик ${k}`));
      });
    }
    await h.run();
    expect(CFG.maxInterviewsPerWindow).toBe(6);
    expect(h.generate.mock.calls.map((c) => c[0].question)).toEqual([1, 2, 3, 4, 5, 6].map((k) => start(`Аналитик ${k}`)));
    expect(h.dialog.sent).toHaveLength(6);
    expect(readState(h.statePath)).toMatchObject({ interviewsInWindow: 6 });
    expect(readState(h.statePath).capTrippedAt).toBeGreaterThan(0);
    expect(h.journal()).toMatch(/потолок 6 интервью за окно/);
  });

  it('потолок интервью уже набран — подсказку не жмёт, capTrippedAt, строка в журнал (C2)', async () => {
    const h = harness([msg(1, PROMPT, { hasButtons: true, buttons: OPTIONS, date: new Date(Date.now() - 10 * MIN) })],
      { interviewsInWindow: 6 });
    botAnswersPress(h);
    await h.run();
    expect(h.dialog.presses).toEqual([]);
    expect(h.dialog.sent).toEqual([]);
    expect(readState(h.statePath).capTrippedAt).toBeGreaterThan(0);
    expect(h.journal()).toMatch(/потолок 6 интервью за окно/);
  });
});

describe('runInterview: отдельная сессия личного аккаунта (G1)', () => {
  it('файла сессии нет — одна строка с подсказкой, ни VPN, ни Telegram, блокировка снята', async () => {
    const h = harness([msg(1, 'Вопрос')]);
    const missing = join(dirname(h.statePath), 'нет.session');
    const isUp = vi.fn(async () => true);
    await h.run({ config: { ...CFG, sessionPath: missing }, hasSession: undefined, vpn: { isUp, restart: async () => true } });
    expect(h.openDialog).not.toHaveBeenCalled();
    expect(isUp).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
    const lines = h.journal().trim().split('\n').map((l) => l.replace(/^\S+ /, ''));
    expect(lines).toEqual([`нет сессии личного аккаунта — войди: npm run tg:login -- --session ${missing}`]);
    expect(existsSync(h.lockPath)).toBe(false);
  });

  it('путь по умолчанию — ровно та команда входа, что в спеке', async () => {
    const h = harness([msg(1, 'Вопрос')]);
    await h.run({ hasSession: () => false });
    expect(CFG.sessionPath).toBe('data/telegram-interview.session');
    expect(h.journal()).toContain('нет сессии личного аккаунта — войди: npm run tg:login -- --session data/telegram-interview.session');
    expect(h.openDialog).not.toHaveBeenCalled();
  });

  it('файл сессии есть — диалог открывается именно с ним, а не с рабочей сессией', async () => {
    const h = harness([msg(1, 'Вопрос')]);
    const personal = join(dirname(h.statePath), 'personal.session');
    writeFileSync(personal, '1BVtsOK-fake', 'utf8');
    await h.run({ config: { ...CFG, sessionPath: personal }, hasSession: undefined });
    expect(h.openDialog).toHaveBeenCalledWith('Giga_recruiter_bot', { sessionPath: personal });
    expect(h.dialog.sent).toHaveLength(1);
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
