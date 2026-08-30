import type { BrowserContext, Frame, Locator, Page } from 'playwright';
import { normalizeVacancy, type Vacancy } from '../core/vacancy.js';
import type { Adapter, ApplyResult, SearchFilters } from './types.js';
import { isLoggedIn, openProfile } from '../browser.js';

/**
 * Селекторы и контракт подачи взяты дословно из docs/hh-selectors.md — карты,
 * снятой с живого залогиненного профиля (scripts/capture-hh.ts,
 * scripts/send-hh-letter.ts). Ничего здесь не угадано: там, где карта прямо
 * говорит "не снято" (капча, «уже откликался»), соответствующие функции ниже
 * так и остаются заглушками, а не выдуманными селекторами — см. detectCaptcha
 * и detectAlreadyApplied.
 */
const SEARCH_CARD = '[data-qa="vacancy-serp__vacancy"]';
const SEARCH_TITLE_LINK = 'a[data-qa="serp-item__title"]';
const SEARCH_TITLE_TEXT = '[data-qa="serp-item__title-text"]';
const SEARCH_EMPLOYER_TEXT = '[data-qa="vacancy-serp__vacancy-employer-text"]';
const SEARCH_ADDRESS = '[data-qa="vacancy-serp__vacancy-address"]';
const SEARCH_COMPENSATION = '[data-qa="vacancy-serp__compensation"]';
const VACANCY_DESCRIPTION = '[data-qa="vacancy-description"]';
const APPLY_BUTTON = '[data-qa="vacancy-response-link-top"]';
const NEGOTIATIONS_ITEM = '[data-qa="negotiations-item"]';
const OPEN_CHAT_BUTTON = '[data-qa="open_chat"]';

/**
 * Снятый маркер успешной подачи в докe написан как
 * `[data-qa="vacancy-response-success-standard-notification"]` (точное
 * совпадение), но в самой фикстуре (tests/fixtures/hh-response-sent.html)
 * атрибут составной — `data-qa="vacancy-response-success-standard-notification
 * snackbar"` (та же система, что и у `negotiations-tag negotiations-item-*`:
 * компонент снекбара всегда дописывает своё имя вторым словом). CSS
 * `[attr="value"]` — точное совпадение всей строки, оно НЕ сработает на
 * составном значении. Проверено прямым чтением фикстуры, не догадка:
 * используем `~=` (совпадение по одному из пробельно-разделённых слов).
 */
const SUCCESS_MARKER = '[data-qa~="vacancy-response-success-standard-notification"]';

export function buildSearchUrl(query: string): string {
  const params = new URLSearchParams({ text: query, area: '1' });
  return `https://hh.ru/search/vacancy?${params.toString()}`;
}

export function extractVacancyId(url: string): string | null {
  const m = /\/vacancy\/(\d+)/.exec(url);
  return m ? m[1]! : null;
}

export function canonicalVacancyUrl(id: string): string {
  return `https://hh.ru/vacancy/${id}`;
}

export interface ParsedSalary {
  from: number | null;
  to: number | null;
  currency: string | null;
}

const CURRENCY_SYMBOLS: Array<[string, string]> = [
  ['₽', 'RUR'],
  ['$', 'USD'],
  ['€', 'EUR'],
];

/**
 * Формат текста зарплаты на карточке не был снят живьём: документированный
 * селектор `[data-qa="vacancy-serp__compensation"]` в реальной фикстуре
 * (hh-search.html) указывает не на зарплату конкретной карточки, а на
 * скрытое поле формы поиска (`<input type="hidden" name="salary" value="">`,
 * встречается один раз на всю страницу, вне любой карточки) — см.
 * task-10-report.md, раздел «Находки». Зарплата видна лишь у 1 карточки из
 * 50 и скорером не используется, так что падать из-за неё нельзя ни при
 * каких обстоятельствах — эта функция всегда возвращает null-поля на пустом
 * или нечисловом входе и никогда не бросает исключение.
 */
export function parseSalaryText(raw: string): ParsedSalary {
  const text = raw.trim();
  if (text === '') return { from: null, to: null, currency: null };

  let currency: string | null = null;
  for (const [sym, code] of CURRENCY_SYMBOLS) {
    if (text.includes(sym)) {
      currency = code;
      break;
    }
  }

  const numbers = [...text.matchAll(/\d[\d\s]*\d|\d/g)]
    .map((m) => Number(m[0].replace(/\s/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (numbers.length === 0) return { from: null, to: null, currency };
  if (numbers.length === 1) return { from: numbers[0]!, to: numbers[0]!, currency };
  return { from: Math.min(numbers[0]!, numbers[1]!), to: Math.max(numbers[0]!, numbers[1]!), currency };
}

export interface HhSearchItem {
  sourceId: string;
  title: string;
  company: string;
  geo: string;
  url: string;
  salaryFrom: number | null;
  salaryTo: number | null;
  currency: string | null;
}

async function textOf(locator: Locator): Promise<string> {
  return (await locator.first().innerText().catch(() => '')).trim();
}

/**
 * Разбирает карточки выдачи `/search/vacancy` через Playwright DOM (не
 * регэкспы по HTML) — берётся `page: Page`, чтобы прогонять офлайн через
 * `page.setContent(fixtureHtml)`, без сети.
 */
export async function parseSearchPage(page: Page): Promise<HhSearchItem[]> {
  const cards = page.locator(SEARCH_CARD);
  const count = await cards.count();
  const out: HhSearchItem[] = [];

  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    const link = card.locator(SEARCH_TITLE_LINK).first();
    const href = await link.getAttribute('href');
    const id = href ? extractVacancyId(href) : null;
    // Без id вакансию нельзя ни задедуплицировать, ни повторно открыть —
    // такую карточку пропускаем, а не роняем весь разбор выдачи.
    if (id === null) continue;

    const title = await textOf(card.locator(SEARCH_TITLE_TEXT));
    const company = await textOf(card.locator(SEARCH_EMPLOYER_TEXT));
    const geo = await textOf(card.locator(SEARCH_ADDRESS));

    const salaryLocator = card.locator(SEARCH_COMPENSATION);
    let salaryRaw = '';
    if ((await salaryLocator.count()) > 0) {
      const el = salaryLocator.first();
      salaryRaw = (await el.getAttribute('value').catch(() => null))
        || (await el.textContent().catch(() => '')) || '';
    }
    const salary = parseSalaryText(salaryRaw);

    out.push({
      sourceId: id,
      title,
      company,
      geo,
      url: canonicalVacancyUrl(id),
      salaryFrom: salary.from,
      salaryTo: salary.to,
      currency: salary.currency,
    });
  }

  return out;
}

/** Читает описание со страницы вакансии — то самое поле, по которому считает скорер. */
async function readVacancyDescription(page: Page, timeoutMs: number): Promise<string> {
  const desc = page.locator(VACANCY_DESCRIPTION).first();
  try {
    await desc.waitFor({ state: 'attached', timeout: timeoutMs });
  } catch {
    return '';
  }
  return (await desc.innerText().catch(() => '')).trim();
}

/** Есть ли на странице вакансии видимый маркер успешной подачи (снекбар "Application sent"). */
export async function detectSubmitSuccess(page: Page, timeoutMs: number): Promise<boolean> {
  return page
    .locator(SUCCESS_MARKER)
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

/**
 * НЕ ПОДТВЕРЖДЕНО ЖИВЬЁМ. Признак капчи на hh.ru ни разу не встретился ни в
 * одной снятой фикстуре (docs/hh-selectors.md, раздел «что действительно
 * осталось неизвестным») — снять его означало бы вручную пройти капчу ради
 * разведки, отдельный риск, на который никто не пошёл. Функция всегда
 * возвращает false: капча этим кодом не детектируется. Практическое
 * следствие — клик по кнопке отклика на капче просто не приведёт к
 * появлению маркера успеха, и apply() вернёт 'failed' по таймауту вместо
 * 'captcha'. Когда селектор снимут живьём, здесь достаточно заменить
 * реализацию, сигнатура не изменится.
 */
export async function detectCaptcha(_page: Page): Promise<boolean> {
  return false;
}

/**
 * НЕ ПОДТВЕРЖДЕНО ЖИВЬЁМ — тот же случай, что и detectCaptcha. Признак «вы
 * уже откликались» на странице вакансии не встретился ни в одной снятой
 * фикстуре; дедуп полагается только на локальную БД (Queue), а не на этот
 * сигнал. Всегда возвращает false до появления снятого селектора.
 */
export async function detectAlreadyApplied(_page: Page): Promise<boolean> {
  return false;
}

export interface ApplyOutcomeSignals {
  captcha: boolean;
  sessionLost: boolean;
  alreadyApplied: boolean;
  submitted: boolean;
  /** Причина неудачи — используется только когда ни один из флагов выше не установлен. */
  reason?: string;
}

const DEFAULT_FAILED_REASON = 'подача не подтверждена: маркер успеха не появился';

/**
 * Приоритет исходов: капча → потеря сессии → уже откликались → подано →
 * иначе неудача. Капча и потеря сессии — единственные исходы, на которых
 * стоит останавливать всю очередь (см. isHaltingResult в ./types.ts),
 * поэтому они проверяются первыми и не могут быть перекрыты более поздними
 * сигналами.
 */
export function classifyApplyOutcome(signals: ApplyOutcomeSignals): ApplyResult {
  if (signals.captcha) return { status: 'captcha' };
  if (signals.sessionLost) return { status: 'auth_required' };
  if (signals.alreadyApplied) return { status: 'already_applied' };
  if (signals.submitted) return { status: 'sent' };
  return { status: 'failed', reason: signals.reason ?? DEFAULT_FAILED_REASON };
}

/**
 * Карточка отклика на `/applicant/negotiations`, содержащая ссылку на
 * нужную вакансию — тот же способ поиска, что в проверенном живьём
 * scripts/send-hh-letter.ts (`.filter({ has: ... })` по `a[href*="/vacancy/ID"]`).
 */
export function findNegotiationsItem(page: Page, vacancyId: string): Locator {
  return page
    .locator(NEGOTIATIONS_ITEM)
    .filter({ has: page.locator(`a[href*="/vacancy/${vacancyId}"]`) })
    .first();
}

async function waitForChatFrame(page: Page, timeoutMs: number): Promise<Frame | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frame = page.frames().find((f) => f.url().includes('chatik.hh.ru/chat/'));
    if (frame) return frame;
    if (Date.now() >= deadline) return undefined;
    await page.waitForTimeout(Math.min(250, deadline - Date.now()));
  }
}

/**
 * Печатает текст в поле чата — textarea или contenteditable, без
 * hh.ru-специфичного data-qa (карта его не снимала, это чужой домен
 * chatik.hh.ru). Тот же селектор и тот же fallback на keyboard.insertText,
 * что в проверенном живьём scripts/send-hh-letter.ts.
 */
export async function typeIntoChatFrame(frame: Frame, text: string): Promise<void> {
  const field = frame.locator('textarea, [contenteditable="true"]').first();
  await field.click();
  await field.fill(text).catch(async () => {
    await frame.page().keyboard.insertText(text);
  });
}

async function submitChatMessage(frame: Frame): Promise<void> {
  const sendButton = frame
    .locator('button[type="submit"], [data-qa*="send"], button:has-text("Отправить")')
    .first();
  if (await sendButton.isVisible().catch(() => false)) {
    await sendButton.click();
    return;
  }
  await frame.locator('textarea, [contenteditable="true"]').first().press('Enter');
}

interface Timeouts {
  navigationMs: number;
  submitMs: number;
  descriptionMs: number;
  chatFrameMs: number;
}

const DEFAULT_TIMEOUTS: Timeouts = {
  navigationMs: 60_000,
  submitMs: 15_000,
  descriptionMs: 15_000,
  chatFrameMs: 15_000,
};

export interface HhAdapterOptions {
  /** Для тестов — свой BrowserContext вместо реального залогиненного профиля. */
  context?: BrowserContext;
  timeouts?: Partial<Timeouts>;
}

export class HhAdapter implements Adapter {
  readonly name = 'hh';
  private context: BrowserContext | undefined;
  private readonly timeouts: Timeouts;

  constructor(opts: HhAdapterOptions = {}) {
    this.context = opts.context;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
  }

  private async getContext(): Promise<BrowserContext> {
    if (!this.context) {
      this.context = await openProfile(false);
    }
    return this.context;
  }

  async search(filters: SearchFilters): Promise<Vacancy[]> {
    const context = await this.getContext();
    const page = await context.newPage();
    try {
      const url = buildSearchUrl(filters.query);
      // waitUntil:'load'/'networkidle' никогда не наступают на hh.ru —
      // страница держит фоновые запросы (реклама, опросы, аналитика)
      // неопределённо долго (см. scripts/capture-hh.ts). Ждём
      // domcontentloaded, а затем — конкретный элемент, который нужен.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeouts.navigationMs });
      await page.locator(SEARCH_TITLE_LINK).first()
        .waitFor({ state: 'attached', timeout: this.timeouts.navigationMs })
        .catch(() => {});

      const items = await parseSearchPage(page);
      const wanted = filters.maxResults === undefined ? items : items.slice(0, filters.maxResults);

      const out: Vacancy[] = [];
      for (const item of wanted) {
        // Скорер считает по title+description — карточка выдачи описания
        // не несёт, поэтому дочитка страницы вакансии не опциональна: без
        // неё вакансия почти всегда наберёт околонулевой балл и отсеется.
        await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: this.timeouts.navigationMs });
        const description = await readVacancyDescription(page, this.timeouts.descriptionMs);
        out.push(normalizeVacancy({
          source: 'hh',
          sourceId: item.sourceId,
          title: item.title,
          company: item.company,
          url: item.url,
          description,
          geo: item.geo,
          // Дата публикации не показана на карточках этой выдачи (проверено
          // на снятой фикстуре) и не задокументирована в hh-selectors.md —
          // не выдумываем разметку под неё, берём момент чтения.
          postedAt: new Date(),
          salaryFrom: item.salaryFrom,
          salaryTo: item.salaryTo,
          currency: item.currency,
          isRemote: false,
        }));
      }
      return out;
    } finally {
      await page.close();
    }
  }

  /**
   * Второй шаг подачи: сопроводительное письмо уходит не с откликом, а
   * отдельным сообщением в чат по отклику (докой подтверждено — у hh.ru нет
   * маршрута, где письмо уходит одним действием с откликом). Логика —
   * прямой перенос проверенного живьём scripts/send-hh-letter.ts; сам
   * скрипт не тронут, чтобы не рисковать сломать доказанно рабочий код.
   */
  private async sendCoverLetterToChat(
    context: BrowserContext,
    vacancyId: string,
    letter: string,
  ): Promise<void> {
    const page = await context.newPage();
    try {
      await page.goto('https://hh.ru/applicant/negotiations', {
        waitUntil: 'domcontentloaded',
        timeout: this.timeouts.navigationMs,
      });

      const item = findNegotiationsItem(page, vacancyId);
      if ((await item.count()) === 0) {
        throw new Error(`карточка отклика на вакансию ${vacancyId} не найдена на /applicant/negotiations`);
      }

      await item.locator(OPEN_CHAT_BUTTON).first().click();

      // Чат живёт в отдельном iframe на chatik.hh.ru, а не в основном
      // документе — поиск по странице его не видит.
      const chatFrame = await waitForChatFrame(page, this.timeouts.chatFrameMs);
      if (!chatFrame) {
        throw new Error('iframe чата (chatik.hh.ru/chat/) не появился за отведённое время');
      }

      await typeIntoChatFrame(chatFrame, letter);
      await submitChatMessage(chatFrame);
    } finally {
      await page.close();
    }
  }

  async apply(vacancy: Vacancy, letter: string): Promise<ApplyResult> {
    const context = await this.getContext();
    const page = await context.newPage();
    try {
      await page.goto(vacancy.url, { waitUntil: 'domcontentloaded', timeout: this.timeouts.navigationMs });

      // Потерянная сессия — используем уже проверенный isLoggedIn() из
      // browser.ts, а не изобретаем свой сигнал.
      if (!(await isLoggedIn(page))) {
        return classifyApplyOutcome({
          captcha: false, sessionLost: true, alreadyApplied: false, submitted: false,
        });
      }
      if (await detectCaptcha(page)) {
        return classifyApplyOutcome({
          captcha: true, sessionLost: false, alreadyApplied: false, submitted: false,
        });
      }
      if (await detectAlreadyApplied(page)) {
        return classifyApplyOutcome({
          captcha: false, sessionLost: false, alreadyApplied: true, submitted: false,
        });
      }

      // Шаг 1, подача. Промежуточной формы нет: при наличии резюме и
      // необязательности письма hh.ru подаёт отклик сразу по клику.
      // Кнопка встречается 3 раза (верх/низ/липкая панель) — берём first().
      // Кликаем ровно один раз и никогда не повторяем: если подача уже
      // прошла, повторный клик рискует задвоить отклик.
      await page.locator(APPLY_BUTTON).first().click();

      const submitted = await detectSubmitSuccess(page, this.timeouts.submitMs);
      if (!submitted) {
        // Разграничиваем «не подано» от «подано, но сессия слетела прямо
        // на клике» тем же проверенным сигналом, что и в начале.
        if (!(await isLoggedIn(page))) {
          return classifyApplyOutcome({
            captcha: false, sessionLost: true, alreadyApplied: false, submitted: false,
          });
        }
        return classifyApplyOutcome({
          captcha: false, sessionLost: false, alreadyApplied: false, submitted: false,
          reason: `клик по кнопке отклика не привёл к подтверждению подачи для вакансии ${vacancy.sourceId}`,
        });
      }

      // Шаг 2, письмо в чат. Отклик уже ушёл — если письмо не отправится,
      // возвращаем всё равно 'sent' (иначе очередь ошибочно сочтёт заявку
      // неподанной и попробует снова — а откликов на hh.ru не отменить) и
      // громко логируем, а не проглатываем ошибку молча.
      try {
        await this.sendCoverLetterToChat(context, vacancy.sourceId, letter);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[hh] ВНИМАНИЕ: отклик на вакансию ${vacancy.sourceId} отправлен, но письмо в чат не ушло: ${message}`,
        );
      }

      return classifyApplyOutcome({
        captcha: false, sessionLost: false, alreadyApplied: false, submitted: true,
      });
    } finally {
      await page.close();
    }
  }
}
