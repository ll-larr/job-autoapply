import { normalizeVacancy, type Vacancy } from '../core/vacancy.js';
import type { Adapter, ApplyResult, SearchFilters } from './types.js';

const BASE = 'https://api.p.hr.ge/public-portal/tenant/1/api/v3';
const DEFAULT_LIMIT = 100;

/** Промежуточная форма: то, что даёт поиск, ещё без описания. */
export interface SearchItem {
  sourceId: string;
  title: string;
  company: string;
  geo: string;
  publishDate: string;
  url: string;
}

export function parseSearchResponse(json: unknown): SearchItem[] {
  const items = (json as { data?: { announcements?: { items?: unknown[] } } })
    ?.data?.announcements?.items;
  if (!Array.isArray(items)) return [];

  const out: SearchItem[] = [];
  for (const raw of items) {
    const a = raw as Record<string, unknown>;
    const id = a['announcementId'];
    if (typeof id !== 'number' && typeof id !== 'string') continue;
    const sourceId = String(id);
    const locations = Array.isArray(a['locations'])
      ? (a['locations'] as unknown[]).map(String).filter((s) => s !== '')
      : [];
    out.push({
      sourceId,
      title: String(a['title'] ?? ''),
      company: String(a['customerName'] ?? ''),
      geo: locations.length > 0 ? locations.join(', ') : 'Georgia',
      publishDate: String(a['publishDate'] ?? new Date().toISOString()),
      url: `https://www.hr.ge/announcement/${sourceId}`,
    });
  }
  return out;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Декодирует HTML entity-ссылки одним проходом: `String.replace` со своим
 * колбэком читает только исходную строку и никогда не перечитывает то, что
 * сам же подставил, — в отличие от последовательных `.replace().replace()`,
 * где результат одной замены мог повторно попасть под более раннее правило
 * (классический баг двойного декода: `&amp;lt;` через `&amp;`→`&`, затем
 * `&lt;`→`<` схлопывается в `<` вместо правильного буквального `&lt;`).
 */
function decodeEntities(input: string): string {
  return input.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Путь до текста описания — `data.announcement.description`, снят живым
 * перехватом (docs/hrge-api.md, "Description — requires a second call").
 * Поле приходит как HTML со строкой числовых ссылок на символы
 * (`&#4328;...`), а не как чистый текст — раздеваем теги и декодируем
 * ссылки, иначе скорер считает по разметке вместо слов.
 *
 * Порядок «сначала теги, потом entity-ссылки» выбран намеренно: настоящие
 * теги в сыром HTML уже буквальные (`<div>`), а `&lt;`/`&gt;` — это текст,
 * который сейчас не похож на тег и тег-стриппером не тронется; декодируем
 * их уже после стриппинга, так что при обратном порядке декодированные
 * `&lt;.../&gt;` могли бы притвориться тегами и стриппер съел бы настоящий
 * текст вакансии между ними.
 */
export function parseDetailResponse(json: unknown): string {
  const ann = (json as { data?: { announcement?: Record<string, unknown> } })
    ?.data?.announcement;
  if (ann === undefined || ann === null) return '';
  const raw = ann['description'];
  if (typeof raw !== 'string') return '';
  return decodeEntities(raw.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export class HrGeAdapter implements Adapter {
  readonly name = 'hrge';
  private fetchImpl: typeof fetch;

  constructor(opts: { fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(filters: SearchFilters): Promise<Vacancy[]> {
    const body = {
      Query: filters.query,
      CategoryIds: [],
      WorkExperience: { from: null, to: null },
      WithoutWorkExperience: false,
      AnyExperience: false,
      OnlySelectedSalary: false,
      Start: 0,
      Limit: DEFAULT_LIMIT,
      IsWorkFromHome: filters.remoteOnly ?? false,
    };

    const res = await this.fetchImpl(`${BASE}/announcement-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return [];

    const items = parseSearchResponse(await res.json());
    const wanted = filters.maxResults === undefined
      ? items
      : items.slice(0, filters.maxResults);

    const out: Vacancy[] = [];
    for (const item of wanted) {
      out.push(normalizeVacancy({
        source: 'hrge',
        sourceId: item.sourceId,
        title: item.title,
        company: item.company,
        url: item.url,
        description: await this.fetchDescription(item.sourceId),
        geo: item.geo,
        postedAt: item.publishDate,
        isRemote: filters.remoteOnly ?? false,
      }));
    }
    return out;
  }

  /** Описания в ответе поиска нет, а скорер без него слеп. Дочитываем деталь. */
  private async fetchDescription(sourceId: string): Promise<string> {
    try {
      const res = await this.fetchImpl(`${BASE}/announcement/${sourceId}`);
      if (!res.ok) return '';
      return parseDetailResponse(await res.json());
    } catch {
      // Одна недочитанная деталь не должна ронять всю выдачу.
      return '';
    }
  }

  async apply(vacancy: Vacancy, _letter: string): Promise<ApplyResult> {
    // Контракт apply не снят: чтобы его снять, нужно отправить настоящий отклик
    // на живую вакансию от имени пользователя. Это его аккаунт и его решение.
    // Пока — честный отказ со ссылкой, чтобы человек подал руками.
    return {
      status: 'failed',
      reason:
        `hr.ge: контракт отправки отклика ещё не снят, вакансия ${vacancy.sourceId} ` +
        `не подана. Подай вручную: ${vacancy.url}`,
    };
  }
}
