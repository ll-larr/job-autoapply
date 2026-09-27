import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { vi } from 'vitest';
import {
  backoffFor, readState, writeState, openWindow, RETRY_BACKOFF_MS, answerOnce, answerGroup,
} from '../src/core/interview-runner.js';
import { fakeDialog, type DialogMessage } from '../src/telegram/interview-session.js';

describe('backoffFor', () => {
  it('идёт по лестнице 30 секунд, 2, 5, 15 минут', () => {
    expect(backoffFor(0)).toBe(RETRY_BACKOFF_MS[0]);
    expect(backoffFor(1)).toBe(RETRY_BACKOFF_MS[1]);
    expect(backoffFor(3)).toBe(RETRY_BACKOFF_MS[3]);
  });

  it('дальше держит последнюю ступень, а не растёт бесконечно', () => {
    expect(backoffFor(99)).toBe(RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
  });
});

/** Поля выбора вакансии и потолка интервью (C2, I2) в нулевом виде. */
const CHOICE0 = { interviewsInWindow: 0, lastStartId: 0, pressedPromptId: 0, pagedPromptId: 0, pagedSnapshot: '' };

describe('состояние', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'runner-')), 'state.json');

  it('файла нет — нули, не исключение', () => {
    expect(readState(path)).toEqual({ lastMessageId: 0, windowUntil: 0, lastPollAt: 0, capTrippedAt: 0, interviewEndedAt: 0, currentTitle: '', interviewedTitles: [], ...CHOICE0 });
  });

  it('пишется и читается', () => {
    writeState({ lastMessageId: 42, windowUntil: 100, lastPollAt: 50, capTrippedAt: 0, interviewEndedAt: 0, currentTitle: '', interviewedTitles: [], ...CHOICE0 }, path);
    expect(readState(path).lastMessageId).toBe(42);
  });

  it('openWindow сдвигает окно, не трогая lastMessageId', () => {
    writeState({ lastMessageId: 42, windowUntil: 0, lastPollAt: 0, capTrippedAt: 0, interviewEndedAt: 0, currentTitle: '', interviewedTitles: [], ...CHOICE0 }, path);
    openWindow(1_000_000, 120, path);
    const s = readState(path);
    expect(s.windowUntil).toBe(1_000_000 + 120 * 60_000);
    expect(s.lastMessageId).toBe(42);
  });

  it('после writeState нет .tmp файла рядом, содержимое круглый путь', () => {
    const dir = dirname(path);
    writeState({ lastMessageId: 42, windowUntil: 100, lastPollAt: 50, capTrippedAt: 0, interviewEndedAt: 0, currentTitle: '', interviewedTitles: [], ...CHOICE0 }, path);
    const files = readdirSync(dir);
    expect(files).not.toContain('state.json.tmp');
    expect(readState(path)).toEqual({ lastMessageId: 42, windowUntil: 100, lastPollAt: 50, capTrippedAt: 0, interviewEndedAt: 0, currentTitle: '', interviewedTitles: [], ...CHOICE0 });
  });

  it('читает значения, не числа переводит в 0: {"lastMessageId":"abc",...} → lastMessageId: 0, остальное на месте', () => {
    const corruptPath = join(dirname(path), 'corrupt.json');
    require('node:fs').writeFileSync(corruptPath, '{"lastMessageId":"abc","windowUntil":5,"lastPollAt":7}', 'utf8');
    expect(readState(corruptPath)).toEqual({ lastMessageId: 0, windowUntil: 5, lastPollAt: 7, capTrippedAt: 0, interviewEndedAt: 0, currentTitle: '', interviewedTitles: [], ...CHOICE0 });
  });

  it('усечённый JSON парсит как ошибку: все поля → 0', () => {
    const truncatedPath = join(dirname(path), 'truncated.json');
    require('node:fs').writeFileSync(truncatedPath, '{"lastMessageId": 4', 'utf8');
    expect(readState(truncatedPath)).toEqual({ lastMessageId: 0, windowUntil: 0, lastPollAt: 0, capTrippedAt: 0, interviewEndedAt: 0, currentTitle: '', interviewedTitles: [], ...CHOICE0 });
  });

  it('capTrippedAt: поля нет (файл старого формата) — 0, не число — 0 (FR-6)', () => {
    const oldPath = join(dirname(path), 'old-format.json');
    writeFileSync(oldPath, '{"lastMessageId":3,"windowUntil":5,"lastPollAt":7}', 'utf8');
    expect(readState(oldPath)).toEqual({ lastMessageId: 3, windowUntil: 5, lastPollAt: 7, capTrippedAt: 0, interviewEndedAt: 0, currentTitle: '', interviewedTitles: [], ...CHOICE0 });
    const badPath = join(dirname(path), 'bad-cap.json');
    writeFileSync(badPath, '{"lastMessageId":3,"windowUntil":5,"lastPollAt":7,"capTrippedAt":"вчера"}', 'utf8');
    expect(readState(badPath).capTrippedAt).toBe(0);
  });

  it('writeState сохраняет capTrippedAt, openWindow его снимает и остальное не трогает (FR-6)', () => {
    const capPath = join(dirname(path), 'cap.json');
    writeState({ lastMessageId: 42, windowUntil: 100, lastPollAt: 50, capTrippedAt: 777, interviewEndedAt: 0, currentTitle: '', interviewedTitles: [], ...CHOICE0 }, capPath);
    expect(readState(capPath).capTrippedAt).toBe(777);
    openWindow(1_000_000, 120, capPath);
    expect(readState(capPath)).toEqual({
      lastMessageId: 42, windowUntil: 1_000_000 + 120 * 60_000, lastPollAt: 50, capTrippedAt: 0, interviewEndedAt: 0, currentTitle: '', interviewedTitles: [], ...CHOICE0,
    });
  });

  it('interviewEndedAt: поля нет (файл старого формата) — 0, не число — 0 (FU-9)', () => {
    const oldPath = join(dirname(path), 'old-format-end.json');
    writeFileSync(oldPath, '{"lastMessageId":3,"windowUntil":5,"lastPollAt":7,"capTrippedAt":9}', 'utf8');
    expect(readState(oldPath)).toEqual({ lastMessageId: 3, windowUntil: 5, lastPollAt: 7, capTrippedAt: 9, interviewEndedAt: 0, currentTitle: '', interviewedTitles: [], ...CHOICE0 });
    const badPath = join(dirname(path), 'bad-end.json');
    writeFileSync(badPath, '{"lastMessageId":3,"windowUntil":5,"lastPollAt":7,"interviewEndedAt":"вчера"}', 'utf8');
    expect(readState(badPath).interviewEndedAt).toBe(0);
    const nullPath = join(dirname(path), 'null-end.json');
    writeFileSync(nullPath, '{"lastMessageId":3,"interviewEndedAt":null}', 'utf8');
    expect(readState(nullPath).interviewEndedAt).toBe(0);
  });

  it('currentTitle и interviewedTitles: нет полей — пусто; не строка и не список строк — пусто (G2)', () => {
    const oldPath = join(dirname(path), 'old-format-titles.json');
    writeFileSync(oldPath, '{"lastMessageId":3,"interviewEndedAt":9}', 'utf8');
    expect(readState(oldPath)).toMatchObject({ lastMessageId: 3, interviewEndedAt: 9, currentTitle: '', interviewedTitles: [], ...CHOICE0 });
    const badPath = join(dirname(path), 'bad-titles.json');
    writeFileSync(badPath, '{"currentTitle":5,"interviewedTitles":"стажер"}', 'utf8');
    expect(readState(badPath)).toMatchObject({ currentTitle: '', interviewedTitles: [], ...CHOICE0 });
    const mixedPath = join(dirname(path), 'mixed-titles.json');
    writeFileSync(mixedPath, '{"currentTitle":"Data analyst","interviewedTitles":["стажер",7,null,"data analyst"]}', 'utf8');
    expect(readState(mixedPath)).toMatchObject({ currentTitle: 'Data analyst', interviewedTitles: ['стажер', 'data analyst'] });
  });

  it('openWindow не трогает пройденные вакансии и текущую (G2)', () => {
    const titlesPath = join(dirname(path), 'titles.json');
    writeState({
      lastMessageId: 42, windowUntil: 100, lastPollAt: 50, capTrippedAt: 777, interviewEndedAt: 888,
      currentTitle: 'Data analyst', interviewedTitles: ['стажер системный аналитик'], ...CHOICE0,
    }, titlesPath);
    openWindow(1_000_000, 120, titlesPath);
    expect(readState(titlesPath)).toMatchObject({
      interviewEndedAt: 0, capTrippedAt: 0, currentTitle: 'Data analyst', interviewedTitles: ['стажер системный аналитик'],
    });
  });

  it('потолок интервью и «Далее»: нет полей — нули; не число — 0; не строка — пусто (C2, I2)', () => {
    const oldPath = join(dirname(path), 'old-format-choice.json');
    writeFileSync(oldPath, '{"lastMessageId":3,"currentTitle":"Data analyst"}', 'utf8');
    expect(readState(oldPath)).toMatchObject({ lastMessageId: 3, currentTitle: 'Data analyst', ...CHOICE0 });
    const badPath = join(dirname(path), 'bad-choice.json');
    writeFileSync(badPath,
      '{"interviewsInWindow":"шесть","lastStartId":null,"pressedPromptId":"x","pagedPromptId":[1],"pagedSnapshot":5}', 'utf8');
    expect(readState(badPath)).toMatchObject(CHOICE0);
    const goodPath = join(dirname(path), 'good-choice.json');
    const good = { interviewsInWindow: 4, lastStartId: 71, pressedPromptId: 70, pagedPromptId: 69, pagedSnapshot: '1. A\nДалее' };
    writeFileSync(goodPath, JSON.stringify(good), 'utf8');
    expect(readState(goodPath)).toMatchObject(good);
  });

  it('openWindow обнуляет счётчик интервью за окно, а метки нажатий и «Далее» не трогает (C2, I2)', () => {
    const p = join(dirname(path), 'window-choice.json');
    writeState({
      lastMessageId: 42, windowUntil: 100, lastPollAt: 50, capTrippedAt: 777, interviewEndedAt: 888, currentTitle: '', interviewedTitles: [],
      interviewsInWindow: 6, lastStartId: 71, pressedPromptId: 70, pagedPromptId: 69, pagedSnapshot: 'Далее',
    }, p);
    openWindow(1_000_000, 120, p);
    expect(readState(p)).toMatchObject({
      interviewsInWindow: 0, capTrippedAt: 0, lastStartId: 71, pressedPromptId: 70, pagedPromptId: 69, pagedSnapshot: 'Далее',
    });
  });

  it('writeState сохраняет interviewEndedAt, openWindow его снимает и остальное не трогает (FU-9)', () => {
    const endPath = join(dirname(path), 'end.json');
    writeState({ lastMessageId: 42, windowUntil: 100, lastPollAt: 50, capTrippedAt: 777, interviewEndedAt: 888, currentTitle: '', interviewedTitles: [], ...CHOICE0 }, endPath);
    expect(readState(endPath).interviewEndedAt).toBe(888);
    openWindow(1_000_000, 120, endPath);
    expect(readState(endPath)).toEqual({
      lastMessageId: 42, windowUntil: 1_000_000 + 120 * 60_000, lastPollAt: 50, capTrippedAt: 0, interviewEndedAt: 0, currentTitle: '', interviewedTitles: [], ...CHOICE0,
    });
  });
});

function deps(
  over: Partial<Omit<Parameters<typeof answerOnce>[0], 'dialog'> & { dialog?: ReturnType<typeof fakeDialog> }> = {},
) {
  const dialog = fakeDialog();
  const statePath = join(mkdtempSync(join(tmpdir(), 'once-')), 'state.json');
  const logPath = join(dirname(statePath), 'run.log');
  return {
    dialog,
    statePath,
    logPath,
    question: { id: 7, date: new Date(), text: 'Какой опыт с Kafka?', urls: [], out: false, hasButtons: false, buttons: [] },
    transcript: [],
    generate: vi.fn(async () => ({ ok: true as const, text: 'Проектировал контракт события.' })),
    delay: vi.fn(async () => {}),
    ...over,
  };
}

describe('answerOnce', () => {
  it('годный ответ уходит в чат, lastMessageId двигается', async () => {
    const d = deps();
    expect(await answerOnce(d)).toBe('sent');
    expect(d.dialog.sent).toEqual(['Проектировал контракт события.']);
    expect(readState(d.statePath).lastMessageId).toBe(7);
  });

  it('lastMessageId записывается до отправки — падение не даст ответить дважды', async () => {
    const d = deps();
    d.dialog.send = vi.fn(async () => { throw new Error('сеть'); });
    await expect(answerOnce(d)).rejects.toThrow('сеть');
    expect(readState(d.statePath).lastMessageId).toBe(7);
  });

  it('провал моделей — в чат ничего, статус retry', async () => {
    const d = deps({ generate: vi.fn(async () => ({ ok: false as const, failure: 'все модели дали брак' })) });
    expect(await answerOnce(d)).toBe('retry');
    expect(d.dialog.sent).toEqual([]);
    expect(readState(d.statePath).lastMessageId).toBe(0);
  });

  it('уже отвеченный вопрос пропускается', async () => {
    const d = deps();
    writeState({ lastMessageId: 7, windowUntil: 0, lastPollAt: 0, capTrippedAt: 0, interviewEndedAt: 0, currentTitle: '', interviewedTitles: [], ...CHOICE0 }, d.statePath);
    expect(await answerOnce(d)).toBe('idle');
    expect(d.dialog.sent).toEqual([]);
  });

  it('перед ответом выдерживается задержка', async () => {
    const d = deps();
    await answerOnce(d);
    expect(d.delay).toHaveBeenCalledTimes(1);
  });
});

function incoming(id: number, text: string, over: Partial<DialogMessage> = {}): DialogMessage {
  return { id, date: new Date(), text, urls: [], out: false, hasButtons: false, buttons: [], ...over };
}

function groupDeps(seed: DialogMessage[]) {
  const dialog = fakeDialog(seed);
  const statePath = join(mkdtempSync(join(tmpdir(), 'group-')), 'state.json');
  return {
    dialog,
    statePath,
    logPath: join(dirname(statePath), 'run.log'),
    transcript: [],
    generate: vi.fn(async (_: { question: string }) => ({ ok: true as const, text: 'Ответ.' })),
    delay: vi.fn(async () => {}),
  };
}

describe('answerGroup', () => {
  it('два входящих подряд — один вопрос через перевод строки, один ответ, метка на последнем', async () => {
    const seed = [incoming(1, 'Спасибо за ответ!'), incoming(2, 'Расскажите про Kafka?')];
    const d = groupDeps(seed);
    expect(await answerGroup({ ...d, group: seed })).toBe('sent');
    expect(d.generate).toHaveBeenCalledTimes(1);
    expect(d.generate.mock.calls[0]![0].question).toBe('Спасибо за ответ!\nРасскажите про Kafka?');
    expect(d.dialog.sent).toEqual(['Ответ.']);
    expect(readState(d.statePath).lastMessageId).toBe(2);
  });

  it('пока шла пауза, пришло продолжение — не отправляет, метку не двигает', async () => {
    const seed = [incoming(1, 'Спасибо за ответ!')];
    const d = groupDeps(seed);
    d.delay.mockImplementation(async () => { d.dialog.push('А какой опыт с Kafka?'); });
    expect(await answerGroup({ ...d, group: seed })).toBe('superseded');
    expect(d.dialog.sent).toEqual([]);
    expect(readState(d.statePath).lastMessageId).toBe(0);
  });

  it('уже просмотренное сообщение с кнопками за группой — не продолжение, ответ уходит', async () => {
    const seed = [incoming(1, 'Какой опыт с SQL?'), incoming(2, 'Выберите вакансию', { hasButtons: true })];
    const d = groupDeps(seed);
    expect(await answerGroup({ ...d, group: [seed[0]!], seenUpTo: 2 })).toBe('sent');
    expect(d.dialog.sent).toEqual(['Ответ.']);
  });

  it('пустая группа — ничего не делает', async () => {
    const d = groupDeps([]);
    expect(await answerGroup({ ...d, group: [] })).toBe('idle');
    expect(d.generate).not.toHaveBeenCalled();
  });

  it('журнал пишет только номера и длину, без текста диалога', async () => {
    const seed = [incoming(1, 'Секретный вопрос про зарплату')];
    const d = groupDeps(seed);
    await answerGroup({ ...d, group: seed });
    const journal = readFileSync(d.logPath, 'utf8');
    expect(journal).toMatch(/ответ на 1: 6 символов/);
    expect(journal).not.toMatch(/Секретный|Ответ\./);
  });
});
