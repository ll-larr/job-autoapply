import type { BotAction, HandlerDeps } from './handlers.js';
import { dayKey, allowModelCall, enqueueBotVacancy, firstLink, looksLikeVacancy } from './handlers.js';
import { TEXTS, SECRETARY_TEXTS as T } from './texts.js';
import { isVacancyPost } from '../telegram/parse.js';
import type { ChatMemory, SocialKind } from './memory.js';
import type { Facts, FactTopic } from '../core/facts.js';
import { factFields, lookupFact } from '../core/facts.js';
import { allowedNumbers, mentionsMoney } from '../core/interview.js';
import {
  buildSecretaryMessages, checkSecretaryAnswer, type AnswerProblem, type SecretaryReply,
} from './secretary-prompt.js';
import {
  socialKind, isCvRequest, factTopics, isFactsOnly, isYes, isNo, pickOfferedSlot, meetingSignal,
  countDates, normalizeForRules,
} from './secretary-intents.js';
import { asLocalDate, instantOfLocalDate, formatInZone, wallClockOf, tzLabel, MONTH_NAMES_GEN } from './tz.js';
import { parseMeetTime } from './meet.js';
import { freeSlots, pickOffer, checkSlot, formatSlotList } from './calendar.js';
import type { SecretaryConfig } from '../core/config.js';
import type { ChatMessage } from '../core/openrouter.js';
import type { TgBotDocument } from './types.js';
import type { SeenOutcome } from './state.js';

/**
 * Мозг секретаря (спека 2026-10-09, 6.3): что ответить рекрутёру, написавшему в
 * личку рабочего аккаунта (и, позже, работодателю в чате отклика hh.ru). Не
 * касается ни сети, ни часов: всё внешнее — зависимости, «сейчас» — deps.now.
 * Порядок проверок важен: сначала то, что решают правила (запись на встречу,
 * резюме, факты), и только потом модель — она ничего не записывает и не
 * обещает, а говорит строго по резюме и фактам.
 */

export type SilenceReason = 'disabled' | 'rights' | 'window' | 'limit' | 'muted' | 'loop' | 'cannot_reply';

export interface SecretaryInput {
  channel: 'business' | 'hh';
  /** Ключ чата в таблицах бота: businessKey(peer) | hhKey(topicId). */
  chatKey: number;
  /** business: id собеседника (куда слать ответ); hh: 0. */
  peerChatId: number;
  /** business_connection_id; hh: null. */
  connectionId: string | null;
  /** Собеседник без @ в нижнем регистре; hh и «без username»: null. */
  username: string | null;
  /** id сообщений пачки; hh: []. */
  messageIds: number[];
  /** Склейка пачки через \n, не длиннее 6000. */
  text: string;
  /** Первый документ пачки. */
  document: TgBotDocument | null;
  /** В пачке только стикеры, фото, голосовые и видео без подписи. */
  nonTextOnly: boolean;
  /** Время последнего сообщения пачки, мс. */
  at: number;
  /** Правка сообщения, по которому уже была записана встреча. */
  edit: { messageId: number; meetingId: number | null } | null;
  hh?: { topicId: number; queueId: number | null };
}

/** Что мозг знает о диалогах — для вкладки «Диалоги»; null, когда её нет. */
export interface DialogRef {
  channel: 'business' | 'hh';
  peerKey: string;
  username: string | null;
}

export interface DialogsPort {
  incoming(ref: DialogRef, at: number, queueId: number | null): void;
  outgoing(ref: DialogRef, at: number): void;
  botReply(ref: DialogRef, at: number): void;
  meeting(ref: DialogRef, meetingId: number, at: number): void;
  silenced(ref: DialogRef, reason: SilenceReason | null, at: number): void;
}

export interface SecretaryDeps extends HandlerDeps {
  secretary: SecretaryConfig;
  memory: ChatMemory;
  facts: () => Facts;
  dialogs: DialogsPort | null;
  askSecretary: (messages: ChatMessage[], check: (body: string) => AnswerProblem | null) => Promise<SecretaryReply>;
  /** «печатает…» перед ответом модели; ошибки глотает вызываемая сторона. */
  typing: () => Promise<void>;
  /** Название специальности по умолчанию — для промпта. */
  role: () => string;
}

export interface SecretaryOutcome {
  actions: BotAction[];
  /** Короткое имя того, что сработало, — для журнала (без текстов). */
  intent: string;
  silenced: SilenceReason | null;
  meetingId: number | null;
  /** Для bot_seen: записали встречу, просто ответили или промолчали. */
  outcome: SeenOutcome;
}

const MODE_TTL_MS = 30 * 60_000;
const SOCIAL_COOLDOWN_MS = 6 * 3_600_000;
const SOCIAL_TEXT: Record<SocialKind, string> = { greeting: T.greeting, thanks: T.thanks, bye: T.bye };

const endDot = (s: string): string => (/[.!?…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

export async function handleSecretary(input: SecretaryInput, deps: SecretaryDeps): Promise<SecretaryOutcome> {
  return new Brain(input, deps).run();
}

class Brain {
  private readonly settings: ReturnType<SecretaryDeps['settings']>;
  private readonly nowMs: number;
  private readonly day: string;
  private readonly key: number;
  private readonly cal: ReturnType<SecretaryDeps['settings']>['calendar'];
  private readonly tz: string;
  private readonly acts: BotAction[] = [];
  private readonly intents: string[] = [];
  private silence: SilenceReason | null = null;
  private meetingId: number | null = null;

  constructor(private readonly input: SecretaryInput, private readonly deps: SecretaryDeps) {
    this.settings = deps.settings();
    const now = deps.now();
    this.nowMs = now.getTime();
    this.day = dayKey(now);
    this.key = input.chatKey;
    this.cal = this.settings.calendar;
    this.tz = this.cal.timeZone;
  }

  // --- вывод ---

  private push(text: string, intent: string): void {
    const a: BotAction = this.input.connectionId === null
      ? { kind: 'text', chatId: this.input.peerChatId, text }
      : { kind: 'text', chatId: this.input.peerChatId, text, businessConnectionId: this.input.connectionId };
    this.acts.push(a);
    this.intents.push(intent);
  }

  private pushCv(): void {
    if (this.input.channel === 'hh') {
      this.push(T.hhCv, 'cv');
      return;
    }
    this.acts.push(this.input.connectionId === null
      ? { kind: 'cv', chatId: this.input.peerChatId }
      : { kind: 'cv', chatId: this.input.peerChatId, businessConnectionId: this.input.connectionId });
    this.intents.push('cv');
  }

  private quiet(reason: SilenceReason | null, intent: string): SecretaryOutcome {
    this.silence = reason;
    this.intents.push(intent);
    return this.finish();
  }

  private finish(): SecretaryOutcome {
    return {
      actions: this.acts,
      intent: this.intents.join('+') || 'silent',
      silenced: this.acts.length === 0 ? this.silence : null,
      meetingId: this.meetingId,
      outcome: this.meetingId !== null ? 'meeting' : this.acts.length > 0 ? 'answered' : 'silent',
    };
  }

  // --- состояние чата ---

  private resetModes(): void {
    this.deps.store.setMode(this.key, 'idle', null);
    this.deps.store.setPendingMeet(this.key, null);
    this.deps.store.setOfferedSlots(this.key, null);
  }

  private waitFor(mode: 'await_time' | 'await_meet_confirm'): void {
    this.deps.store.setMode(this.key, mode, this.nowMs + MODE_TTL_MS);
  }

  /** «Местные» часы пояса владельца: parseMeetTime считает в местном времени Date. */
  private nowLocal(): Date {
    return asLocalDate(this.nowMs, this.tz);
  }

  private fmt(at: number): string {
    return formatInZone(at, this.nowMs, this.tz);
  }

  // --- главный порядок правил ---

  async run(): Promise<SecretaryOutcome> {
    const { input, deps, key } = this;
    if (!this.settings.secretary.enabled) return this.quiet('disabled', 'disabled');
    const previous = deps.store.chat(key);
    deps.store.touch(key, input.username, input.at);
    if (previous?.mutedUntil != null && previous.mutedUntil > this.nowMs) return this.quiet('muted', 'muted');

    // Антипетля: автоответчик на той стороне и наши собственные ответы не должны
    // раскручивать переписку. Текст пачки запоминается и при молчании.
    const norm = normalizeForRules(input.text);
    const repeated = input.edit === null && norm !== '' ? deps.memory.swapIncoming(key, norm, this.nowMs) : null;
    if (deps.memory.repliesSince(key, this.nowMs - 3_600_000) >= deps.secretary.maxRepliesPerChatPerHour) {
      return this.quiet('loop', 'loop');
    }
    if (repeated !== null && repeated.norm === norm && this.nowMs - repeated.at < 3_600_000) {
      return this.quiet('loop', 'repeat');
    }

    if (input.edit !== null) return this.handleEdit(input.edit.meetingId);

    const text = input.text;
    let mode = deps.store.modeAt(key, this.nowMs);

    // Рекрутёр отвечает на «Правильно понимаю, что собеседование — …?».
    const extras = deps.store.chatExtras(key);
    if (mode === 'await_meet_confirm') {
      if (extras.pendingMeetAt !== null && isYes(text)) return this.recordMeeting(extras.pendingMeetAt, false);
      this.resetModes();
      mode = 'idle';
      if (isNo(text)) {
        this.push(T.meetRetry, 'meet:retry');
        return this.finish();
      }
    }

    // Рекрутёр выбирает из предложенных слотов.
    if (mode === 'await_time' && extras.offeredSlots.length > 0) {
      const picked = pickOfferedSlot(text, extras.offeredSlots, (ms) => {
        const w = wallClockOf(ms, this.tz);
        return { hour: w.hour, minute: w.minute };
      });
      if (picked !== null) return this.recordMeeting(picked, false);
    }

    if (input.document !== null) return this.handleDocument(input.document);
    if (input.nonTextOnly || text.trim() === '') return this.quiet(null, 'non-text');

    const social = socialKind(text);
    if (social !== null) return this.handleSocial(social);

    if (looksLikeVacancy(text)) return this.vacancyFlow(text);

    return this.handleIntents(text, mode, extras.pendingMeetAt);
  }

  // --- вежливость ---

  private handleSocial(kind: SocialKind | 'ack'): SecretaryOutcome {
    if (kind === 'ack') return this.quiet(null, 'ack');
    const last = this.deps.memory.lastSocialAt(this.key, kind);
    if (last !== null && this.nowMs - last < SOCIAL_COOLDOWN_MS) return this.quiet(null, `${kind}:repeat`);
    this.deps.memory.noteSocial(this.key, kind, this.nowMs);
    this.push(SOCIAL_TEXT[kind], kind);
    return this.finish();
  }

  // --- документ ---

  private async handleDocument(doc: TgBotDocument): Promise<SecretaryOutcome> {
    const read = await this.deps.readFile(doc);
    if (!read.ok) {
      this.push(T.badFile, 'file:bad');
      return this.finish();
    }
    if (!isVacancyPost(read.text)) {
      this.push(T.fileNotVacancy, 'file:other');
      return this.finish();
    }
    return this.vacancyFlow(read.text, true);
  }

  // --- вакансия ---

  private async vacancyFlow(text: string, fromFile = false): Promise<SecretaryOutcome> {
    const { input, deps } = this;
    let body = text;
    const link = fromFile ? null : firstLink(text);
    if (link !== null) {
      const fetched = await deps.readLink(link);
      if (fetched !== null && isVacancyPost(fetched)) {
        body = `${text}\n\n${fetched}`;
      } else if (!isVacancyPost(text)) {
        // Страница не открылась или отдала шапку сайта: кормить этим модель
        // нельзя, виноватым выглядел бы рекрутёр.
        this.push(T.badLink, 'vacancy:badlink');
        return this.finish();
      }
    }
    const last = input.messageIds[input.messageIds.length - 1] ?? 0;
    const enqueued = enqueueBotVacancy(body, last, this.key, input.username, deps);
    return this.askModel({ kind: 'vacancy', text: enqueued.text, role: enqueued.specialty.name, intent: 'vacancy' });
  }

  // --- намерения в свободном тексте ---

  /**
   * Мы спросили «Во сколько завтра удобно?», рекрутёр отвечает «в 15». День он
   * уже называл, поэтому в режиме ожидания времени он подставляется перед ответом
   * («10 октября в 15»). Якорь — полдень этого дня, он лежит в pending_meet_at.
   */
  private anchoredText(text: string, mode: string, anchor: number | null): string {
    if (mode !== 'await_time' || anchor === null) return text;
    if (countDates(normalizeForRules(text)) > 0) return text;
    const w = wallClockOf(anchor, this.tz);
    return `${w.day} ${MONTH_NAMES_GEN[w.month - 1]} ${text}`;
  }

  /** День, который рекрутёр назвал без времени: якорь для следующего ответа. null — день разобрать не вышло. */
  private dayAnchor(text: string): number | null {
    const p = parseMeetTime(`${text} 23:59`, this.nowLocal());
    return p.ok ? instantOfLocalDate(p.at, this.tz) : null;
  }

  private async handleIntents(
    text: string, mode: ReturnType<HandlerDeps['store']['modeAt']>, anchor: number | null,
  ): Promise<SecretaryOutcome> {
    const { deps, key } = this;
    const hasMeeting = deps.store.lastUpcomingMeeting(key, this.nowMs) !== null;
    const meetText = this.anchoredText(text, mode, anchor);
    const signal = meetingSignal(meetText, this.nowLocal(), { mode, hasMeeting });
    let meetingHandled = false;
    let note: string | undefined;

    switch (signal.kind) {
      case 'confirmed': {
        const done = await this.recordMeeting(instantOfLocalDate(signal.at, this.tz), signal.reschedule, text);
        return done;
      }
      case 'ask_confirm':
        // Время без слов о встрече: переспрос — но не поверх вопроса о резюме или
        // фактах, и не там, где человек спрашивает («в 15 лет начал»?).
        if (!isCvRequest(text) && factTopics(text).length === 0 && !text.includes('?')) {
          const at = instantOfLocalDate(signal.at, this.tz);
          deps.store.setPendingMeet(key, at);
          this.waitFor('await_meet_confirm');
          this.push(T.meetAskConfirm(this.fmt(at)), 'meet:ask');
          return this.finish();
        }
        break;
      case 'need_time':
        deps.store.setOfferedSlots(key, null);
        deps.store.setPendingMeet(key, this.dayAnchor(meetText));
        this.waitFor('await_time');
        this.push(T.needTime(signal.day ?? 'в этот день'), 'meet:need-time');
        meetingHandled = true;
        break;
      case 'past':
        this.push(T.meetPast, 'meet:past');
        meetingHandled = true;
        break;
      case 'ambiguous':
        deps.store.setOfferedSlots(key, null);
        deps.store.setPendingMeet(key, null);
        this.waitFor('await_time');
        this.push(T.meetOneTime, 'meet:ambiguous');
        meetingHandled = true;
        break;
      case 'declined':
        this.push(T.cancelNoted, 'meet:declined');
        meetingHandled = true;
        break;
      case 'ask_slots':
        this.offerSlots(false);
        meetingHandled = true;
        break;
      case 'none':
        break;
    }

    if (meetingHandled) {
      // В том же сообщении мог быть и вопрос по существу («когда удобно? а сколько вы хотите?»).
      const rest = this.leftoverQuestions(text, (s) => countDates(normalizeForRules(s)) > 0
        || /(собеседован|созвон|встреч|звон|удобно|время)/.test(normalizeForRules(s)));
      if (rest === null) return this.finish();
      note = 'Про время встречи рекрутёру уже ответили отдельным сообщением — не пиши о нём.';
      return this.answerQuestion(rest, note);
    }

    if (isCvRequest(text)) {
      this.pushCv();
      const rest = this.leftoverQuestions(text, (s) => isCvRequest(s));
      return rest === null ? this.finish() : this.answerQuestion(rest);
    }

    return this.answerQuestion(text);
  }

  /** Предложения с «?», которые не касаются уже обработанного; null — таких нет. */
  private leftoverQuestions(text: string, handled: (sentence: string) => boolean): string | null {
    const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.includes('?'));
    const rest = sentences.filter((s) => !handled(s) && s.replace(/[^A-Za-zА-Яа-яЁё]/g, '').length >= 12);
    return rest.length === 0 ? null : rest.join('\n');
  }

  /** Вопрос по существу: сначала факты без модели, потом модель. */
  private async answerQuestion(text: string, note?: string): Promise<SecretaryOutcome> {
    const topics = factTopics(text);
    if (topics.length > 0 && isFactsOnly(text)) {
      this.push(this.factsAnswer(topics), 'facts');
      return this.finish();
    }
    return this.askModel({ kind: 'question', text, intent: 'question', note });
  }

  private factsAnswer(topics: FactTopic[]): string {
    const fields = factFields(this.deps.facts().text);
    const lines: string[] = [];
    for (const topic of topics) {
      for (const { label, value } of lookupFact(fields, topic)) {
        if (value !== null) lines.push(`${label}: ${endDot(value)}`);
        else if (topic === 'salary') lines.push(`Зарплатные ожидания: ${endDot(this.deps.salaryExpectation)}`);
        else lines.push(`${label}: ${T.factUnknown}`);
      }
    }
    return lines.join('\n');
  }

  // --- модель ---

  private contextVacancy(): { title: string; url: string; description: string } | null {
    const { input, deps } = this;
    if (input.hh?.queueId != null) {
      const row = deps.queue.byId(input.hh.queueId);
      return row === null ? null : { title: row.vacancy.title, url: row.vacancy.url, description: row.vacancy.description };
    }
    const lastSent = input.username === null ? null : deps.queue.lastSentRowTo(input.username);
    const chat = deps.store.chat(this.key);
    let row = null as ReturnType<typeof deps.queue.byId>;
    // Вакансия, которую рекрутёр прислал сам уже после нашего сообщения, главнее.
    if (chat?.lastQueueId != null) {
      const sent = deps.queue.byId(chat.lastQueueId);
      if (sent !== null && (lastSent === null || sent.createdAt > (lastSent.sentAt ?? 0))) row = sent;
    }
    row ??= lastSent;
    return row === null ? null : { title: row.vacancy.title, url: row.vacancy.url, description: row.vacancy.description };
  }

  private async askModel(o: { kind: 'question' | 'vacancy'; text: string; role?: string; note?: string; intent: string }): Promise<SecretaryOutcome> {
    const { deps, key } = this;
    if (!allowModelCall(key, this.day, deps)) return this.quiet('limit', 'limit');
    deps.store.countModelCall(this.day, key);
    deps.store.countModelCall(this.day, 0);
    try {
      await deps.typing();
    } catch {
      // «печатает…» — мелочь: ради неё ответ не теряется
    }
    const facts = deps.facts();
    const resume = deps.resume();
    const history = deps.memory.recent(key, this.nowMs);
    const vacancy = o.kind === 'vacancy' ? null : this.contextVacancy();
    const recruiterTexts = history.filter((t) => t.who === 'recruiter').map((t) => t.text);
    // Числа вакансии разрешены, пока вопрос не о деньгах: иначе модель могла бы
    // назвать чужую зарплатную вилку как ожидания кандидата.
    const vacancyNumbers = vacancy !== null && !mentionsMoney(o.text) ? [vacancy.description] : [];
    const allowed = allowedNumbers([resume, facts.text, deps.salaryExpectation, o.text, ...recruiterTexts, ...vacancyNumbers]);
    const knownText = [resume, facts.text, vacancy?.description ?? '', vacancy?.url ?? '', o.text, ...recruiterTexts].join('\n');
    const messages = buildSecretaryMessages({
      kind: o.kind, text: o.text, resume, facts: facts.text, role: o.role ?? deps.role(),
      salaryExpectation: deps.salaryExpectation, vacancy, history, note: o.note,
    });
    const reply = await deps.askSecretary(messages, (body) => checkSecretaryAnswer(body, { allowed, question: o.text, knownText }));
    return this.replyOutcome(reply, o.intent);
  }

  /** Исход вызова модели в текст рекрутёру (таблица 6.3). */
  private replyOutcome(reply: SecretaryReply, intent: string): SecretaryOutcome {
    const { deps, key } = this;
    switch (reply.kind) {
      case 'text':
        deps.store.resetStrikes(key);
        this.push(reply.text, intent);
        break;
      case 'offtopic':
      case 'leak': {
        // Оффтоп и утечка отвечаются одним текстом (решение владельца 2026-09-20)
        // и оба дают страйк: снаружи это одно и то же.
        const strikes = deps.store.addStrike(key);
        if (strikes >= deps.limits.strikesBeforeMute) {
          deps.store.mute(key, this.nowMs + deps.limits.muteHours * 3_600_000);
        }
        this.push(TEXTS.offTopic, `${intent}:${reply.kind}`);
        break;
      }
      case 'unsupported':
        // Модель выдумала число, навык или обещание: виноват не рекрутёр, страйка нет.
        this.push(T.unsupported, `${intent}:unsupported`);
        break;
      case 'failure':
        // Отписка владельца дословно (спека 2026-09-25, 1.1), страйка нет.
        this.push(T.busy, `${intent}:failure`);
        break;
    }
    return this.finish();
  }

  // --- слоты ---

  /** Предлагает слоты из календаря либо просит назвать время. `afterReject` — предыдущее время не подошло. */
  private offerSlots(afterReject: false | 'busy' | 'outside'): void {
    const { deps, key } = this;
    deps.store.setPendingMeet(key, null);
    if (!this.cal.slotsEnabled) {
      deps.store.setOfferedSlots(key, null);
      this.waitFor('await_time');
      this.push(T.askTime, 'meet:ask-time');
      return;
    }
    const meetings = deps.store.upcomingMeetings(this.nowMs, this.nowMs + (this.cal.horizonDays + 1) * 86_400_000);
    const offer = pickOffer(freeSlots(this.nowMs, this.cal, meetings), this.tz);
    this.waitFor('await_time');
    if (offer.length === 0) {
      deps.store.setOfferedSlots(key, null);
      this.push(T.noSlots, 'meet:no-slots');
      return;
    }
    deps.store.setOfferedSlots(key, offer);
    const list = formatSlotList(offer, this.tz);
    const textOut = afterReject === 'busy' ? T.meetBusy(list)
      : afterReject === 'outside' ? T.meetOutside(list)
        : T.slots(list, tzLabel(this.tz));
    this.push(textOut, afterReject === false ? 'meet:slots' : `meet:${afterReject}`);
  }

  // --- запись на собеседование ---

  private async handleEdit(meetingId: number | null): Promise<SecretaryOutcome> {
    const { deps, key } = this;
    if (meetingId === null) return this.quiet(null, 'edit');
    const previous = deps.store.meetingById(meetingId);
    if (previous === null) return this.quiet(null, 'edit');
    const signal = meetingSignal(this.input.text, this.nowLocal(), { mode: 'idle', hasMeeting: true });
    if (signal.kind !== 'confirmed') return this.quiet(null, 'edit');
    const at = instantOfLocalDate(signal.at, this.tz);
    if (Math.abs(previous.meetAt - at) < 60_000) return this.quiet(null, 'edit');
    void key;
    return this.recordMeeting(at, true);
  }

  /**
   * Запись сделана ДО ответа рекрутёру: сбой сети не теряет договорённость.
   * Пинг владельцу собирает цикл бота из bot_meetings.
   */
  private async recordMeeting(at: number, reschedule: boolean, raw?: string): Promise<SecretaryOutcome> {
    const { input, deps, key } = this;
    const tooSoon = at < this.nowMs + 60 * 60_000;
    const horizonMs = (this.cal.slotsEnabled ? this.cal.horizonDays : 60) * 86_400_000;
    if (tooSoon) return this.rejectMeeting(T.meetTooSoon, 'meet:too-soon');
    if (at > this.nowMs + horizonMs) return this.rejectMeeting(T.meetTooFar, 'meet:too-far');

    if (this.cal.slotsEnabled) {
      const meetings = deps.store.upcomingMeetings(this.nowMs, this.nowMs + horizonMs + 86_400_000)
        // Перенос: прежняя запись освободится, она не должна мешать новому времени.
        .filter((m) => !(reschedule && m.id === deps.store.lastUpcomingMeeting(key, this.nowMs)?.id));
      const check = checkSlot(at, this.cal, meetings);
      if (check !== 'ok') {
        this.offerSlots(check);
        return this.finish();
      }
    }

    if (deps.store.meetingsToday(key, this.day) >= deps.limits.meetingsPerChatPerDay) {
      return this.rejectMeeting(T.meetLimit, 'meet:limit');
    }

    const queueId = this.meetingQueueId();
    const previous = reschedule ? deps.store.lastUpcomingMeeting(key, this.nowMs) : null;
    if (previous !== null) deps.store.supersedeMeeting(previous.id, this.nowMs);
    const id = deps.store.saveMeeting({
      chatId: key,
      username: input.username,
      queueId,
      meetAt: at,
      raw: (raw ?? input.text).trim().slice(0, 300),
      createdAt: this.nowMs,
      channel: input.channel,
      peerChatId: input.channel === 'business' ? input.peerChatId : null,
      sourceMsgId: input.messageIds[input.messageIds.length - 1] ?? null,
      replacesId: previous?.id ?? null,
    });
    this.meetingId = id;
    this.resetModes();
    deps.dialogs?.meeting(
      { channel: input.channel, peerKey: input.channel === 'business' ? String(input.peerChatId) : String(input.hh?.topicId ?? 0), username: input.username },
      id, this.nowMs,
    );
    this.push(T.meetSaved(this.fmt(at)), previous === null ? 'meet:saved' : 'meet:rescheduled');
    return this.finish();
  }

  private rejectMeeting(text: string, intent: string): SecretaryOutcome {
    this.resetModes();
    this.push(text, intent);
    return this.finish();
  }

  /** К какой вакансии относится встреча: присланная рекрутёром после нашего сообщения, иначе наша отправленная. */
  private meetingQueueId(): number | null {
    const { input, deps } = this;
    if (input.hh?.queueId != null) return input.hh.queueId;
    const lastSent = input.username === null ? null : deps.queue.lastSentRowTo(input.username);
    const chat = deps.store.chat(this.key);
    if (chat?.lastQueueId != null) {
      const row = deps.queue.byId(chat.lastQueueId);
      if (row !== null && (lastSent === null || row.createdAt > (lastSent.sentAt ?? 0))) return row.id;
    }
    return lastSent?.id ?? null;
  }
}
