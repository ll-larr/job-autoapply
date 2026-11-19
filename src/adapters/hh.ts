import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Frame, Locator, Page } from 'playwright';
import { normalizeVacancy, type ExperienceLevel, type Vacancy } from '../core/vacancy.js';
import { parseExperienceFromText } from '../core/screening.js';
import type { Adapter, ApplyResult, SearchFilters } from './types.js';
import { hasTitleWord, isAboveJuniorTitle, isExperienceWithin, isSeniorTitle } from '../core/screening.js';
import { DEFAULT_EXPERIENCE_YEARS } from '../core/specialty-defaults.js';
import { isLoggedIn, sharedProfile } from '../browser.js';
import { isStopRequested } from '../core/sender.js';
import {
  DEFAULT_SEARCH_PACING, NO_PACING, pickDelay, sleepUnlessAborted, type MsRange, type SearchPacing,
} from '../core/pacing.js';
import type { CaptchaSolution, CaptchaSolver } from '../core/captcha-solver.js';
import type { QuestionOption, TestAnswer, TestQuestion } from '../core/questions.js';

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
/**
 * Требуемый опыт на карточке выдачи — структурный маркер, суффикс data-qa
 * вида `vacancy-serp__vacancy-work-experience-between1And3`, а не текст
 * элемента (текст на снятой фикстуре — английский, "Without experience" —
 * страница явно рендерилась под англоязычный интерфейс; суффикс атрибута
 * от языка интерфейса не зависит). Снято прямым чтением
 * tests/fixtures/hh-search.html: на всех 50 карточках встречается ровно
 * один из четырёх суффиксов — см. KNOWN_EXPERIENCE_LEVELS.
 */
const SEARCH_EXPERIENCE = '[data-qa^="vacancy-serp__vacancy-work-experience-"]';
const SEARCH_EXPERIENCE_PREFIX = 'vacancy-serp__vacancy-work-experience-';
const VACANCY_DESCRIPTION = '[data-qa="vacancy-description"]';
const APPLY_BUTTON = '[data-qa="vacancy-response-link-top"]';
/** Пометка «В архиве» у заголовка. Снята живьём 2026-09-19 на вакансии 136227311. */
const ARCHIVED_MARKER = '[data-qa="vacancy-title-archived-text"]';
/**
 * Признаки «на эту вакансию уже откликнулись». Сняты живьём 2026-09-01
 * сравнением двух страниц под одним и тем же залогиненным профилем: на
 * вакансии 136781841, куда владелец подал отклик руками, и на 136227311, куда
 * не подавал.
 *
 * Разница однозначная. У откликнувшейся вакансии обычной кнопки
 * `vacancy-response-link-top` НЕТ ВООБЩЕ, вместо неё появляются эти две. У
 * обычной — ровно наоборот.
 *
 * Пока этих селекторов не было, adapter жал несуществующую кнопку, ждал
 * подтверждения, не дожидался и писал отказ. Три отказа подряд гасили
 * предохранителем всю площадку — в бою это выглядело как «отправка стопится и
 * ломается, если встречает вакансию, отклик по которой уже отправлен».
 */
const RESPONSE_LINK_VIEW_TOPIC = '[data-qa="vacancy-response-link-view-topic"]';
const RESPONSE_LINK_AGAIN = '[data-qa="vacancy-response-link-top-again"]';
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

/**
 * Окно отклика. Появилось в сентябре 2026: клик по «Откликнуться» больше не
 * подаёт отклик сразу, а открывает форму — выбор резюме, поле письма и
 * «Send application». У вакансий с анкетой работодателя та же форма живёт на
 * отдельной странице `/applicant/vacancy_response?vacancyId=…` с вопросами
 * сверху. Сняты живьём 2026-09-19 при полной блокировке модифицирующих
 * запросов (scripts/capture-hh-response-form.ts, capture-hh-response-modal.ts):
 * tests/fixtures/hh-response-resume-picker.html, hh-response-resume-list.html,
 * hh-response-letter-open.html, hh-response-questions.html.
 *
 * Отправляет форму ТОЛЬКО клик по MODAL_SUBMIT. Раскрытие списка резюме, выбор
 * резюме и «добавить письмо» — клиентские, на сеть не ходят (проверено той же
 * блокировкой: ни одного запроса к /applicant/vacancy_response).
 */
const RESPONSE_FORM = 'form[name="vacancy_response"]';
const MODAL_SUBMIT = '[data-qa="vacancy-response-submit-popup"]';
const RESUME_TITLE = '[data-qa="resume-title"]';
const RESUME_OPTION = '[role="option"]';
const LETTER_INPUT = '[data-qa="vacancy-response-popup-form-letter-input"]';
/** В окне кнопка подписана «Add a CV» — кривой перевод, на деле это письмо. */
const LETTER_TOGGLE = '[data-qa="add-cover-letter"], [data-qa="vacancy-response-letter-toggle"]';
const TASK_BODY = '[data-qa="task-body"]';
const TASK_QUESTION = '[data-qa="task-question"]';

/** Ячейка выбранного резюме в форме — role=button с resume-title внутри. */
function resumeCell(page: Page): Locator {
  return page.locator(`${RESPONSE_FORM} [role="button"]`).filter({ has: page.locator(RESUME_TITLE) }).first();
}

async function textOfFirst(loc: Locator): Promise<string> {
  return ((await loc.first().textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Выбирает резюме по точному названию. `not_found` — такого резюме в списке
 * нет (переименовали?): форма остаётся с резюме по умолчанию, решает вызывающий.
 */
export async function selectResume(page: Page, title: string): Promise<'already' | 'selected' | 'not_found'> {
  const cell = resumeCell(page);
  if ((await cell.count()) === 0) return 'not_found';
  if ((await textOfFirst(cell.locator(RESUME_TITLE))) === title) return 'already';

  // Список может быть уже раскрыт (так снята фикстура) — тогда клик не нужен.
  const options = page.locator(RESUME_OPTION);
  if ((await options.count()) === 0) {
    await cell.click();
    await options.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  }
  const count = await options.count();
  for (let i = 0; i < count; i++) {
    const option = options.nth(i);
    if ((await textOfFirst(option.locator(RESUME_TITLE))) !== title) continue;
    await option.click();
    // Живьём список закрывается и ячейка показывает выбранное; в статичной
    // фикстуре без JS меняется только отметка radio. Годится любое из двух.
    const shown = await textOfFirst(cell.locator(RESUME_TITLE));
    const checked = await option.locator('input[type="radio"]').isChecked().catch(() => false);
    return shown === title || checked ? 'selected' : 'not_found';
  }
  // Закрываем список тем же кликом, что открыл. Не Escape: он может закрыть
  // всё окно отклика вместе со списком.
  if (await options.first().isVisible().catch(() => false)) await cell.click().catch(() => {});
  return 'not_found';
}

/**
 * Сколько раз пробуем раскрыть поле письма и сколько ждём его после каждого клика.
 * Снято живьём 2026-10-09 при заблокированной записи (форма вакансии 133032777, и тот же
 * сбой был на настоящем отклике 138262755): форма видна, но первый клик по
 * переключателю она глотает, поле не появляется, а второй клик срабатывает сразу.
 * Одна попытка с ожиданием 5 секунд сдавалась, письмо шло запасным путём в чат, и
 * отклик значился «No cover letter».
 */
const LETTER_OPEN_ATTEMPTS = 3;
const LETTER_OPEN_WAIT_MS = 2500;

/**
 * Кладёт письмо в поле формы. false — поля так и не появилось, письмо уйдёт запасным
 * путём. Не бросает: форма, у которой переключатель письма перерисовывается без конца
 * (снято живьём 2026-10-09: «element was detached from the DOM», клик висел 30 секунд),
 * не должна ронять всю заявку из-за второстепенного поля.
 */
export async function fillModalLetter(
  page: Page,
  letter: string,
  timing: { attempts: number; waitMs: number } = { attempts: LETTER_OPEN_ATTEMPTS, waitMs: LETTER_OPEN_WAIT_MS },
): Promise<boolean> {
  const input = page.locator(LETTER_INPUT).first();
  for (let attempt = 0; attempt < timing.attempts; attempt++) {
    // Поле могло открыться само (медленная отрисовка после прошлого клика): второй
    // клик по переключателю тогда мог бы его скрыть.
    if (await input.isVisible().catch(() => false)) break;
    const toggle = page.locator(LETTER_TOGGLE).first();
    if ((await toggle.count()) === 0) {
      // Переключателя нет вовсе. На первой попытке это «письма в этой форме нет»;
      // позже — переключатель сменился полем, дадим ему показаться.
      if (attempt === 0) return false;
      await input.waitFor({ state: 'visible', timeout: timing.waitMs }).catch(() => {});
      break;
    }
    // Клик ограничен тем же временем, что и ожидание поля: стандартные 30 секунд на
    // «стабильный» элемент здесь не нужны, неудавшийся клик — просто неудавшаяся попытка.
    await toggle.click({ timeout: timing.waitMs }).catch(() => {});
    if (await input.waitFor({ state: 'visible', timeout: timing.waitMs }).then(() => true, () => false)) break;
  }
  if (!(await input.isVisible().catch(() => false))) return false;
  await input.fill(letter);
  return (await input.inputValue().catch(() => '')) === letter;
}

/** Вопросы анкеты работодателя. Пустой массив — анкеты нет. */
export async function readTestQuestions(page: Page): Promise<TestQuestion[]> {
  const blocks = page.locator(TASK_BODY);
  const out: TestQuestion[] = [];
  const count = await blocks.count();
  for (let i = 0; i < count; i++) {
    const block = blocks.nth(i);
    const text = await textOfFirst(block.locator(TASK_QUESTION));
    const choice = block.locator('input[type="radio"], input[type="checkbox"]');
    const options: QuestionOption[] = [];
    let name = '';
    let kind: TestQuestion['kind'] = 'text';
    const n = await choice.count();
    for (let j = 0; j < n; j++) {
      const input = choice.nth(j);
      name = (await input.getAttribute('name')) ?? name;
      kind = (await input.getAttribute('type')) === 'checkbox' ? 'multi' : 'single';
      const label = await textOfFirst(input.locator('xpath=ancestor::label[1]'));
      options.push({ value: (await input.getAttribute('value')) ?? '', label });
    }
    const textarea = block.locator('textarea[name^="task_"]');
    const textName = (await textarea.count()) > 0 ? await textarea.first().getAttribute('name') : null;
    if (kind === 'text') {
      if (textName === null) continue; // блок без полей — нечего заполнять
      name = textName;
    }
    out.push({ name, text, kind, options, textName });
  }
  return out;
}

/** Переносит ответы в форму. Бросает, если поле не нашлось: полузаполненную анкету не отправляем. */
export async function fillTestAnswers(page: Page, questions: TestQuestion[], answers: TestAnswer[]): Promise<void> {
  const form = page.locator(RESPONSE_FORM);
  for (const q of questions) {
    const a = answers.find((x) => x.name === q.name);
    if (a === undefined) throw new Error(`нет ответа на вопрос «${q.text}»`);
    for (const value of a.values) {
      const input = form.locator(`input[name="${q.name}"][value="${value}"]`).first();
      // Уже отмеченный checkbox повторный клик бы снял.
      if (await input.isChecked()) continue;
      // Сам input у hh.ru визуально спрятан под кастомным кружком — кликаем по label.
      await input.locator('xpath=ancestor::label[1]').click();
      if (!(await input.isChecked())) await input.check({ force: true });
    }
    if (a.text !== '' && q.textName !== null) {
      const area = form.locator(`textarea[name="${q.textName}"]`).first();
      await area.waitFor({ state: 'visible', timeout: 5000 });
      await area.fill(a.text);
    }
  }
}

/** Сколько карточек просить на одной странице. hh.ru принимает 100. */
const ITEMS_PER_PAGE = 100;

/**
 * `page` считается с нуля — так пронумерованы ссылки пагинации в снятой
 * фикстуре (`?page=0`, `?page=1`, ...). `items_on_page` там же встречается
 * со значением 100; берём максимум, чтобы вдвое сократить число загрузок
 * страниц выдачи при большом --limit.
 */
export function buildSearchUrl(query: string, page = 0): string {
  const params = new URLSearchParams({
    text: query,
    area: '1',
    page: String(page),
    items_on_page: String(ITEMS_PER_PAGE),
  });
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
  experience: ExperienceLevel | null;
}

const KNOWN_EXPERIENCE_LEVELS: ReadonlySet<string> = new Set([
  'noExperience', 'between1And3', 'between3And6', 'moreThan6',
]);

/** Суффикс data-qa → ExperienceLevel, или null если суффикс не входит в известный словарь hh.ru. */
function parseExperienceSuffix(dataQa: string | null): ExperienceLevel | null {
  if (dataQa === null || !dataQa.startsWith(SEARCH_EXPERIENCE_PREFIX)) return null;
  const suffix = dataQa.slice(SEARCH_EXPERIENCE_PREFIX.length);
  return KNOWN_EXPERIENCE_LEVELS.has(suffix) ? (suffix as ExperienceLevel) : null;
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

    const experienceLocator = card.locator(SEARCH_EXPERIENCE);
    let experience: ExperienceLevel | null = null;
    if ((await experienceLocator.count()) > 0) {
      const dataQa = await experienceLocator.first().getAttribute('data-qa').catch(() => null);
      experience = parseExperienceSuffix(dataQa);
    }

    out.push({
      sourceId: id,
      title,
      company,
      geo,
      url: canonicalVacancyUrl(id),
      salaryFrom: salary.from,
      salaryTo: salary.to,
      experience,
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
 * Капча hh.ru. Снята живьём 2026-10-02 (вакансия 137237197, анкета заполнена,
 * жмётся «Send application»): поверх формы встаёт окно «Complete the CAPTCHA —
 * enter the text from the picture» с картинкой, полем и кнопкой. Точной разметки
 * (data-qa) у окна не сняли, поэтому признаков три, и любого достаточно:
 * видимая картинка/блок с «captcha» в разметке либо видимая фраза окна.
 * Спрятанная разметка не считается: на обычных страницах она лежит скрытой.
 *
 * Капчу система НЕ решает и не обходит никогда. Узнав её, адаптер возвращает
 * `captcha`: площадка останавливается, заявка остаётся approved, вкладка с
 * окном остаётся открытой, чтобы человек решил её руками.
 */
const CAPTCHA_MARKUP = 'img[src*="captcha" i], [data-qa*="captcha" i], [class*="captcha" i]';
const CAPTCHA_PHRASE = /complete the captcha|enter the text from the picture|введите текст с картинки|подтвердите,? что вы не робот/i;

async function anyVisible(loc: Locator, limit = 5): Promise<boolean> {
  const n = Math.min(await loc.count(), limit);
  for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible()) return true;
  return false;
}

export async function detectCaptcha(page: Page): Promise<boolean> {
  try {
    return (await anyVisible(page.locator(CAPTCHA_MARKUP))) || (await anyVisible(page.getByText(CAPTCHA_PHRASE)));
  } catch {
    return false; // страница в переходе или закрылась — это не капча
  }
}

/**
 * Ждёт, пока человек решит капчу в открытом окне браузера.
 *
 * Капчу программа НЕ решает и не отправляет на сторонние сервисы распознавания:
 * это обход защиты hh.ru от роботов, за который аккаунт банят надёжнее, чем за
 * саму капчу. Вместо этого прогон встаёт на паузу, пищит в терминал и ждёт.
 *
 * true — капчи больше нет (дважды подряд не видна: сразу после ввода страница
 * перезагружается, и одиночное «не видно» может оказаться переходом).
 * false — время вышло, вкладку закрыли или нажат стоп.
 */
export async function waitCaptchaSolved(
  page: Page,
  timeoutMs: number,
  shouldStop: () => boolean = () => false,
  pollMs = 2_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let clearChecks = 0;
  while (Date.now() < deadline) {
    if (shouldStop() || page.isClosed()) return false;
    await page.waitForTimeout(pollMs).catch(() => {});
    if (page.isClosed()) return false;
    clearChecks = (await detectCaptcha(page)) ? 0 : clearChecks + 1;
    if (clearChecks >= 2) return true;
  }
  return false;
}

/** Картинка капчи и поле ответа (окно «Complete the CAPTCHA», см. CAPTCHA_PHRASE). */
const CAPTCHA_IMAGE = 'img[src*="captcha" i]';
const CAPTCHA_ANSWER_INPUT = 'input:not([type]), input[type="text"], input[type="tel"], input[type="search"]';
/**
 * Кнопка ответа — только по надписи. Любая кнопка подряд опасна: окно капчи
 * встаёт поверх формы отклика, и «первой кнопкой» могла бы оказаться
 * «Откликнуться». Не нашлась — Enter в поле ответа.
 */
const CAPTCHA_SUBMIT_TEXT = /^\s*(отправить|продолжить|подтвердить|готово|ок|ok|submit|send|continue|confirm|verify)\s*$/i;

async function firstVisible(loc: Locator, limit = 5): Promise<Locator | null> {
  const n = Math.min(await loc.count().catch(() => 0), limit);
  for (let i = 0; i < n; i++) {
    if (await loc.nth(i).isVisible().catch(() => false)) return loc.nth(i);
  }
  return null;
}

/**
 * Первая видимая кнопка с подходящей надписью. У <input type="submit">
 * надпись в value, а не в тексте, поэтому сверяем сами, а не hasText.
 */
async function firstVisibleLabelled(loc: Locator, label: RegExp, limit = 10): Promise<Locator | null> {
  const n = Math.min(await loc.count().catch(() => 0), limit);
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const text = await el.evaluate((e) => (e instanceof HTMLInputElement ? e.value : e.textContent ?? '')).catch(() => '');
    if (label.test(text)) return el;
  }
  return null;
}

export interface AutoSolveResult {
  solved: boolean;
  attempts: number;
  reason?: string;
}

/**
 * Решает капчу-картинку на странице через сервис распознавания: снимок
 * картинки → ответ сервиса → поле ответа → «Отправить» → проверка, что окно
 * пропало. Неверный ответ — жалоба сервису (деньги вернут) и новая попытка с
 * новой картинкой.
 *
 * Снимок делается с самого элемента, а не повторной загрузкой src: повторный
 * запрос выдал бы НОВУЮ капчу, и ответ не подошёл бы к показанной.
 *
 * Ошибка сервиса (нет денег, неверный ключ) обрывает попытки сразу: от
 * повтора она не пройдёт.
 */
export async function solveCaptchaAuto(
  page: Page,
  solver: CaptchaSolver,
  opts: { attempts?: number; settleMs?: number; pollMs?: number } = {},
): Promise<AutoSolveResult> {
  const attempts = opts.attempts ?? 3;
  const settleMs = opts.settleMs ?? 10_000;
  const pollMs = opts.pollMs ?? 1_000;
  let lastReason = 'капча не ушла';
  for (let i = 1; i <= attempts; i++) {
    if (page.isClosed()) return { solved: false, attempts: i - 1, reason: 'вкладку закрыли' };
    if (!(await detectCaptcha(page))) return { solved: true, attempts: i - 1 };

    // Адрес картинки обычно содержит «captcha»; нет — картинка внутри окна
    // с фразой капчи.
    const img = await firstVisible(page.locator(CAPTCHA_IMAGE))
      ?? await firstVisible(page.locator('[role="dialog"]').filter({ hasText: CAPTCHA_PHRASE }).locator('img'));
    if (img === null) {
      return { solved: false, attempts: i - 1, reason: 'капча не картинкой с текстом — такой тип автоматически не решается' };
    }
    // Картинка могла ещё не догрузиться — снимок пустого места сервис не решит.
    await img.evaluate((el) => new Promise<void>((resolve) => {
      const im = el as HTMLImageElement;
      if (im.complete && im.naturalWidth > 0) { resolve(); return; }
      im.addEventListener('load', () => resolve(), { once: true });
      setTimeout(resolve, 5_000);
    })).catch(() => {});

    // Поле ответа и кнопка — в ближайшем общем предке картинки (окно или форма).
    const box = img.locator('xpath=ancestor::*[.//input][1]');
    const input = await firstVisible(box.locator(CAPTCHA_ANSWER_INPUT));
    if (input === null) return { solved: false, attempts: i - 1, reason: 'не нашлось поле для ответа на капчу' };

    let png: Buffer;
    try {
      png = await img.screenshot({ type: 'png' });
    } catch (err) {
      return { solved: false, attempts: i - 1, reason: `не снять картинку капчи: ${err instanceof Error ? err.message : String(err)}` };
    }

    let solution: CaptchaSolution;
    try {
      solution = await solver.solveImage(png);
    } catch (err) {
      return { solved: false, attempts: i, reason: err instanceof Error ? err.message : String(err) };
    }

    await input.fill(solution.text).catch(() => {});
    const submit = await firstVisibleLabelled(box.locator('button, [role="button"], input[type="submit"]'), CAPTCHA_SUBMIT_TEXT);
    if (submit !== null) await submit.click().catch(() => {});
    else await input.press('Enter').catch(() => {});

    if (await waitCaptchaSolved(page, settleMs, () => false, pollMs)) return { solved: true, attempts: i };
    await solution.reportIncorrect();
    lastReason = `ответ «${solution.text}» не подошёл`;
  }
  return { solved: false, attempts, reason: `${lastReason} (${attempts} попыток)` };
}

/** Громко зовёт человека решить капчу: сообщение и звуковой сигнал терминала. */
function callHumanForCaptcha(where: string, waitMs: number): void {
  const minutes = Math.max(1, Math.round(waitMs / 60_000));
  process.stderr.write('\x07');
  console.error(
    `[hh] КАПЧА (${where}). Реши её в открытом окне браузера — жду до ${minutes} мин, потом продолжу сам.`,
  );
}

/**
 * Чем кончилась отправка формы: маркер успеха, капча или тишина до таймаута.
 * Капчу видно сразу, и ждать из-за неё полный таймаут подтверждения (15 с на
 * каждую заявку) незачем.
 */
export async function waitSubmitOutcome(page: Page, timeoutMs: number): Promise<'success' | 'captcha' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await page.locator(SUCCESS_MARKER).first().isVisible().catch(() => false)) return 'success';
    if (await detectCaptcha(page)) return 'captcha';
    if (Date.now() >= deadline) return 'timeout';
    await page.waitForTimeout(300).catch(() => {});
  }
}

/**
 * Уже откликались на эту вакансию?
 *
 * Селекторы сняты живьём (см. RESPONSE_LINK_VIEW_TOPIC выше). Достаточно
 * любого из двух: hh.ru показывает «Перейти к отклику» и «Откликнуться ещё
 * раз» вместо обычной кнопки.
 *
 * Важно, что сигнал существует НЕ ради дедупа — от повторной подачи из
 * очереди защищает уникальный индекс в БД. Он нужен для откликов, поданных
 * МИМО системы: руками с сайта, с телефона, из другого браузера. Про них база
 * не знает ничего, и без этой проверки каждый такой отклик превращался в
 * отказ, а три отказа подряд гасили площадку целиком.
 */
export async function detectAlreadyApplied(page: Page): Promise<boolean> {
  for (const selector of [RESPONSE_LINK_VIEW_TOPIC, RESPONSE_LINK_AGAIN]) {
    // Не waitFor: страница уже загружена, и ждать несуществующий элемент
    // означало бы платить таймаутом на каждой обычной вакансии.
    if (await page.locator(selector).count() > 0) return true;
  }
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
  /**
   * Как открыть контекст заново — при первом обращении и каждый раз, когда
   * предыдущий закрылся сам. По умолчанию — настоящий залогиненный профиль
   * (sharedProfile — общий на процесс, см. src/browser.ts: два адаптера
   * не могут открыть один каталог профиля порознь). Тесты подменяют её на одноразовый offline-контекст, чтобы
   * не трогать реальный browser-profile/ пользователя.
   */
  openContext?: () => Promise<BrowserContext>;
  /**
   * Кто отвечает на анкету работодателя. Без него вакансия с анкетой
   * получает честный отказ «ответь вручную», анкета не отправляется.
   * В бою — модель через OpenRouter (см. buildAdapters в src/cli.ts).
   */
  answerTest?: (questions: TestQuestion[], vacancy: Vacancy) => Promise<{ answers: TestAnswer[] | null; failure?: string }>;
  /**
   * Куда класть снимки экрана неподтверждённых откликов. По умолчанию
   * data/hh-debug (data/ в git не попадает).
   */
  debugDir?: string;
  /**
   * Темп поиска и ожидание капчи (core/pacing.ts). По умолчанию — боевые паузы,
   * а при подменённом контексте (context/openContext: тесты, офлайн-фикстуры) —
   * без пауз и без ожидания капчи, как было до 2026-11-19.
   */
  pacing?: SearchPacing;
  random?: () => number;
  /** Нажат ли стоп отправки. По умолчанию — флаг data/STOP (core/sender.ts). */
  stopRequested?: () => boolean;
  /**
   * Чем решать капчу автоматически (core/captcha-solver.ts). Зовётся в момент
   * капчи, чтобы ключ, вписанный в панели, действовал без перезапуска. null —
   * автоматики нет, ждём человека.
   */
  captchaSolver?: () => CaptchaSolver | null;
}

const DEFAULT_DEBUG_DIR = 'data/hh-debug';

/**
 * Что hh.ru показывает на странице в момент, когда отклик не подтвердился.
 *
 * Зовётся ДО повторной загрузки вакансии: после неё сообщение hh (лимит
 * откликов, капча, требование письма) пропадает, и в отказе остаётся одно
 * «клик не привёл к подтверждению» — по нему нельзя понять, почему отправка раз
 * за разом встаёт. Ничего не бросает: диагностика не должна ронять отказ.
 *
 * Возвращает короткую строку для причины отказа: тексты сообщений (alert,
 * блоки с «error» в разметке) либо заголовок страницы, и имя снимка экрана.
 */
export async function describeUnconfirmed(page: Page, vacancyId: string, debugDir: string): Promise<string> {
  const parts: string[] = [];
  try {
    // Строкой, а не функцией: под tsx (npm run panel) esbuild оборачивает
    // вложенные функции в __name(), которого в браузере нет, и вызов молча
    // падал — в причине оставался один снимок. Под vitest этого не видно.
    const seen = await page.evaluate(`(() => {
      const clip = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 140);
      const found = [...document.querySelectorAll('[role="alert"], [data-qa*="error" i], [class*="error" i]')]
        .map((e) => clip(e.textContent)).filter((t) => t !== '');
      return { title: clip(document.title), alerts: [...new Set(found)].slice(0, 3) };
    })()`) as { title: string; alerts: string[] };
    parts.push(seen.alerts.length > 0
      ? `на странице: «${seen.alerts.join(' | ')}»`
      : `страница: «${seen.title || 'без заголовка'}»`);
  } catch { /* страницу не прочитать — причину не называем */ }
  try {
    mkdirSync(debugDir, { recursive: true });
    const name = `${vacancyId}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    await page.screenshot({ path: join(debugDir, name) });
    parts.push(`снимок ${name} в ${debugDir}`);
  } catch { /* снимок не получился — текст всё равно в причине */ }
  return parts.join('; ');
}

/**
 * Статистика последнего search(): сколько карточек реально прочитано (до
 * бюджета maxResults) и сколько из них отсеяно ДО открытия страницы вакансии.
 * НЕ часть контракта Adapter (types.ts осознанно остаётся с двумя методами,
 * см. отчёт задачи) — pipeline.ts читает это поле по утиной типизации, как
 * необязательный бонус-сигнал, а не через интерфейс.
 */
export interface HhSearchStats {
  /** Сырые карточки, прочитанные со страниц выдачи — то, что реально стоило времени/бюджета. */
  read: number;
  /** Из read: отсеяно по опыту (вне допустимого диапазона) до открытия страницы вакансии. */
  rejectedExperience: number;
  /** Из read: отсеяно по грейду заголовка до открытия страницы вакансии. */
  rejectedGrade: number;
  /** Из read: заголовок без «Слов заголовка» специальности — страница не открывалась. */
  rejectedTitle: number;
  /** Из read: пропущено, потому что id уже встречался в этом прогоне под другой формулировкой (см. SearchFilters.seenThisRun). */
  duplicatesSkipped: number;
  /**
   * Страница вакансии открылась без описания. Раньше такая вакансия уходила
   * дальше с пустым текстом и молча отсеивалась как «ниже порога» — хотя
   * дело не в ней, а в капче или недогруженной странице.
   */
  noDescription: number;
  /** Поиск по hh.ru прерван капчей, которую не решили за отведённое время. */
  captchaStopped: boolean;
}

export class HhAdapter implements Adapter {
  readonly name = 'hh';
  private context: BrowserContext | undefined;
  private contextClosed = false;
  private readonly timeouts: Timeouts;
  private readonly openContextFn: () => Promise<BrowserContext>;
  private readonly answerTest: HhAdapterOptions['answerTest'];
  private readonly debugDir: string;
  private readonly pacing: SearchPacing;
  private readonly random: () => number;
  private readonly stopRequested: () => boolean;
  private readonly captchaSolver: () => CaptchaSolver | null;
  /** См. HhSearchStats. undefined до первого успешного search(). */
  lastSearchStats: HhSearchStats | undefined;

  constructor(opts: HhAdapterOptions = {}) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
    this.openContextFn = opts.openContext ?? sharedProfile;
    this.answerTest = opts.answerTest;
    this.debugDir = opts.debugDir ?? DEFAULT_DEBUG_DIR;
    const injected = opts.context !== undefined || opts.openContext !== undefined;
    this.pacing = opts.pacing ?? (injected ? NO_PACING : DEFAULT_SEARCH_PACING);
    this.random = opts.random ?? Math.random;
    this.stopRequested = opts.stopRequested ?? isStopRequested;
    this.captchaSolver = opts.captchaSolver ?? (() => null);
    if (opts.context) this.setContext(opts.context);
  }

  private setContext(context: BrowserContext): void {
    this.context = context;
    this.contextClosed = false;
    // Пользователь, закрывший окно Chromium руками, — обычное дело, а не
    // ошибка (см. отчёт задачи). BrowserContext эмитит 'close' и когда его
    // закрыли явно, и когда браузер персистентного профиля закрыли извне —
    // оба случая должны привести к переоткрытию на следующем getContext(),
    // а не к падению с "Target page, context or browser has been closed".
    context.once('close', () => { this.contextClosed = true; });
  }

  private async getContext(): Promise<BrowserContext> {
    if (!this.context || this.contextClosed) {
      this.setContext(await this.openContextFn());
    }
    return this.context!;
  }

  /**
   * Отпускает браузер, если он был открыт. Безопасно звать повторно и
   * безопасно звать без единого предыдущего search()/apply() — не бросает
   * ни в том, ни в другом случае.
   */
  async close(): Promise<void> {
    if (this.context && !this.contextClosed) {
      await this.context.close().catch(() => {});
    }
    this.context = undefined;
    this.contextClosed = false;
  }

  async search(filters: SearchFilters): Promise<Vacancy[]> {
    const context = await this.getContext();
    const page = await context.newPage();
    let keepPageOpen = false;
    try {
      // Листаем страницы выдачи, пока не наберём нужное число карточек.
      // Одна страница отдаёт максимум ITEMS_PER_PAGE, поэтому --limit больше
      // сотни без пагинации молча упирался бы в потолок первой страницы.
      const budget = filters.maxResults ?? ITEMS_PER_PAGE;
      // Смещение по выдаче (см. SearchFilters.skip): конвейер ходит сюда
      // порциями и просит следующий срез, пока не наберёт нужное число
      // подходящих вакансий. Листаем с нулевой страницы даже при ненулевом
      // skip и отбрасываем начало уже собранного списка, а не прыгаем сразу
      // на страницу skip/ITEMS_PER_PAGE: дедупликация ниже сдвигает позиции,
      // и вычисленный номер страницы разошёлся бы с реальным смещением. Цена
      // — одна-две лишние навигации по СТРАНИЦАМ ВЫДАЧИ за порцию; дорогое
      // здесь другое, открытие страницы каждой вакансии, и оно как раз
      // делается только для нового среза.
      const skip = filters.skip ?? 0;
      const collected: HhSearchItem[] = [];
      const seenIds = new Set<string>();
      const signal = filters.signal;
      let captchaStopped = false;
      let noDescription = 0;
      // Капча посреди поиска: ждём человека; не дождались — сдаёмся, отдавая
      // уже прочитанное (см. handleSearchCaptcha).
      const ensureNoCaptcha = async (url: string, where: string): Promise<boolean> => {
        if (!(await detectCaptcha(page))) return true;
        if (await this.handleSearchCaptcha(page, url, where, signal)) return true;
        captchaStopped = true;
        keepPageOpen = !signal?.aborted;
        return false;
      };
      // Ждём либо карточки выдачи, либо капчу — что раньше. Одни карточки
      // заставили бы сидеть весь таймаут навигации на каждой капче.
      const waitSearchPage = (): Promise<void> => page.locator(SEARCH_TITLE_LINK).first()
        .or(page.locator(CAPTCHA_MARKUP).first())
        .waitFor({ state: 'attached', timeout: this.timeouts.navigationMs })
        .catch(() => {});

      for (let pageNo = 0; collected.length < skip + budget; pageNo++) {
        if (signal?.aborted) break;
        // Пауза между страницами выдачи: подряд без пауз — главный повод для
        // капчи (core/pacing.ts).
        if (pageNo > 0) await this.pause(this.pacing.pageDelayMs, signal);
        if (signal?.aborted) break;
        const url = buildSearchUrl(filters.query, pageNo);
        // waitUntil:'load'/'networkidle' никогда не наступают на hh.ru —
        // страница держит фоновые запросы (реклама, опросы, аналитика)
        // неопределённо долго (см. scripts/capture-hh.ts). Ждём
        // domcontentloaded, а затем — конкретный элемент, который нужен.
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeouts.navigationMs });
        await waitSearchPage();
        if (!(await ensureNoCaptcha(url, `страница выдачи ${pageNo + 1}`))) break;
        await waitSearchPage();

        const pageItems = await parseSearchPage(page);
        if (pageItems.length === 0) break;

        // Своя дедупликация по ходу листания: за пределом последней страницы
        // hh.ru отдаёт не пустоту, а повтор предыдущей — без этой проверки
        // цикл крутился бы до исчерпания бюджета на одних и тех же карточках.
        let fresh = 0;
        for (const it of pageItems) {
          if (seenIds.has(it.sourceId)) continue;
          seenIds.add(it.sourceId);
          collected.push(it);
          fresh++;
          if (collected.length >= skip + budget) break;
        }
        if (fresh === 0) break;
      }

      // Отсев ДО дочитывания описаний. Грейд виден в заголовке карточки, а
      // требуемый опыт — в её структурном маркере: обе проверки не требуют
      // открывать страницу вакансии. При --limit 500 это разница между
      // пятьюстами загрузок и примерно полутора сотнями, то есть между
      // часом ожидания и несколькими минутами.
      //
      // Фильтр 1С и core-гейт здесь применить нельзя — им нужен текст
      // описания, которого у карточки нет. Их отрабатывает конвейер.
      //
      // Порядок проверок (опыт → грейд) совпадает с core/screening.ts —
      // одна и та же причина должна называться одинаково независимо от
      // того, отсеяла её карточка здесь или screenVacancy в pipeline после
      // дочитки описания.
      //
      // Считаем rejectedExperience/rejectedGrade явно (не одним filter()),
      // потому что pipeline.ts складывает эти числа в SearchReport —
      // без этого поля "отсеяно фильтрами" в панели показывало бы 0 для
      // hh.ru: карточки, отсеянные здесь, никогда не доходят до screenVacancy.
      // seenThisRun (см. SearchFilters) — третья причина пропуска, отдельная
      // от двух выше: карточка сама по себе годная, но её уже читали под
      // другой формулировкой этого же прогона, и открывать страницу вакансии
      // повторно ради заведомого дубля незачем.
      let rejectedExperience = 0;
      let rejectedGrade = 0;
      let duplicatesSkipped = 0;
      const wanted: HhSearchItem[] = [];
      // Окно этого захода. Всё, что раньше skip, уже прочитано и посчитано
      // предыдущей порцией — второй раз в статистику не попадает.
      const window = collected.slice(skip);
      const years = filters.experienceYears ?? DEFAULT_EXPERIENCE_YEARS;
      const titleWords = filters.titleWords ?? [];
      let rejectedTitle = 0;
      for (const it of window) {
        if (!isExperienceWithin(it.experience ?? null, years)) { rejectedExperience++; continue; }
        if (isSeniorTitle(it.title) || (years < 1 && isAboveJuniorTitle(it.title))) {
          rejectedGrade++;
          continue;
        }
        // Тот же гейт заголовка, что в core/screening.ts, но до открытия
        // страницы: hh.ru ищет фразу по всему тексту и отдаёт «Маркетологов».
        if (titleWords.length > 0 && !hasTitleWord(it.title, titleWords)) { rejectedTitle++; continue; }
        if (filters.seenThisRun?.has(`${this.name}:${it.sourceId}`)) { duplicatesSkipped++; continue; }
        wanted.push(it);
      }

      const out: Vacancy[] = [];
      let opened = 0;
      for (const item of wanted) {
        // «Остановить поиск»: отдаём прочитанное и выходим, а не дочитываем
        // порцию — каждая вакансия здесь это навигация по сайту.
        if (signal?.aborted || captchaStopped) break;
        // Человеческий темп: пауза перед каждой вакансией (после страницы
        // выдачи — тоже) и длинный перекур раз в breakEvery вакансий.
        const { breakEvery } = this.pacing;
        if (breakEvery > 0 && opened > 0 && opened % breakEvery === 0) {
          const ms = pickDelay(this.pacing.breakMs, this.random);
          if (ms > 0) console.error(`[hh] прочитано ${opened} вакансий — пауза ${Math.round(ms / 1000)} с, чтобы не словить капчу`);
          await sleepUnlessAborted(ms, signal);
        } else {
          await this.pause(this.pacing.vacancyDelayMs, signal);
        }
        if (signal?.aborted) break;
        opened++;
        // Скорер считает по title+description — карточка выдачи описания
        // не несёт, поэтому дочитка страницы вакансии не опциональна: без
        // неё вакансия почти всегда наберёт околонулевой балл и отсеется.
        await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: this.timeouts.navigationMs });
        if (!(await ensureNoCaptcha(item.url, `вакансия ${item.sourceId}`))) break;
        let description = await readVacancyDescription(page, this.timeouts.descriptionMs);
        if (description === '') {
          // Капча могла встать уже после domcontentloaded.
          if (!(await ensureNoCaptcha(item.url, `вакансия ${item.sourceId}`))) break;
          description = await readVacancyDescription(page, this.timeouts.descriptionMs);
        }
        if (description === '') {
          // Без описания скорер дал бы околонулевой балл, и годная вакансия
          // молча ушла бы в «ниже порога». Не отдаём её конвейеру вовсе: в
          // БД она не попадёт и найдётся следующим поиском.
          noDescription++;
          console.error(`[hh] вакансия ${item.sourceId}: описание не прочиталось — пропущена, попадётся в следующий поиск (${item.url})`);
          continue;
        }
        // Структурный маркер с карточки выдачи — основной источник. Он есть
        // на всех 50 карточках снятой фикстуры, но если разметка когда-нибудь
        // изменится и маркер пропадёт, не роняем гейт опыта молча — пробуем
        // разобрать текст уже прочитанного описания вакансии тем же парсером,
        // что использует hr.ge (см. core/screening.ts). Отдельный запрос под
        // прозу [data-qa="vacancy-experience"] не делаем: на снятой фикстуре
        // она рендерится по-английски ("not required"), а разбирается только
        // русский текст — доп. чтение того же элемента не дало бы сигнала,
        // который не даёт уже читаемое description.
        const experience = item.experience ?? parseExperienceFromText(description);
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
          experience,
        }));
      }
      this.lastSearchStats = {
        read: window.length, rejectedExperience, rejectedGrade, rejectedTitle, duplicatesSkipped, noDescription, captchaStopped,
      };
      return out;
    } finally {
      // Вкладку с нерешённой капчей не закрываем: человек может решить её и
      // позже, а закрытая вкладка унесла бы окно капчи.
      if (!keepPageOpen) await page.close();
    }
  }

  /**
   * Капча посреди отклика: зовём человека и ждём (pacing.captchaWaitMs).
   * true — решена, можно продолжать с того же места. Стоп отправки прерывает
   * ожидание сразу.
   */
  private async awaitHumanCaptcha(page: Page, where: string): Promise<boolean> {
    const solved = await this.passCaptcha(page, where, this.stopRequested);
    if (solved) console.error('[hh] Капча пройдена — продолжаю отклик.');
    return solved;
  }

  /**
   * Пройти капчу: сначала автоматически (сервис распознавания, если ключ
   * задан), не вышло — ждать человека в окне браузера (pacing.captchaWaitMs).
   */
  private async passCaptcha(page: Page, where: string, shouldStop: () => boolean): Promise<boolean> {
    if (await this.tryAutoSolve(page, where)) return true;
    const waitMs = this.pacing.captchaWaitMs;
    if (waitMs <= 0 || shouldStop()) return false;
    callHumanForCaptcha(where, waitMs);
    return waitCaptchaSolved(page, waitMs, shouldStop);
  }

  private async tryAutoSolve(page: Page, where: string): Promise<boolean> {
    let solver: CaptchaSolver | null = null;
    try {
      solver = this.captchaSolver();
    } catch (err) {
      console.error(`[hh] решатель капчи не собрался: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (solver === null) return false;
    console.error(`[hh] КАПЧА (${where}) — решаю автоматически через сервис распознавания…`);
    const r = await solveCaptchaAuto(page, solver);
    if (r.solved) {
      console.error(`[hh] Капча решена автоматически (попыток: ${r.attempts}).`);
      return true;
    }
    console.error(`[hh] Автоматически капча не решилась: ${r.reason}`);
    // HTML окна — чтобы поддержать незнакомый тип капчи по настоящей разметке.
    try {
      mkdirSync(this.debugDir, { recursive: true });
      const name = `captcha-${new Date().toISOString().replace(/[:.]/g, '-')}.html`;
      writeFileSync(join(this.debugDir, name), await page.content(), 'utf8');
      console.error(`[hh] разметка капчи сохранена: ${join(this.debugDir, name)}`);
    } catch { /* диагностика не должна мешать */ }
    return false;
  }

  private async pause(range: MsRange, signal?: AbortSignal): Promise<void> {
    await sleepUnlessAborted(pickDelay(range, this.random), signal);
  }

  /**
   * Страница показала капчу во время поиска. Поиск только читает, поэтому
   * после решения страницу безопасно открыть заново. true — можно читать дальше.
   */
  private async handleSearchCaptcha(page: Page, url: string, where: string, signal?: AbortSignal): Promise<boolean> {
    const stop = (): boolean => signal?.aborted === true;
    // Капча может встать снова сразу после решённой — даём ещё один круг,
    // дальше считаем, что сайт всерьёз насторожился, и останавливаемся.
    for (let round = 1; round <= 2; round++) {
      if (!(await this.passCaptcha(page, round === 1 ? where : `${where}, повторно`, stop))) {
        console.error('[hh] Капча не пройдена — поиск по hh.ru остановлен, найденное до неё сохранено.');
        return false;
      }
      const ms = pickDelay(this.pacing.afterCaptchaMs, this.random);
      console.error(`[hh] Капча пройдена. Пауза ${Math.round(ms / 1000)} с и продолжаю.`);
      await sleepUnlessAborted(ms, signal);
      if (stop()) return false;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeouts.navigationMs });
      if (!(await detectCaptcha(page))) return true;
    }
    console.error('[hh] Капча появляется снова и снова — поиск по hh.ru остановлен.');
    return false;
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

  /**
   * Заполняет и отправляет форму отклика. До клика по MODAL_SUBMIT с машины
   * не уходит ничего, поэтому любой `rejected` здесь — отказ БЕЗ подачи.
   */
  private async submitResponseForm(
    page: Page,
    vacancy: Vacancy,
    letter: string,
  ): Promise<
    | { status: 'sent' | 'unconfirmed'; letterInForm: boolean; detail?: string }
    | { status: 'captcha' }
    | { status: 'rejected'; reason: string }
  > {
    const questions = await readTestQuestions(page);
    let answers: TestAnswer[] | null = null;
    if (questions.length > 0) {
      if (this.answerTest === undefined) {
        return { status: 'rejected', reason: `у вакансии анкета работодателя, отвечать на неё некому — подай вручную: ${vacancy.url}` };
      }
      const r = await this.answerTest(questions, vacancy);
      if (r.answers === null) {
        return {
          status: 'rejected',
          reason: `анкета работодателя: модель не ответила (${r.failure ?? 'без причины'}) — подай вручную: ${vacancy.url}`,
        };
      }
      answers = r.answers;
    }

    // Резюме не выбираем: отклик уходит с тем, что hh.ru подставил в форму
    // (основное резюме аккаунта). selectResume оставлен для тех, кому нужно
    // выбирать резюме под вакансию.

    if (answers !== null) {
      try {
        await fillTestAnswers(page, questions, answers);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { status: 'rejected', reason: `анкета работодателя: не удалось заполнить форму (${message.slice(0, 160)})` };
      }
    }

    const letterInForm = letter.trim() !== '' && (await fillModalLetter(page, letter));

    const submit = page.locator(MODAL_SUBMIT).first();
    if (!(await submit.isVisible().catch(() => false))) {
      return { status: 'rejected', reason: `окно отклика закрылось до отправки (вакансия ${vacancy.sourceId})` };
    }
    await submit.click();

    let outcome = await waitSubmitOutcome(page, this.timeouts.submitMs);
    // Капча — не отказ: страницу не трогаем, пока человек её не решит. Решил —
    // ждём исхода заново; повторно форму не отправляем (задвоение отклика).
    if (outcome === 'captcha') {
      if (!(await this.awaitHumanCaptcha(page, 'после отправки формы'))) return { status: 'captcha' };
      outcome = await waitSubmitOutcome(page, this.timeouts.submitMs);
      if (outcome === 'captcha') return { status: 'captcha' };
    }
    let ok = outcome === 'success';
    let detail: string | undefined;
    if (!ok) {
      // Сначала смотрим, что сказал hh, и только потом уходим со страницы.
      detail = await describeUnconfirmed(page, vacancy.sourceId, this.debugDir);
      // Анкета отправляется со страницы /applicant/vacancy_response, и что
      // hh.ru показывает после неё, живьём не снято. Проверяем по факту: у
      // поданного отклика страница вакансии показывает «Перейти к отклику».
      await page.goto(vacancy.url, { waitUntil: 'domcontentloaded', timeout: this.timeouts.navigationMs }).catch(() => {});
      ok = await detectAlreadyApplied(page);
    }
    return { status: ok ? 'sent' : 'unconfirmed', letterInForm, detail: ok ? undefined : detail };
  }

  /** Что появилось после клика по «Откликнуться»: форма/успех, капча или ничего за таймаут. */
  private async waitAfterApplyClick(page: Page): Promise<'ready' | 'captcha' | 'timeout'> {
    const deadline = Date.now() + this.timeouts.submitMs;
    const ready = page.locator(SUCCESS_MARKER).or(page.locator(MODAL_SUBMIT)).first();
    for (;;) {
      if (await ready.isVisible().catch(() => false)) return 'ready';
      if (await detectCaptcha(page)) return 'captcha';
      if (Date.now() >= deadline) return 'timeout';
      await page.waitForTimeout(300).catch(() => {});
    }
  }

  async apply(vacancy: Vacancy, letter: string): Promise<ApplyResult> {
    const context = await this.getContext();
    const page = await context.newPage();
    // Вкладку с капчей закрывать нельзя: её решает человек, а закрытая вкладка
    // уносит и окно капчи, и заполненную анкету.
    let keepOpen = false;
    const stopOnCaptcha = async (where: string): Promise<ApplyResult> => {
      keepOpen = true;
      // HTML окна — для точного селектора вместо угадывания по фразам
      // (docs/hh-selectors.md). Не критично: не получилось — идём дальше.
      try {
        mkdirSync(this.debugDir, { recursive: true });
        writeFileSync(join(this.debugDir, `${vacancy.sourceId}-captcha.html`), await page.content(), 'utf8');
      } catch { /* диагностика не должна мешать остановке */ }
      console.error(
        `[hh] КАПЧА на вакансии ${vacancy.sourceId} (${where}) не решена. Вкладка оставлена открытой: реши капчу `
        + 'руками в окне браузера и запусти отправку снова.',
      );
      return { status: 'captcha' };
    };
    try {
      await page.goto(vacancy.url, { waitUntil: 'domcontentloaded', timeout: this.timeouts.navigationMs });
      // Капча до любых кликов: решили — просто открываем вакансию заново.
      if (await detectCaptcha(page)) {
        if (!(await this.awaitHumanCaptcha(page, 'при открытии вакансии'))) {
          return await stopOnCaptcha('при открытии страницы');
        }
        await page.goto(vacancy.url, { waitUntil: 'domcontentloaded', timeout: this.timeouts.navigationMs });
      }

      // Потерянная сессия — используем уже проверенный isLoggedIn() из
      // browser.ts, а не изобретаем свой сигнал.
      if (!(await isLoggedIn(page))) {
        return classifyApplyOutcome({
          captcha: false, sessionLost: true, alreadyApplied: false, submitted: false,
        });
      }
      if (await detectCaptcha(page)) return await stopOnCaptcha('при открытии страницы');
      if (await detectAlreadyApplied(page)) {
        return classifyApplyOutcome({
          captcha: false, sessionLost: false, alreadyApplied: true, submitted: false,
        });
      }
      // Кнопки нет — кликать некуда. Без этой проверки click() ждал её 30
      // секунд и бросал таймаут (живой случай 2026-09-19, вакансия в архиве).
      if ((await page.locator(APPLY_BUTTON).count()) === 0) {
        if ((await page.locator(ARCHIVED_MARKER).count()) > 0) return { status: 'closed' };
        return classifyApplyOutcome({
          captcha: false, sessionLost: false, alreadyApplied: false, submitted: false,
          reason: `на странице вакансии ${vacancy.sourceId} кнопки отклика нет`,
        });
      }

      // Шаг 1, подача. Кнопка встречается 3 раза (верх/низ/липкая панель) —
      // берём first(). Кликаем ровно один раз и никогда не повторяем: если
      // подача уже прошла, повторный клик рискует задвоить отклик.
      //
      // Дальше два пути. Старый (до сентября 2026): отклик уходит сразу по
      // клику, появляется маркер успеха. Новый: открывается форма отклика —
      // её заполняем и отправляем одним кликом по MODAL_SUBMIT.
      await page.locator(APPLY_BUTTON).first().click();

      // Ждём форму, маркер успеха или капчу — что появится первым. Капча без
      // формы не редкость (живьём 2026-10-02), и сидеть из-за неё весь таймаут
      // на каждой заявке незачем.
      let afterClick = await this.waitAfterApplyClick(page);
      if (afterClick === 'captcha') {
        // Решили — ждём форму или успех заново, кнопку второй раз не жмём.
        if (!(await this.awaitHumanCaptcha(page, 'после клика «Откликнуться»'))) {
          return await stopOnCaptcha('после клика «Откликнуться»');
        }
        afterClick = await this.waitAfterApplyClick(page);
        if (afterClick === 'captcha') return await stopOnCaptcha('после клика «Откликнуться»');
      }

      let letterInForm = false;
      let detail: string | undefined;
      let submitted: boolean;
      if (await page.locator(MODAL_SUBMIT).first().isVisible().catch(() => false)) {
        const form = await this.submitResponseForm(page, vacancy, letter);
        if (form.status === 'captcha') return await stopOnCaptcha('после отправки формы');
        if (form.status === 'rejected') {
          return classifyApplyOutcome({
            captcha: false, sessionLost: false, alreadyApplied: false, submitted: false, reason: form.reason,
          });
        }
        letterInForm = form.letterInForm;
        submitted = form.status === 'sent';
        detail = form.detail;
      } else {
        let outcome = await waitSubmitOutcome(page, this.timeouts.submitMs);
        if (outcome === 'captcha') {
          if (!(await this.awaitHumanCaptcha(page, 'после клика «Откликнуться»'))) {
            return await stopOnCaptcha('после клика «Откликнуться»');
          }
          outcome = await waitSubmitOutcome(page, this.timeouts.submitMs);
          if (outcome === 'captcha') return await stopOnCaptcha('после клика «Откликнуться»');
        }
        submitted = outcome === 'success';
        if (!submitted) detail = await describeUnconfirmed(page, vacancy.sourceId, this.debugDir);
      }

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
          reason: `клик по кнопке отклика не привёл к подтверждению подачи для вакансии ${vacancy.sourceId}`
            + (detail ? ` — ${detail}` : ''),
        });
      }

      // Шаг 2, письмо в чат — только если оно не ушло в самой форме. Отклик
      // уже ушёл — если письмо не отправится, возвращаем всё равно 'sent'
      // (иначе очередь ошибочно сочтёт заявку неподанной и попробует снова —
      // а откликов на hh.ru не отменить) и громко логируем, а не проглатываем
      // ошибку молча.
      // Письма нет вовсе (отправка без письма) — в чат писать нечего: пустое
      // сообщение не отправится, а попытка открыла бы чат ради ничего.
      if (!letterInForm && letter.trim() !== '') try {
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
      if (!keepOpen) await page.close();
    }
  }
}
