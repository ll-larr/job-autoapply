import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { vi } from 'vitest';
import { backoffFor, readState, writeState, openWindow, RETRY_BACKOFF_MS, answerOnce } from '../src/core/interview-runner.js';
import { fakeDialog } from '../src/telegram/interview-session.js';

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
