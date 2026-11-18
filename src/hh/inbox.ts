import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { isLoggedIn } from '../browser.js';
import { detectCaptcha } from '../adapters/hh.js';
import { parseTopicList, type HhTopic } from './topics.js';
import { readChatMessages, type FrameLike, type OwnTexts } from './chat.js';
import {
  NEGOTIATIONS_URL, NEGOTIATION_ITEM, OPEN_CHAT, CHAT_FRAME_URL_PART, CHAT_MESSAGE_CANDIDATES,
  CHAT_INPUT_CANDIDATES, CHAT_SEND_CANDIDATES, HH_REPLY_PAUSE_MS, HH_REPLIES_PER_TOPIC_PER_DAY, HH_PROBE_VALID_DAYS,
} from './inbox-selectors.js';
import type { Dialogs } from '../core/dialogs.js';
import type { Queue } from '../core/queue.js';
import type { Settings } from '../core/settings.js';
import type { SecretaryInput, SecretaryOutcome } from '../bot/secretary.js';
import { hhKey } from '../bot/state.js';

/**
 * Ящик откликов hh.ru (спека 2026-10-09, 6.10): читает новые сообщения и
 * приглашения работодателей и (отдельным тумблером) отвечает на них тем же
 * мозгом, что секретарь в Telegram.
 *
 * Три правила, на которых всё держится:
 *  1. Чтение — всегда read-only: все запросы POST/PUT/PATCH/DELETE страницы
 *     блокируются (как в scripts/inspect-hh-negotiation.ts). Чат при этом не
 *     рисуется, поэтому чтение опирается на `topicList` страницы откликов.
 *  2. Чат открывается БЕЗ блокировки только при ответах: клик по «Открыть чат»
 *     шлёт notify_chat_opened, и работодатель увидит, что сообщения прочитаны.
 *  3. Ответы не уходят, пока владелец не прошёл пробу чата (`--probe-chat`):
 *     селекторы внутри фрейма не проверены вживую (inbox-selectors.ts).
 */

const BLOCKED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DAY = 86_400_000;

// --- слой браузера: узкие интерфейсы, чтобы логика проверялась без Chromium ---

export interface HhChat {
  frame: FrameLike;
  /** Печатает и отправляет текст; false — поле после отправки не опустело (повторять нельзя). */
  sendText(text: string): Promise<boolean>;
  /** Сколько совпадений у каждого кандидата-селектора и есть ли поле ввода — для пробы. */
  probe(): Promise<ChatProbe>;
}

export interface HhNegotiationsPage {
  status(): Promise<'ok' | 'auth_required' | 'captcha'>;
  html(): Promise<string>;
  /** Какие запросы-изменения были заблокированы (метод и путь). */
  blockedWrites(): string[];
  openChat(vacancyId: string): Promise<HhChat | null>;
  /** Закрывает вкладку; вкладку с капчей оставляет человеку. */
  close(opts?: { keepForHuman?: boolean }): Promise<void>;
}

export interface HhSession {
  openNegotiations(opts: { allowWrites: boolean }): Promise<HhNegotiationsPage>;
}

export interface ChatProbe {
  frameFound: boolean;
  /** Адрес фрейма с цифрами, заменёнными на N. */
  frameUrl: string | null;
  messageSelectors: Record<string, number>;
  inputSelectors: Record<string, number>;
  sendSelectors: Record<string, number>;
}

// --- настоящая реализация на Playwright ---

export function playwrightHhSession(getContext: () => Promise<BrowserContext>): HhSession {
  return {
    async openNegotiations({ allowWrites }) {
      const context = await getContext();
      const page = await context.newPage();
      const blocked: string[] = [];
      if (!allowWrites) {
        await page.route('**/*', async (route) => {
          const req = route.request();
          if (!BLOCKED_METHODS.has(req.method())) {
            await route.continue();
            return;
          }
          let path: string;
          try { path = new URL(req.url()).pathname; } catch { path = req.url(); }
          blocked.push(`${req.method()} ${path}`);
          await route.abort('blockedbyclient');
        });
      }
      await page.goto(NEGOTIATIONS_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(3000);

      const findFrame = () => page.frames().find((f) => f.url().includes(CHAT_FRAME_URL_PART)) ?? null;
      return {
        async status() {
          if (!(await isLoggedIn(page))) return 'auth_required';
          if (await detectCaptcha(page)) return 'captcha';
          return 'ok';
        },
        html: () => page.content(),
        blockedWrites: () => [...new Set(blocked)],
        async openChat(vacancyId) {
          const card = page.locator(NEGOTIATION_ITEM).filter({ has: page.locator(`a[href*="/vacancy/${vacancyId}"]`) }).first();
          if ((await card.count()) === 0) return null;
          await card.locator(OPEN_CHAT).first().click({ timeout: 10_000 });
          let frame = findFrame();
          for (let waited = 0; frame === null && waited < 10_000; waited += 500) {
            await page.waitForTimeout(500);
            frame = findFrame();
          }
          if (frame === null) return null;
          const f = frame;
          const firstWith = async (candidates: readonly string[]): Promise<string | null> => {
            for (const sel of candidates) if ((await f.locator(sel).count().catch(() => 0)) > 0) return sel;
            return null;
          };
          return {
            frame: f as unknown as FrameLike,
            async sendText(text) {
              const inputSel = await firstWith(CHAT_INPUT_CANDIDATES);
              if (inputSel === null) return false;
              const input = f.locator(inputSel).last();
              await input.fill(text, { timeout: 10_000 });
              const sendSel = await firstWith(CHAT_SEND_CANDIDATES);
              if (sendSel !== null) await f.locator(sendSel).last().click({ timeout: 10_000 });
              else await input.press('Enter');
              await page.waitForTimeout(5000);
              // Поле опустело — сообщение ушло. Не опустело — повторять нельзя: оно могло и уйти.
              const left = await input.evaluate((el) => ('value' in el ? String((el as HTMLInputElement).value) : (el.textContent ?? '')))
                .catch(() => text);
              return left.trim() === '';
            },
            async probe() {
              const count = async (list: readonly string[]): Promise<Record<string, number>> => {
                const out: Record<string, number> = {};
                for (const sel of list) out[sel] = await f.locator(sel).count().catch(() => 0);
                return out;
              };
              return {
                frameFound: true,
                frameUrl: f.url().replace(/\d+/g, 'N'),
                messageSelectors: await count(CHAT_MESSAGE_CANDIDATES),
                inputSelectors: await count(CHAT_INPUT_CANDIDATES),
                sendSelectors: await count(CHAT_SEND_CANDIDATES),
              };
            },
          };
        },
        async close(opts) {
          if (opts?.keepForHuman === true) return;
          await page.close().catch(() => {});
        },
      };
    },
  };
}

// --- отчёты ---

export type HhInboxOutcome = 'ok' | 'auth_required' | 'captcha' | 'error' | 'profile_busy';

export interface HhInboxReport {
  at: number;
  outcome: HhInboxOutcome;
  topics: number;
  newReplies: number;
  invites: number;
  rejects: number;
  repliesSent: number;
  /** Чем кончились попытки ответа: chat_unreadable, field_not_cleared… Без текстов. */
  replyIssues: string[];
  blockedWrites: string[];
  error: string | null;
}

export interface HhInboxDeps {
  session: HhSession;
  dialogs: Dialogs;
  queue: Pick<Queue, 'idOf' | 'byId'>;
  settings: () => Settings;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  log: (line: string) => void;
  /** Мозг ответов (handleSecretary с готовыми зависимостями); нет — проход только читает. */
  brain?: (input: SecretaryInput) => Promise<SecretaryOutcome>;
  stopRequested?: () => boolean;
}

const emptyReport = (at: number): HhInboxReport => ({
  at, outcome: 'ok', topics: 0, newReplies: 0, invites: 0, rejects: 0, repliesSent: 0, replyIssues: [], blockedWrites: [], error: null,
});

export function lastHhReport(dialogs: Dialogs): HhInboxReport | null {
  const raw = dialogs.kvGet('hh:lastReport');
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as HhInboxReport;
  } catch {
    return null;
  }
}

/** Проба чата пройдена и свежа (14 дней)? Только тогда ответы разрешены. */
export function chatProbeFresh(dialogs: Dialogs, now: number): boolean {
  const raw = dialogs.kvGet('hh:chatProbeOkAt');
  if (raw === null) return false;
  const at = Number(raw);
  return Number.isFinite(at) && now - at < HH_PROBE_VALID_DAYS * DAY;
}

// --- проход чтения ---

/**
 * Один проход. Чтение — всегда read-only. Ответы — только если разрешены
 * тумблером `hhInbox.replyEnabled`, проба свежа и передан мозг.
 */
export async function checkHhInbox(deps: HhInboxDeps): Promise<HhInboxReport> {
  const report = emptyReport(deps.now());
  const repliable: Array<{ topic: HhTopic; queueId: number | null }> = [];
  let page: HhNegotiationsPage | null = null;
  let keepForHuman = false;
  try {
    try {
      page = await deps.session.openNegotiations({ allowWrites: false });
    } catch (e) {
      report.outcome = 'profile_busy';
      report.error = e instanceof Error ? e.message : String(e);
      return report;
    }
    const status = await page.status();
    if (status !== 'ok') {
      report.outcome = status;
      keepForHuman = status === 'captcha';
      return report;
    }
    const topics = parseTopicList(await page.html());
    if (topics === null) {
      report.outcome = 'error';
      report.error = 'разметка hh изменилась: нет topicList';
      return report;
    }
    report.topics = topics.length;
    for (const t of topics) {
      const queueId = deps.queue.idOf('hh', t.vacancyId);
      const kinds = deps.dialogs.observeHhTopic(t, queueId, deps.now());
      if (kinds.includes('in')) {
        report.newReplies += 1;
        repliable.push({ topic: t, queueId });
      }
      if (kinds.includes('invite')) report.invites += 1;
      if (kinds.includes('reject')) report.rejects += 1;
    }
    report.blockedWrites = page.blockedWrites();
  } catch (e) {
    report.outcome = 'error';
    report.error = e instanceof Error ? e.message : String(e);
  } finally {
    if (page !== null) await page.close({ keepForHuman }).catch(() => {});
  }

  if (report.outcome === 'ok') await replyPass(deps, repliable, report);
  deps.dialogs.kvSet('hh:lastReport', JSON.stringify(report));
  return report;
}

// --- проход ответов (выключен по умолчанию) ---

async function replyPass(
  deps: HhInboxDeps, repliable: Array<{ topic: HhTopic; queueId: number | null }>, report: HhInboxReport,
): Promise<void> {
  const settings = deps.settings();
  if (!settings.hhInbox.replyEnabled || deps.brain === undefined) return;
  if (!chatProbeFresh(deps.dialogs, deps.now())) {
    if (repliable.length > 0) report.replyIssues.push('нет свежей пробы чата: npm run hh:inbox -- --probe-chat');
    return;
  }
  const ownReplies = new Map<number, string[]>();
  for (const [i, { topic, queueId }] of repliable.entries()) {
    if (deps.stopRequested?.() === true) {
      report.replyIssues.push('stopped');
      return;
    }
    if (topic.inboxState !== 'AVAILABLE') continue;
    const now = deps.now();
    if (deps.dialogs.hhBotReplies(now - DAY, topic.topicId) >= HH_REPLIES_PER_TOPIC_PER_DAY) continue;
    if (deps.dialogs.hhBotReplies(now - DAY) >= settings.hhInbox.maxRepliesPerDay) {
      report.replyIssues.push('дневной лимит ответов исчерпан');
      return;
    }
    if (i > 0) {
      const [lo, hi] = HH_REPLY_PAUSE_MS;
      await deps.sleep(lo + Math.floor(deps.random() * (hi - lo + 1)));
    }
    const result = await replyToTopic(deps, topic, queueId, ownReplies, report);
    if (result === 'halt') return;
  }
}

async function replyToTopic(
  deps: HhInboxDeps, topic: HhTopic, queueId: number | null, ownReplies: Map<number, string[]>, report: HhInboxReport,
): Promise<'next' | 'halt'> {
  let page: HhNegotiationsPage | null = null;
  let keepForHuman = false;
  try {
    // Чат открывается БЕЗ блокировки — иначе он не рисуется. Работодатель увидит прочтение.
    page = await deps.session.openNegotiations({ allowWrites: true });
    const status = await page.status();
    if (status !== 'ok') {
      report.replyIssues.push(status);
      keepForHuman = status === 'captcha';
      return 'halt';
    }
    const chat = await page.openChat(topic.vacancyId);
    if (chat === null) {
      report.replyIssues.push(`chat_not_found:${topic.topicId}`);
      return 'next';
    }
    const letter = queueId === null ? null : deps.queue.byId(queueId)?.letter ?? null;
    const own = (): OwnTexts => ({ letter, replies: ownReplies.get(topic.topicId) ?? [] });
    const read = await readChatMessages(chat.frame, topic.topicId, own());
    if (read.messages.length === 0) {
      report.replyIssues.push(`chat_unreadable:${topic.topicId}`);
      return 'next';
    }
    const known = deps.dialogs.hhTopic(topic.topicId);
    // Базовая линия: первое чтение чата только запоминает, что в нём уже есть, и не отвечает.
    if (known?.baselineAt === null || known === null) {
      deps.dialogs.markHhSeen(topic.topicId, read.messages.map((m) => m.key), deps.now());
      deps.dialogs.setHhBaseline(topic.topicId, deps.now());
      return 'next';
    }
    const seen = deps.dialogs.hhSeen(topic.topicId);
    const fresh = read.messages.filter((m) => m.direction === 'incoming' && !seen.has(m.key));
    if (fresh.length === 0) return 'next';
    // Ключи — ДО отправки: лучше не ответить, чем ответить дважды.
    deps.dialogs.markHhSeen(topic.topicId, fresh.map((m) => m.key), deps.now());

    const outcome = await deps.brain!({
      channel: 'hh',
      chatKey: hhKey(topic.topicId),
      peerChatId: 0,
      connectionId: null,
      username: null,
      messageIds: [],
      text: fresh.map((m) => m.text).join('\n').slice(0, 6000),
      document: null,
      nonTextOnly: false,
      at: deps.now(),
      edit: null,
      hh: { topicId: topic.topicId, queueId },
    });
    for (const action of outcome.actions) {
      if (action.kind !== 'text') continue;
      const sent = await chat.sendText(action.text);
      if (!sent) {
        // Поле не опустело: сообщение могло уйти, повторять нельзя — прогон ответов стоп.
        report.replyIssues.push(`field_not_cleared:${topic.topicId}`);
        return 'halt';
      }
      ownReplies.set(topic.topicId, [...(ownReplies.get(topic.topicId) ?? []), action.text]);
      report.repliesSent += 1;
      deps.dialogs.botReply({ channel: 'hh', peerKey: String(topic.topicId), username: null }, deps.now());
    }
    const after = await readChatMessages(chat.frame, topic.topicId, own());
    deps.dialogs.markHhSeen(topic.topicId, after.messages.map((m) => m.key), deps.now());
    return 'next';
  } catch (e) {
    report.replyIssues.push(`error:${topic.topicId}:${e instanceof Error ? e.message.slice(0, 80) : 'сбой'}`);
    return 'next';
  } finally {
    if (page !== null) await page.close({ keepForHuman }).catch(() => {});
  }
}

// --- проба ---

export interface HhProbeReport {
  at: number;
  mode: 'read' | 'chat';
  outcome: HhInboxOutcome | 'no_topics';
  topicsSeen: number;
  chat: ChatProbe | null;
  messagesFound: number;
  blockedWrites: string[];
  /** Ответы разрешены пробой (только режим chat). */
  chatProbeOk: boolean;
  error: string | null;
}

/**
 * Разведка чата. Режим read — с блокировкой записи (чат, скорее всего, не
 * нарисуется: это и есть вывод пробы). Режим chat — без неё, единственная
 * запись — notify_chat_opened; сообщения не печатаются и не отправляются.
 * Пишет отчёт в data/hh-debug/inbox-probe-<дата>.json: счётчики и адрес фрейма
 * с цифрами, замененными на N, — без текстов переписки.
 */
export async function probeHhInbox(
  deps: HhInboxDeps, mode: 'read' | 'chat', debugDir = 'data/hh-debug',
): Promise<HhProbeReport> {
  const report: HhProbeReport = {
    at: deps.now(), mode, outcome: 'ok', topicsSeen: 0, chat: null, messagesFound: 0, blockedWrites: [],
    chatProbeOk: false, error: null,
  };
  let page: HhNegotiationsPage | null = null;
  let keepForHuman = false;
  try {
    page = await deps.session.openNegotiations({ allowWrites: mode === 'chat' });
    const status = await page.status();
    if (status !== 'ok') {
      report.outcome = status;
      keepForHuman = status === 'captcha';
    } else {
      const topics = parseTopicList(await page.html());
      if (topics === null) {
        report.outcome = 'error';
        report.error = 'разметка hh изменилась: нет topicList';
      } else {
        report.topicsSeen = topics.length;
        const target = [...topics].sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0)).find((t) => t.messagesCount > 0);
        if (target === undefined) {
          report.outcome = 'no_topics';
        } else {
          const chat = await page.openChat(target.vacancyId);
          if (chat !== null) {
            report.chat = await chat.probe();
            const read = await readChatMessages(chat.frame, target.topicId, { letter: null, replies: [] });
            report.messagesFound = read.messages.length;
            const hasInput = Object.values(report.chat.inputSelectors).some((n) => n > 0);
            report.chatProbeOk = mode === 'chat' && report.messagesFound >= 1 && hasInput;
          }
        }
      }
    }
    report.blockedWrites = page.blockedWrites();
  } catch (e) {
    report.outcome = 'error';
    report.error = e instanceof Error ? e.message : String(e);
  } finally {
    if (page !== null) await page.close({ keepForHuman }).catch(() => {});
  }
  if (report.chatProbeOk) deps.dialogs.kvSet('hh:chatProbeOkAt', String(report.at));
  deps.dialogs.kvSet('hh:probeAt', String(report.at));
  try {
    mkdirSync(debugDir, { recursive: true });
    const stamp = new Date(report.at).toISOString().slice(0, 19).replace(/[:T]/g, '-');
    writeFileSync(join(debugDir, `inbox-probe-${stamp}.json`), JSON.stringify(report, null, 2), 'utf8');
  } catch {
    // отчёт — удобство; проба и без файла сделала своё
  }
  return report;
}

// --- для панели и CLI ---

/** Пора ли запускать плановую проверку (панель смотрит раз в минуту). */
export function hhCheckDue(
  hh: Pick<Settings['hhInbox'], 'enabled' | 'intervalMinutes'>, lastAt: number | null, now: number,
): boolean {
  if (!hh.enabled) return false;
  return lastAt === null || now - lastAt >= hh.intervalMinutes * 60_000;
}

export interface HhPanelStatus {
  enabled: boolean;
  replyEnabled: boolean;
  intervalMinutes: number;
  report: HhInboxReport | null;
  probeAt: number | null;
  chatProbeOkAt: number | null;
  chatProbeFresh: boolean;
}

export function hhStatus(dialogs: Dialogs, hh: Settings['hhInbox'], now: number): HhPanelStatus {
  const num = (key: string): number | null => {
    const raw = dialogs.kvGet(key);
    const n = raw === null || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return {
    enabled: hh.enabled,
    replyEnabled: hh.replyEnabled,
    intervalMinutes: hh.intervalMinutes,
    report: lastHhReport(dialogs),
    probeAt: num('hh:probeAt'),
    chatProbeOkAt: num('hh:chatProbeOkAt'),
    chatProbeFresh: chatProbeFresh(dialogs, now),
  };
}

const OUTCOME_TEXT: Record<HhInboxOutcome, string> = {
  ok: 'проверка прошла',
  auth_required: 'нужен вход на hh.ru: открой браузер профиля и войди',
  captcha: 'hh.ru показал капчу — вкладка оставлена открытой, пройди её руками',
  error: 'сбой',
  profile_busy: 'браузерный профиль занят другим процессом (поиск, отправка или открытое окно)',
};

export function formatHhReport(r: HhInboxReport): string[] {
  const lines = [`hh.ru, ящик откликов: ${OUTCOME_TEXT[r.outcome]}.`];
  if (r.error !== null) lines.push(`Причина: ${r.error}`);
  if (r.outcome === 'ok') {
    lines.push(`Откликов: ${r.topics}; новых ответов: ${r.newReplies}; приглашений: ${r.invites}; отказов: ${r.rejects}.`);
    if (r.repliesSent > 0) lines.push(`Ответов отправлено: ${r.repliesSent}.`);
  }
  for (const issue of r.replyIssues) lines.push(`Ответы: ${issue}`);
  if (r.blockedWrites.length > 0) lines.push(`Заблокировано запросов-изменений: ${r.blockedWrites.join(', ')}`);
  return lines;
}

export function formatHhProbe(r: HhProbeReport): string[] {
  const lines = [`Проба ящика hh (${r.mode === 'chat' ? 'с открытием чата' : 'только чтение'}): ${r.outcome}.`];
  if (r.error !== null) lines.push(`Причина: ${r.error}`);
  lines.push(`Откликов на странице: ${r.topicsSeen}.`);
  if (r.chat === null) {
    if (r.outcome === 'ok') lines.push('Чат открыть не удалось: кнопка «Открыть чат» не нашлась или фрейм не появился.');
  } else {
    lines.push(`Фрейм чата: ${r.chat.frameUrl ?? 'не найден'}; сообщений прочитано: ${r.messagesFound}.`);
    const hits = (m: Record<string, number>): string =>
      Object.entries(m).filter(([, n]) => n > 0).map(([sel, n]) => `${sel} ×${n}`).join('; ') || 'ничего';
    lines.push(`Сообщения: ${hits(r.chat.messageSelectors)}`);
    lines.push(`Поле ввода: ${hits(r.chat.inputSelectors)}`);
    lines.push(`Кнопка отправки: ${hits(r.chat.sendSelectors)}`);
  }
  if (r.mode === 'chat') {
    lines.push(r.chatProbeOk
      ? 'Проба пройдена: ответы работодателям разрешены на 14 дней (если включён тумблер).'
      : 'Проба НЕ пройдена: ответы работодателям остаются запрещены. Отчёт — data/hh-debug/.');
  } else {
    lines.push('Чат в режиме чтения не рисуется: для проверки ответов запусти с --probe-chat.');
  }
  return lines;
}
