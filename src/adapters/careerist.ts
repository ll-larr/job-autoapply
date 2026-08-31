import type { Adapter, ApplyResult, SearchFilters } from './types.js';
import { normalizeVacancy, type Vacancy } from '../core/vacancy.js';
import { parseExperienceFromText } from '../core/screening.js';

/**
 * careerist.ru. Контракт снят живьём, см. docs/careerist-selectors.md — там же
 * причины, почему всё сделано именно так.
 *
 * В отличие от hh.ru браузер не нужен: страницы серверные, и обычного fetch
 * достаточно. Поэтому разбор — чистые функции над строкой HTML, а тесты идут
 * по снятым фикстурам без сети и без Chromium.
 */

const ORIGIN = 'https://careerist.ru';

/** Сколько карточек площадка кладёт на каноническую страницу выдачи. */
export const ITEMS_PER_PAGE = 30;

/**
 * Первый запрос делается сюда ради редиректа: пагинация работает только на
 * каноническом слаге, а `page` на `/search/` теряется (docs/careerist-selectors.md).
 */
export function buildSearchEntryUrl(query: string): string {
  const p = new URLSearchParams({ text: query, category: 'vacancy' });
  return `${ORIGIN}/search/?${p.toString()}`;
}

export function buildPageUrl(canonicalUrl: string, page: number): string {
  const u = new URL(canonicalUrl);
  u.searchParams.set('page', String(page));
  return u.toString();
}

export interface CareeristSearchItem {
  sourceId: string;
  title: string;
  url: string;
  geo: string;
  postedText: string;
}

/** Снимает теги и разворачивает html-сущности. */
export function stripHtml(html: string): string {
  const noTags = html.replace(/<[^>]*>/g, '');
  return decodeEntities(noTags).replace(/\s+/g, ' ').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // Амперсанд разворачивается ПОСЛЕДНИМ: иначе "&amp;lt;" превратился бы в
    // "<" вместо буквального "&lt;" — двойной декод, на котором ловится
    // половина самописных парсеров.
    .replace(/&amp;/g, '&');
}

/**
 * Разбирает страницу выдачи. Карточка — `div.list.send-res-from-catalog-container`
 * с числовым `id`; внутри `a.vacancyLink` (заголовок и адрес) и `span.room`
 * (город).
 *
 * Заголовок приходит с подсветкой запроса (`<em class="searchword">`), поэтому
 * теги снимаются, а не берутся как есть.
 */
export function parseSearchPage(html: string): CareeristSearchItem[] {
  const out: CareeristSearchItem[] = [];
  const cardRe = /<div class="list\s+send-res-from-catalog-container\s*"\s+id="(\d+)"\s*>([\s\S]*?)(?=<div class="list\s+send-res-from-catalog-container|<\/div>\s*<\/div>\s*<\/div>|$)/g;

  for (const m of html.matchAll(cardRe)) {
    const sourceId = m[1]!;
    const body = m[2]!;

    const link = /<a\s[^>]*class="[^"]*vacancyLink[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(body);
    if (link === null) continue;

    const url = link[1]!;
    const title = stripHtml(link[2]!);
    if (title === '') continue;

    const geoMatch = /<span[^>]*class="[^"]*\broom\b[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(body);
    const dateMatch = /<p class="line-36 card-text text-small\s*">([\s\S]*?)<\/p>/.exec(body);

    out.push({
      sourceId,
      title,
      url,
      geo: geoMatch === null ? '' : stripHtml(geoMatch[1]!),
      postedText: dateMatch === null ? '' : stripHtml(dateMatch[1]!),
    });
  }
  return out;
}

export interface CareeristVacancyDetail {
  company: string;
  geo: string;
  description: string;
}

/**
 * Выкидывает скрипты и стили вместе с содержимым.
 *
 * Обязательный первый шаг разбора, а не гигиена: careerist.ru вставляет между
 * блоками страницы рекламу Яндекс.RTB — <script> с вызовом
 * `Ya.Context.AdvManager.render`, — и она оказывается ВНУТРИ той же разметки,
 * что и описание. Живой прогон 2026-08-31 показал, чем это кончается: тело
 * рекламного скрипта оказалось длиннее настоящего описания, уехало в вакансию
 * как её текст, скорер увидел JavaScript вместо обязанностей и поставил ноль.
 */
function stripScripts(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
}

/**
 * Содержимое блока с балансировкой вложенных div.
 *
 * Регулярка тут не работает в принципе: описание вакансии содержит вложенные
 * div, а нежадное `[\s\S]*?</div>` останавливается на первом закрывающем теге
 * — то есть на конце первого вложенного блока. На фикстуре МОЭК вложенности
 * не было и обрезки не происходило; на вакансии Selecty (Ташкент) описание
 * обрывалось на 28 символах, «Компания "Selecty" О проекте». Поэтому теги
 * считаются, а не сопоставляются.
 *
 * `startIndex` — позиция открывающего `<div`.
 */
export function extractBalancedDiv(html: string, startIndex: number): string {
  const openEnd = html.indexOf('>', startIndex);
  if (openEnd === -1) return '';

  const tagRe = /<(\/?)div\b[^>]*>/g;
  tagRe.lastIndex = openEnd + 1;
  let depth = 1;

  for (let m = tagRe.exec(html); m !== null; m = tagRe.exec(html)) {
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(openEnd + 1, m.index);
  }
  // Незакрытый блок — отдаём остаток, а не пустоту: обрезанная страница всё
  // ещё лучше, чем молчаливо потерянное описание.
  return html.slice(openEnd + 1);
}

/**
 * Разбирает страницу вакансии. Описание на карточке выдачи обрезано
 * многоточием и для скоринга не годится — без этой дочитки вакансия почти
 * всегда набрала бы околонулевой балл и отсеялась.
 *
 * Микроразметки (`itemprop="description"`, `baseSalary`) на странице нет —
 * проверено, см. docs/careerist-selectors.md. Опираемся на разметку, которая
 * там действительно есть.
 */
export function parseVacancyPage(rawHtml: string): CareeristVacancyDetail {
  const html = stripScripts(rawHtml);

  // Название компании — первый <div class="m-b-10"> после <h1>. На карточке
  // выдачи отдельным полем его нет вообще, только в скобках заголовка.
  const h1 = html.indexOf('<h1');
  const afterH1 = h1 === -1 ? html : html.slice(h1);
  const companyMatch = /<div class="m-b-10">([\s\S]*?)<\/div>/.exec(afterH1);

  const geoMatch = /<p class="col-xs-4 col-sm-3 text-muted">\s*Город:\s*<\/p>\s*<p[^>]*>([\s\S]*?)<\/p>/.exec(html);

  // Описание — самый крупный блок b-b-1. Тем же классом размечены шапка с
  // городом и блок с кнопкой отклика, и цепляться за порядковый номер значило
  // бы сломаться от любой вставки между ними.
  let description = '';
  const blockRe = /<div class="b-b-1">/g;
  for (let m = blockRe.exec(html); m !== null; m = blockRe.exec(html)) {
    const text = stripHtml(extractBalancedDiv(html, m.index));
    if (text.length > description.length) description = text;
  }

  return {
    company: companyMatch === null ? '' : stripHtml(companyMatch[1]!),
    geo: geoMatch === null ? '' : stripHtml(geoMatch[1]!),
    description,
  };
}

/** См. AdapterSearchStats в src/pipeline.ts — необязательный бонус-сигнал, не часть Adapter. */
export interface CareeristSearchStats {
  read: number;
  rejectedExperience: number;
  rejectedGrade: number;
  duplicatesSkipped: number;
}

export class CareeristAdapter implements Adapter {
  readonly name = 'careerist';
  lastSearchStats?: CareeristSearchStats;
  private fetchImpl: typeof fetch;

  constructor(opts: { fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(filters: SearchFilters): Promise<Vacancy[]> {
    const budget = filters.maxResults ?? ITEMS_PER_PAGE;
    const skip = filters.skip ?? 0;

    // Первый запрос — ради редиректа на канонический слаг: только на нём
    // работает ?page= (см. docs/careerist-selectors.md).
    const entry = await this.fetchImpl(buildSearchEntryUrl(filters.query), {
      headers: { Accept: 'text/html' },
    });
    if (!entry.ok) {
      this.lastSearchStats = { read: 0, rejectedExperience: 0, rejectedGrade: 0, duplicatesSkipped: 0 };
      return [];
    }
    const canonical = entry.url === '' ? buildSearchEntryUrl(filters.query) : entry.url;

    const collected: CareeristSearchItem[] = [];
    const seenIds = new Set<string>();
    let firstHtml: string | null = await entry.text();

    for (let pageNo = 1; collected.length < skip + budget; pageNo++) {
      let html: string;
      if (pageNo === 1 && firstHtml !== null) {
        // Первую страницу уже прочитали редиректом — не тянем её второй раз.
        html = firstHtml;
        firstHtml = null;
      } else {
        const res = await this.fetchImpl(buildPageUrl(canonical, pageNo), {
          headers: { Accept: 'text/html' },
        });
        if (!res.ok) break;
        html = await res.text();
      }

      const items = parseSearchPage(html);
      if (items.length === 0) break;

      // Своя дедупликация по ходу листания: за последней страницей площадка
      // может отдать повтор предыдущей, и без проверки цикл крутился бы до
      // исчерпания бюджета на одних и тех же карточках.
      let fresh = 0;
      for (const it of items) {
        if (seenIds.has(it.sourceId)) continue;
        seenIds.add(it.sourceId);
        collected.push(it);
        fresh++;
        if (collected.length >= skip + budget) break;
      }
      if (fresh === 0) break;
    }

    // Окно этого захода: всё, что раньше skip, прочитано прошлой порцией и
    // второй раз в статистику не идёт.
    const window = collected.slice(skip);

    let duplicatesSkipped = 0;
    const wanted: CareeristSearchItem[] = [];
    for (const it of window) {
      // Отсев ДО дочитывания страницы вакансии. Грейд виден в заголовке
      // карточки; опыт — нет, структурного маркера у площадки не существует
      // (в отличие от hh.ru), так что гейт опыта отрабатывает конвейер уже по
      // тексту описания.
      if (filters.seenThisRun?.has(`${this.name}:${it.sourceId}`)) { duplicatesSkipped++; continue; }
      wanted.push(it);
    }

    const out: Vacancy[] = [];
    for (const item of wanted) {
      const detail = await this.fetchDetail(item.url);
      out.push(normalizeVacancy({
        source: this.name,
        sourceId: item.sourceId,
        title: item.title,
        company: detail.company === '' ? extractCompanyFromTitle(item.title) : detail.company,
        url: item.url,
        description: detail.description,
        geo: detail.geo === '' ? item.geo : detail.geo,
        // Дата на карточке — «21 Августа», без года, а на детали «21 Августа
        // 2026». Разбирать русский месяц ради поля, которое нигде не
        // используется для отбора, смысла нет: берём момент чтения, как это
        // уже сделано для hh.ru.
        postedAt: new Date(),
        isRemote: false,
        experience: parseExperienceFromText(detail.description),
      }));
    }

    this.lastSearchStats = {
      read: window.length,
      rejectedExperience: 0,
      rejectedGrade: 0,
      duplicatesSkipped,
    };
    return out;
  }

  private async fetchDetail(url: string): Promise<CareeristVacancyDetail> {
    try {
      const res = await this.fetchImpl(url, { headers: { Accept: 'text/html' } });
      if (!res.ok) return { company: '', geo: '', description: '' };
      return parseVacancyPage(await res.text());
    } catch {
      // Падение одной детали не роняет всю выдачу: вакансия остаётся с пустым
      // описанием, отсеется скорером и просто не попадёт в очередь.
      return { company: '', geo: '', description: '' };
    }
  }

  /**
   * Отклик на careerist.ru требует аккаунта: кнопка «Отправить резюме» ведёт
   * на `register.html?vacancyID=…` (docs/careerist-selectors.md). Аккаунта нет,
   * а регистрировать его за пользователя нельзя.
   *
   * `auth_required` — честный ответ на это: заявка остаётся `approved` и
   * дождётся человека, вместо того чтобы уйти в `failed` и потерять уже
   * написанное письмо. Когда аккаунт появится и пользователь залогинится в
   * браузерный профиль, здесь появится настоящая подача — снятая живьём, как
   * это сделано для hh.ru, а не написанная по догадке.
   */
  async apply(_vacancy: Vacancy, _letter: string): Promise<ApplyResult> {
    return { status: 'auth_required' };
  }
}

/** Название компании на careerist.ru живёт в скобках заголовка: «Бизнес-аналитик( МОЭК )». */
export function extractCompanyFromTitle(title: string): string {
  const m = /\(([^)]+)\)\s*$/.exec(title);
  return m === null ? '' : m[1]!.trim();
}
