import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DialogMessage, TgDialog } from '../telegram/interview-session.js';
import type { Turn } from './interview.js';

/**
 * Цикл автоответа (спека 2026-09-25, 3 и 7). Окно 2 часа после отклика,
 * гашение после 10 минут тишины, поллинг раз в 4 часа.
 *
 * Уведомлений владельцу нет по его решению: единственный след — журнал. Это
 * значит, что протухшая сессия или упавший VPN никого не разбудят, и так
 * задумано.
 */

export const STATE_PATH = 'data/interview-state.json';
export const LOG_PATH = 'data/interview.log';
export const RETRY_BACKOFF_MS = [30_000, 120_000, 300_000, 900_000] as const;

export interface RunnerState {
  lastMessageId: number;
  windowUntil: number;
  lastPollAt: number;
}

const EMPTY: RunnerState = { lastMessageId: 0, windowUntil: 0, lastPollAt: 0 };

export function backoffFor(round: number): number {
  const i = Math.min(round, RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[i]!;
}

export function readState(path: string = STATE_PATH): RunnerState {
  if (!existsSync(path)) return { ...EMPTY };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RunnerState>;
    return {
      lastMessageId: Number.isFinite(raw.lastMessageId) ? Number(raw.lastMessageId) : 0,
      windowUntil: Number.isFinite(raw.windowUntil) ? Number(raw.windowUntil) : 0,
      lastPollAt: Number.isFinite(raw.lastPollAt) ? Number(raw.lastPollAt) : 0,
    };
  } catch {
    // Битый файл не должен ронять цикл: начинаем с нуля.
    return { ...EMPTY };
  }
}

export function writeState(s: RunnerState, path: string = STATE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  renameSync(tmp, path);
}

export function openWindow(now: number, minutes: number, path: string = STATE_PATH): void {
  const s = readState(path);
  writeState({ ...s, windowUntil: now + minutes * 60_000 }, path);
}

export function log(line: string, path: string = LOG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8');
}

export interface AnswerDeps {
  dialog: TgDialog;
  question: DialogMessage;
  transcript: Turn[];
  generate(input: { transcript: Turn[]; question: string }): Promise<{ ok: true; text: string } | { ok: false; failure: string }>;
  /** Пауза перед ответом: мгновенный ответ выдаёт машину. */
  delay(): Promise<void>;
  statePath?: string;
  logPath?: string;
}

/**
 * Один вопрос — один ответ.
 *
 * 'sent' — ответ ушёл. 'retry' — модели не дали годного текста, в чат не ушло
 * ничего, вызывающая сторона ставит бэкофф. 'idle' — на этот вопрос уже
 * отвечали.
 */
export async function answerOnce(deps: AnswerDeps): Promise<'sent' | 'retry' | 'idle'> {
  const statePath = deps.statePath ?? STATE_PATH;
  const logPath = deps.logPath ?? LOG_PATH;
  const state = readState(statePath);
  if (deps.question.id <= state.lastMessageId) return 'idle';

  const r = await deps.generate({ transcript: deps.transcript, question: deps.question.text });
  if (!r.ok) {
    log(`брак: ${r.failure}`, logPath);
    return 'retry';
  }

  await deps.delay();
  await deps.dialog.setTyping();
  // Метку двигаем до отправки: падение на полпути не даст ответить дважды.
  writeState({ ...state, lastMessageId: deps.question.id }, statePath);
  await deps.dialog.send(r.text);
  log(`ответ на ${deps.question.id}: ${r.text.length} символов`, logPath);
  return 'sent';
}
