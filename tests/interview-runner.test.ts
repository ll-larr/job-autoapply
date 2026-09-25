import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { vi } from 'vitest';
import {
  backoffFor, readState, writeState, openWindow, RETRY_BACKOFF_MS, answerOnce, answerGroup,
  acquireLock, releaseLock, pidAlive,
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

describe('состояние', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'runner-')), 'state.json');

  it('файла нет — нули, не исключение', () => {
    expect(readState(path)).toEqual({ lastMessageId: 0, windowUntil: 0, lastPollAt: 0 });
  });

  it('пишется и читается', () => {
    writeState({ lastMessageId: 42, windowUntil: 100, lastPollAt: 50 }, path);
    expect(readState(path).lastMessageId).toBe(42);
  });

  it('openWindow сдвигает окно, не трогая lastMessageId', () => {
    writeState({ lastMessageId: 42, windowUntil: 0, lastPollAt: 0 }, path);
    openWindow(1_000_000, 120, path);
    const s = readState(path);
    expect(s.windowUntil).toBe(1_000_000 + 120 * 60_000);
    expect(s.lastMessageId).toBe(42);
  });

  it('после writeState нет .tmp файла рядом, содержимое круглый путь', () => {
    const dir = dirname(path);
    writeState({ lastMessageId: 42, windowUntil: 100, lastPollAt: 50 }, path);
    const files = readdirSync(dir);
    expect(files).not.toContain('state.json.tmp');
    expect(readState(path)).toEqual({ lastMessageId: 42, windowUntil: 100, lastPollAt: 50 });
  });

  it('читает значения, не числа переводит в 0: {"lastMessageId":"abc",...} → lastMessageId: 0, остальное на месте', () => {
    const corruptPath = join(dirname(path), 'corrupt.json');
    require('node:fs').writeFileSync(corruptPath, '{"lastMessageId":"abc","windowUntil":5,"lastPollAt":7}', 'utf8');
    expect(readState(corruptPath)).toEqual({ lastMessageId: 0, windowUntil: 5, lastPollAt: 7 });
  });

  it('усечённый JSON парсит как ошибку: все поля → 0', () => {
    const truncatedPath = join(dirname(path), 'truncated.json');
    require('node:fs').writeFileSync(truncatedPath, '{"lastMessageId": 4', 'utf8');
    expect(readState(truncatedPath)).toEqual({ lastMessageId: 0, windowUntil: 0, lastPollAt: 0 });
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
    question: { id: 7, date: new Date(), text: 'Какой опыт с Kafka?', urls: [], out: false, hasButtons: false },
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
    writeState({ lastMessageId: 7, windowUntil: 0, lastPollAt: 0 }, d.statePath);
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
  return { id, date: new Date(), text, urls: [], out: false, hasButtons: false, ...over };
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

describe('блокировка одного экземпляра', () => {
  const lockIn = (): string => join(mkdtempSync(join(tmpdir(), 'lock-')), 'interview.lock');

  it('свободна — захватывается, в файле наш pid', () => {
    const path = lockIn();
    expect(acquireLock(path, 4242, () => true)).toEqual({ ok: true, stale: null });
    expect(readFileSync(path, 'utf8')).toBe('4242');
  });

  it('держит живой pid — отказ, файл не тронут', () => {
    const path = lockIn();
    writeFileSync(path, '999', 'utf8');
    expect(acquireLock(path, 4242, (pid) => pid === 999)).toEqual({ ok: false, holder: 999 });
    expect(readFileSync(path, 'utf8')).toBe('999');
  });

  it('pid мёртв — перехватывается', () => {
    const path = lockIn();
    writeFileSync(path, '999', 'utf8');
    expect(acquireLock(path, 4242, () => false)).toEqual({ ok: true, stale: '999' });
    expect(readFileSync(path, 'utf8')).toBe('4242');
  });

  it('мусор в файле — перехватывается, а не блокирует навсегда', () => {
    const path = lockIn();
    writeFileSync(path, '', 'utf8');
    expect(acquireLock(path, 4242, () => true).ok).toBe(true);
  });

  it('снимается только своя блокировка', () => {
    const path = lockIn();
    writeFileSync(path, '999', 'utf8');
    releaseLock(path, 4242);
    expect(existsSync(path)).toBe(true);
    releaseLock(path, 999);
    expect(existsSync(path)).toBe(false);
  });

  it('pidAlive: свой процесс жив, заведомо несуществующий — нет', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 30 + 12344)).toBe(false);
  });
});
