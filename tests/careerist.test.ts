import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseSearchPage,
  parseVacancyPage,
  buildSearchEntryUrl,
  buildPageUrl,
  stripHtml,
  extractCompanyFromTitle,
  extractBalancedDiv,
  decodeMsonResponse,
  parseApplyForm,
  parseTagAttrs,
  extractResumeId,
  CareeristAdapter,
  ITEMS_PER_PAGE,
} from '../src/adapters/careerist.js';

/**
 * Фикстуры сняты живьём 2026-08-31 с careerist.ru — настоящая выдача по
 * «Бизнес-аналитик» и настоящая страница вакансии 89110600 (МОЭК). Разбор
 * проверяется по ним, а не по придуманной разметке: контракт площадки нам не
 * принадлежит, и единственный способ узнать, что он всё ещё такой, — держать
 * рядом её собственный HTML.
 *
 * Контактов работодателя в фикстурах нет — на анонимной странице их не
 * показывают, проверено перед тем, как класть файлы в репозиторий.
 */
const searchHtml = readFileSync('tests/fixtures/careerist-search.html', 'utf8');
const vacancyHtml = readFileSync('tests/fixtures/careerist-vacancy.html', 'utf8');
/**
 * Вторая страница вакансии — Selecty, Ташкент, id 89044924. Взята не для
 * количества: у неё во ВЛОЖЕННЫХ div лежит описание, а между блоками страницы
 * стоит рекламный <script> Яндекс.RTB. На первой фикстуре ни того, ни другого
 * нет, и разбор, который на ней проходил, на этой отдавал в качестве описания
 * тело рекламного скрипта. Нашёл это живой прогон, а не фикстуры.
 */
const nestedHtml = readFileSync('tests/fixtures/careerist-vacancy-nested.html', 'utf8');
/**
 * Настоящее модальное окно отклика, снятое с залогиненного профиля 2026-08-31.
 * Хеш пользователя, id резюме и имя в тексте заменены на синтетические —
 * структура PHP-сериализации внутри `afdata` при этом сохранена ровно,
 * поэтому разбор проверяется на настоящей форме, а в репозиторий не уезжает
 * ничего, чем можно воспользоваться.
 */
const applyModalHtml = readFileSync('tests/fixtures/careerist-apply-modal.html', 'utf8');
/**
 * То же окно отклика, но с ОДИНАРНЫМИ кавычками в атрибутах и без `value` у
 * поля Total — так площадка отдаёт его на части вакансий. Снято с живой
 * подачи 2026-09-01, когда отклик упал с «в ответе нет формы отклика —
 * разметка площадки изменилась». Разметка не менялась: разбор ждал двойных
 * кавычек и не находил ничего.
 */
const applyModalQuotesHtml = readFileSync('tests/fixtures/careerist-apply-modal-quotes.html', 'utf8');

describe('careerist — адреса', () => {
  it('входной адрес несёт текст запроса и категорию', () => {
    const u = new URL(buildSearchEntryUrl('бизнес-аналитик'));
    expect(u.searchParams.get('text')).toBe('бизнес-аналитик');
    expect(u.searchParams.get('category')).toBe('vacancy');
  });

  it('кодирует запрос в UTF-8, как площадка и отвечает', () => {
    // Ответ приходит с charset=UTF-8; percent-encoding запроса в UTF-8
    // площадка принимает — проверено живьём.
    expect(buildSearchEntryUrl('бизнес-аналитик')).toContain('%D0%B1%D0%B8%D0%B7');
  });

  it('страница добавляется к КАНОНИЧЕСКОМУ адресу', () => {
    // На /search/ параметр page теряется при редиректе, и вторая страница
    // приезжает первой — 30 совпадений из 30. Пагинация живёт только на слаге.
    expect(buildPageUrl('https://careerist.ru/jobs-biznes_analitik/', 2))
      .toBe('https://careerist.ru/jobs-biznes_analitik/?page=2');
  });

  it('перезаписывает уже стоящий page, а не приписывает второй', () => {
    expect(buildPageUrl('https://careerist.ru/jobs-biznes_analitik/?page=2', 3))
      .toBe('https://careerist.ru/jobs-biznes_analitik/?page=3');
  });
});

describe('careerist — stripHtml', () => {
  it('снимает подсветку запроса с заголовка', () => {
    expect(stripHtml('<em class="searchword">Бизнес-аналитик</em>( МОЭК )'))
      .toBe('Бизнес-аналитик( МОЭК )');
  });

  it('разворачивает сущности и не делает двойного декода', () => {
    // "&amp;lt;" обязано стать буквальным "&lt;", а не "<".
    expect(stripHtml('&amp;lt; &quot;текст&quot;&nbsp;A&#65;')).toBe('&lt; "текст" AA');
  });

  it('схлопывает пробелы и переносы', () => {
    expect(stripHtml('  а\n\n  б  ')).toBe('а б');
  });
});

describe('careerist — parseSearchPage на живой выдаче', () => {
  const items = parseSearchPage(searchHtml);

  it('находит все карточки страницы', () => {
    expect(items).toHaveLength(ITEMS_PER_PAGE);
  });

  it('у каждой карточки числовой id, непустой заголовок и адрес вакансии', () => {
    for (const it of items) {
      expect(it.sourceId).toMatch(/^\d+$/);
      expect(it.title.length).toBeGreaterThan(0);
      expect(it.url).toMatch(/^https:\/\/careerist\.ru\/vakansii\/.+\.html$/);
    }
  });

  it('id уникальны в пределах страницы', () => {
    expect(new Set(items.map((i) => i.sourceId)).size).toBe(items.length);
  });

  it('первая карточка — известная вакансия 89110600 (МОЭК)', () => {
    expect(items[0]!.sourceId).toBe('89110600');
    expect(items[0]!.title).toContain('Бизнес-аналитик');
    expect(items[0]!.url).toContain('89110600');
  });

  it('заголовок приходит без остатков разметки подсветки', () => {
    for (const it of items) {
      expect(it.title).not.toContain('<');
      expect(it.title).not.toContain('searchword');
    }
  });

  it('город читается с карточки', () => {
    expect(items[0]!.geo).toBe('Москва');
  });

  it('пустая страница не роняет разбор', () => {
    expect(parseSearchPage('<html><body>ничего</body></html>')).toEqual([]);
  });
});

describe('careerist — parseVacancyPage на живой странице', () => {
  const detail = parseVacancyPage(vacancyHtml);

  it('достаёт название компании, которого на карточке выдачи нет отдельным полем', () => {
    expect(detail.company).toBe('Московская объединенная энергетическая компания');
  });

  it('достаёт город', () => {
    expect(detail.geo).toBe('Москва');
  });

  it('достаёт ПОЛНОЕ описание, а не обрезанное многоточием с карточки', () => {
    // На карточке текст заканчивается «Анализ и оптимизация...». Именно из-за
    // этого дочитка обязательна: по обрезку скорер почти всегда даёт ноль.
    expect(detail.description.length).toBeGreaterThan(1000);
    expect(detail.description).toContain('BPMN');
    expect(detail.description).toContain('AS IS');
    expect(detail.description).not.toContain('<');
  });

  it('описание содержит то, за что скорер и должен зацепиться', () => {
    for (const word of ['бизнес-процесс', 'требован', 'документац']) {
      expect(detail.description.toLowerCase()).toContain(word);
    }
  });

  it('страница без ожидаемой разметки не роняет разбор', () => {
    expect(parseVacancyPage('<html><body></body></html>'))
      .toEqual({ company: '', geo: '', description: '' });
  });
});

describe('careerist — extractCompanyFromTitle', () => {
  it('достаёт компанию из скобок заголовка', () => {
    expect(extractCompanyFromTitle('Бизнес-аналитик( МОЭК )')).toBe('МОЭК');
  });

  it('пусто, когда скобок нет', () => {
    expect(extractCompanyFromTitle('Бизнес-аналитик')).toBe('');
  });
});

describe('CareeristAdapter.search — без сети, на фикстурах', () => {
  function mkFetch(pages: Record<number, string>, detail: string) {
    const calls: string[] = [];
    const impl = (async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/vakansii/')) {
        return new Response(detail, { status: 200, headers: { 'Content-Type': 'text/html' } });
      }
      const pageNo = Number(new URL(u).searchParams.get('page') ?? '1');
      const body = pages[pageNo] ?? '<html></html>';
      // Response.url пустой у сконструированного вручную ответа, поэтому
      // канонический адрес подставляем так же, как его отдал бы редирект.
      const res = new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });
      Object.defineProperty(res, 'url', { value: 'https://careerist.ru/jobs-biznes_analitik/' });
      return res;
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('дочитывает страницу вакансии для каждой возвращённой и уважает maxResults', async () => {
    const { impl, calls } = mkFetch({ 1: searchHtml }, vacancyHtml);
    const a = new CareeristAdapter({ fetchImpl: impl });
    const vs = await a.search({ query: 'бизнес-аналитик', maxResults: 3 });

    expect(vs).toHaveLength(3);
    expect(calls.filter((u) => u.includes('/vakansii/'))).toHaveLength(3);
    for (const v of vs) {
      expect(v.source).toBe('careerist');
      expect(v.description.length).toBeGreaterThan(200);
      expect(v.company.length).toBeGreaterThan(0);
    }
  });

  it('skip сдвигает окно — соседние порции не пересекаются', async () => {
    // Порционное чтение под цель-по-доставленным (см. pipeline.runSearch).
    const { impl } = mkFetch({ 1: searchHtml }, vacancyHtml);
    const a = new CareeristAdapter({ fetchImpl: impl });

    const first = await a.search({ query: 'бизнес-аналитик', maxResults: 5 });
    expect(a.lastSearchStats?.read).toBe(5);
    const firstIds = new Set(first.map((v) => v.sourceId));

    const second = await a.search({ query: 'бизнес-аналитик', maxResults: 5, skip: 5 });
    expect(a.lastSearchStats?.read).toBe(5);
    for (const v of second) expect(firstIds.has(v.sourceId)).toBe(false);
  });

  it('skip за пределом выдачи — читать нечего, и это видно по статистике', async () => {
    const { impl } = mkFetch({ 1: searchHtml }, vacancyHtml);
    const a = new CareeristAdapter({ fetchImpl: impl });
    const out = await a.search({ query: 'бизнес-аналитик', maxResults: 5, skip: 500 });
    expect(out).toHaveLength(0);
    expect(a.lastSearchStats?.read).toBe(0);
  });

  it('seenThisRun пропускает уже виденную карточку до дочитки её страницы', async () => {
    const { impl, calls } = mkFetch({ 1: searchHtml }, vacancyHtml);
    const a = new CareeristAdapter({ fetchImpl: impl });
    const seen = new Set(['careerist:89110600']);
    const vs = await a.search({ query: 'бизнес-аналитик', maxResults: 3, seenThisRun: seen });

    expect(vs.map((v) => v.sourceId)).not.toContain('89110600');
    expect(calls.some((u) => u.includes('89110600'))).toBe(false);
    expect(a.lastSearchStats?.duplicatesSkipped).toBe(1);
  });

  it('листает дальше первой страницы, когда бюджет больше страницы', async () => {
    // Вторая страница подменена той же разметкой с другими id, чтобы дедуп по
    // ходу листания не остановил цикл.
    const page2 = searchHtml.replace(/id="(\d+)"/g, (_, d: string) => `id="9${d}"`);
    const { impl, calls } = mkFetch({ 1: searchHtml, 2: page2 }, vacancyHtml);
    const a = new CareeristAdapter({ fetchImpl: impl });
    const vs = await a.search({ query: 'бизнес-аналитик', maxResults: ITEMS_PER_PAGE + 5 });

    expect(vs.length).toBe(ITEMS_PER_PAGE + 5);
    expect(calls.some((u) => u.includes('page=2'))).toBe(true);
  });

  it('повтор той же страницы за концом выдачи останавливает листание', async () => {
    // Площадка за последней страницей может отдать копию предыдущей. Без
    // проверки на свежие id цикл крутился бы до исчерпания бюджета.
    const { impl } = mkFetch({ 1: searchHtml, 2: searchHtml, 3: searchHtml }, vacancyHtml);
    const a = new CareeristAdapter({ fetchImpl: impl });
    const vs = await a.search({ query: 'бизнес-аналитик', maxResults: 200 });
    expect(vs).toHaveLength(ITEMS_PER_PAGE);
  });

  it('первая страница не читается дважды: редирект уже принёс её тело', async () => {
    const { impl, calls } = mkFetch({ 1: searchHtml }, vacancyHtml);
    const a = new CareeristAdapter({ fetchImpl: impl });
    await a.search({ query: 'бизнес-аналитик', maxResults: 2 });
    const listCalls = calls.filter((u) => !u.includes('/vakansii/'));
    expect(listCalls).toHaveLength(1);
  });

  it('ошибка входного запроса — пустой результат, а не исключение', async () => {
    const impl = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const a = new CareeristAdapter({ fetchImpl: impl });
    await expect(a.search({ query: 'бизнес-аналитик' })).resolves.toEqual([]);
    expect(a.lastSearchStats?.read).toBe(0);
  });

  it('падение одной детали не роняет выдачу — вакансия остаётся с пустым описанием', async () => {
    const impl = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/vakansii/')) throw new Error('деталь недоступна');
      const res = new Response(searchHtml, { status: 200 });
      Object.defineProperty(res, 'url', { value: 'https://careerist.ru/jobs-biznes_analitik/' });
      return res;
    }) as unknown as typeof fetch;
    const a = new CareeristAdapter({ fetchImpl: impl });
    const vs = await a.search({ query: 'бизнес-аналитик', maxResults: 2 });
    expect(vs).toHaveLength(2);
    expect(vs[0]!.description).toBe('');
  });
});



describe('careerist — реклама и вложенность на странице вакансии', () => {
  const detail = parseVacancyPage(nestedHtml);

  it('описание — текст вакансии, а не тело рекламного скрипта', () => {
    expect(detail.description).not.toContain('yaContextCb');
    expect(detail.description).not.toContain('AdvManager');
  });

  it('описание не обрывается на первом вложенном div', () => {
    // Было 28 символов — «Компания "Selecty" О проекте» — потому что нежадная
    // регулярка останавливалась на закрытии первого вложенного блока.
    expect(detail.description.length).toBeGreaterThan(1000);
    expect(detail.description).toContain('Selecty');
  });

  it('после починки вакансия набирает осмысленный текст для скорера', () => {
    const low = detail.description.toLowerCase();
    expect(low).toContain('требован');
    expect(low).toContain('процесс');
  });

  it('компания и город читаются и на этой странице', () => {
    expect(detail.company).toBe('Selecty');
    expect(detail.geo.length).toBeGreaterThan(0);
  });
});

describe('careerist — extractBalancedDiv', () => {
  it('считает вложенные div, а не останавливается на первом закрывающем', () => {
    const html = '<div class="b-b-1">начало<div>вложенный</div>конец</div>хвост';
    expect(extractBalancedDiv(html, 0)).toBe('начало<div>вложенный</div>конец');
  });

  it('справляется с несколькими уровнями вложенности', () => {
    const html = '<div>a<div>b<div>c</div>d</div>e</div>';
    expect(extractBalancedDiv(html, 0)).toBe('a<div>b<div>c</div>d</div>e');
  });

  it('незакрытый блок отдаёт остатком, а не пустотой', () => {
    // Обрезанная страница всё ещё лучше молчаливо потерянного описания.
    expect(extractBalancedDiv('<div>текст без закрытия', 0)).toBe('текст без закрытия');
  });

  it('не путает div с другими тегами, начинающимися на те же буквы', () => {
    const html = '<div>a<divider>b</divider>c</div>';
    expect(extractBalancedDiv(html, 0)).toBe('a<divider>b</divider>c');
  });
});


describe('careerist — рекламный скрипт не может стать описанием', () => {
  // На фикстуре Selecty балансировка div сама делает описание самым длинным
  // блоком, поэтому проверки по ней проходят и без выкидывания скриптов —
  // доказывают они только вложенность. Опасность же остаётся ровно там, где
  // она сработала живьём: описание КОРОТКОЕ, а рекламная вставка длинная.
  // Именно этот случай здесь и собран.
  const page = [
    '<h1>Аналитик</h1>',
    '<div class="m-b-10">Контора</div>',
    '<p class="col-xs-4 col-sm-3 text-muted">Город:</p><p>Москва</p>',
    '<div class="b-b-1">',
    '<script>window.yaContextCb.push(()=>{ Ya.Context.AdvManager.render({',
    "renderTo: 'yandex_rtb_R-A-2171533-2', blockId: 'R-A-2171533-2', statId: '150'",
    '}, () => { document.getElementById("x").innerHTML = "много-много байтов рекламы"; }) })</script>',
    '</div>',
    '<div class="b-b-1"><p>Ищем аналитика. Требования к процессам.</p></div>',
  ].join('\n');

  const detail = parseVacancyPage(page);

  it('берёт короткое описание вакансии, а не длинный рекламный блок', () => {
    expect(detail.description).toBe('Ищем аналитика. Требования к процессам.');
  });

  it('в описании не остаётся ни следа от скрипта', () => {
    expect(detail.description).not.toContain('yaContextCb');
    expect(detail.description).not.toContain('AdvManager');
    expect(detail.description).not.toContain('renderTo');
  });

  it('остальные поля страницы при этом читаются', () => {
    expect(detail.company).toBe('Контора');
    expect(detail.geo).toBe('Москва');
  });
});


describe('careerist — разбор ответа /mson/', () => {
  it('разворачивает percent-encoded JSON, которым площадка отвечает', () => {
    // Заголовок говорит text/html, но тело — это JSON целиком под
    // percent-encoding'ом (на странице его разворачивает vfJsonDecode).
    // Разбирать такой ответ как HTML бесполезно.
    const packed = encodeURIComponent(JSON.stringify({ result: true, output: '<form></form>' }));
    expect(decodeMsonResponse(packed)).toEqual({ result: true, output: '<form></form>' });
  });

  it('мусор не роняет разбор', () => {
    expect(decodeMsonResponse('не json вовсе')).toEqual({});
    expect(decodeMsonResponse('%')).toEqual({});
  });
});

describe('careerist — parseApplyForm на настоящем модальном окне', () => {
  const form = parseApplyForm(applyModalHtml);

  it('достаёт afdata — его нельзя собрать, только передать как есть', () => {
    expect(form).not.toBeNull();
    expect(form!.afdata.length).toBeGreaterThan(100);
  });

  it('в afdata лежит PHP-сериализованный блок с VacancyID и id резюме', () => {
    // Именно поэтому поле передаётся нетронутым: собрать его самим нельзя.
    const raw = Buffer.from(form!.afdata, 'base64').toString('utf8');
    expect(raw).toContain('VacancyID');
    expect(raw).toContain('resume/material-form:send');
  });

  it('находит поле письма — значит письмо уходит ВМЕСТЕ с откликом', () => {
    // В отличие от hh.ru, где письмо приходится досылать вторым шагом в чат.
    expect(form!.letterField).toBe('TextRes');
  });

  it('достаёт остальные скрытые поля', () => {
    expect(form!.total).toBe('1');
    expect(form!.extentionInstall).toBe('0');
  });

  it('разметка без формы — null, а не выдуманные поля', () => {
    expect(parseApplyForm('<div>ничего</div>')).toBeNull();
  });
});

describe('careerist — extractResumeId', () => {
  it('берёт id резюме из кнопки отклика', () => {
    expect(extractResumeId("vfShowInFrame('x', 'resume/send/89044870/14292072',true,true, false);"))
      .toBe('14292072');
  });

  it('нет кнопок отклика — null (так выглядит разлогиненный профиль)', () => {
    expect(extractResumeId('<a href="/register.html?vacancyID=1">Отправить резюме</a>')).toBeNull();
  });
});

describe('CareeristAdapter.apply — на подставном контексте, без сети', () => {
  interface Call { method: string; url: string; opts?: Record<string, unknown> }

  function mkCtx(opts: {
    responds?: string[];        // тело /responds/ на последовательных вызовах
    respondsOk?: boolean;
    vacancyPage?: string;
    formOutput?: string | null;
    formOk?: boolean;
    sendOk?: boolean;
  }) {
    const calls: Call[] = [];
    let respondsCall = 0;
    const responds = opts.responds ?? ['<html>пусто</html>', '<html>пусто</html>'];

    const reply = (body: string, ok = true, url = 'https://careerist.ru/x') => ({
      ok: () => ok,
      status: () => (ok ? 200 : 500),
      url: () => url,
      text: async () => body,
    });

    const ctx = {
      pages: () => [],
      // Кеш контекста подписывается на 'close' (см. makeContextCache):
      // опрашивать закрытость нельзя, pages() у мёртвого контекста молчит.
      once: () => {},
      close: async () => {},
      request: {
        get: async (url: string) => {
          calls.push({ method: 'GET', url });
          if (url.includes('/responds/')) {
            const body = responds[Math.min(respondsCall++, responds.length - 1)]!;
            return reply(body, opts.respondsOk ?? true, url);
          }
          return reply(opts.vacancyPage ?? "vfShowInFrame('x','resume/send/1/14292072',true,true,false)");
        },
        post: async (url: string, o?: Record<string, unknown>) => {
          calls.push({ method: 'POST', url, opts: o });
          if (url.includes('/mson/resume/send/')) {
            if (opts.formOk === false) return reply('', false, url);
            const out = opts.formOutput === undefined ? applyModalHtml : opts.formOutput;
            return reply(encodeURIComponent(JSON.stringify({ output: out ?? '' })), true, url);
          }
          return reply('ok', opts.sendOk ?? true, url);
        },
      },
    };
    return { ctx, calls };
  }

  const VAC = { sourceId: '89044870', url: 'https://careerist.ru/vakansii/x-89044870.html' } as never;

  it('успешная подача: письмо уходит в поле формы, статус sent', async () => {
    const { ctx, calls } = mkCtx({ responds: ['<html>пусто</html>', '<html>… 89044870 …</html>'] });
    const a = new CareeristAdapter({ context: ctx as never });

    const res = await a.apply(VAC, 'моё письмо');
    expect(res).toEqual({ status: 'sent' });

    const send = calls.find((c) => c.url.includes('/mson/ajaxform/post'));
    expect(send).toBeDefined();
    const parts = (send!.opts as { multipart: Record<string, string> }).multipart;
    expect(parts['TextRes']).toBe('моё письмо');
    // afdata возвращается нетронутым — собрать его самим нельзя.
    expect(parts['afdata']!.length).toBeGreaterThan(100);
  });

  it('уже откликались — вторая подача не делается вовсе', async () => {
    // Единственная защита от двойного отклика на стороне площадки; наш
    // уникальный индекс ловит только повторы внутри очереди.
    const { ctx, calls } = mkCtx({ responds: ['<html>… 89044870 …</html>'] });
    const a = new CareeristAdapter({ context: ctx as never });

    expect(await a.apply(VAC, 'письмо')).toEqual({ status: 'already_applied' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('кабинет недоступен — auth_required, а не failed', async () => {
    // Заявка обязана остаться approved: письмо уже написано и одобрено.
    const { ctx, calls } = mkCtx({ respondsOk: false });
    const a = new CareeristAdapter({ context: ctx as never });

    expect(await a.apply(VAC, 'письмо')).toEqual({ status: 'auth_required' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('на странице нет кнопок отклика (разлогинен) — auth_required', async () => {
    const { ctx } = mkCtx({ vacancyPage: '<a href="/register.html?vacancyID=1">Отправить резюме</a>' });
    const a = new CareeristAdapter({ context: ctx as never });
    expect(await a.apply(VAC, 'письмо')).toEqual({ status: 'auth_required' });
  });

  it('в форме пропало поле письма — НЕ подаём и говорим почему', async () => {
    // Подача без письма противоречит смыслу очереди: человек одобрял письмо,
    // а ушло бы одно резюме.
    const { ctx, calls } = mkCtx({ formOutput: '<form><input name="afdata" value="AAAA-длинное-значение-более-ста-символов-чтобы-пройти-проверку-длины-в-тесте-и-остаться-читаемым"></form>' });
    const a = new CareeristAdapter({ context: ctx as never });

    const res = await a.apply(VAC, 'письмо');
    expect(res.status).toBe('failed');
    expect((res as { reason: string }).reason).toMatch(/письм/i);
    expect(calls.some((c) => c.url.includes('/mson/ajaxform/post'))).toBe(false);
  });

  it('форма не пришла — failed с причиной, подача не делается', async () => {
    const { ctx, calls } = mkCtx({ formOutput: null });
    const a = new CareeristAdapter({ context: ctx as never });

    const res = await a.apply(VAC, 'письмо');
    expect(res.status).toBe('failed');
    expect(calls.some((c) => c.url.includes('/mson/ajaxform/post'))).toBe(false);
  });

  it('ответ 200, но отклика в кабинете нет — это НЕ успех', async () => {
    // Иначе очередь пометила бы вакансию отправленной и больше к ней не
    // вернулась, а отклик до работодателя не дошёл.
    const { ctx } = mkCtx({ responds: ['<html>пусто</html>', '<html>пусто</html>'] });
    const a = new CareeristAdapter({ context: ctx as never });

    const res = await a.apply(VAC, 'письмо');
    expect(res.status).toBe('failed');
    expect(res.status).not.toBe('sent');
  });

  it('подача отклонена по HTTP — failed, а не sent', async () => {
    const { ctx } = mkCtx({ sendOk: false });
    const a = new CareeristAdapter({ context: ctx as never });
    const res = await a.apply(VAC, 'письмо');
    expect(res.status).toBe('failed');
  });

  it('проверка «уже откликались» идёт ДО запроса формы', async () => {
    const { ctx, calls } = mkCtx({ responds: ['<html>… 89044870 …</html>'] });
    const a = new CareeristAdapter({ context: ctx as never });
    await a.apply(VAC, 'письмо');
    expect(calls[0]!.url).toContain('/responds/');
  });
});


describe('careerist — форма отклика в любой разметке', () => {
  it('разбирается при ОДИНАРНЫХ кавычках в атрибутах', () => {
    // Живой отказ 2026-09-01: та же форма, другие кавычки, и отклик не ушёл.
    const form = parseApplyForm(applyModalQuotesHtml);
    expect(form).not.toBeNull();
    expect(form!.afdata.length).toBeGreaterThan(100);
    expect(form!.letterField).toBe('TextRes');
  });

  it('Total без атрибута value не ломает разбор', () => {
    // На этой вакансии площадка отдаёт <input id="Total" name="Total"
    // type="hidden"> — без value вообще.
    expect(parseApplyForm(applyModalQuotesHtml)!.total).toBe('1');
  });

  it('обе живые формы дают одинаковый набор полей', () => {
    const a = parseApplyForm(applyModalHtml)!;
    const b = parseApplyForm(applyModalQuotesHtml)!;
    expect(b.letterField).toBe(a.letterField);
    expect(b.total).toBe(a.total);
    expect(b.extentionInstall).toBe(a.extentionInstall);
  });

  it('поле письма ищется по тегу textarea, а не по имени TextRes', () => {
    // Имя может смениться, смысл «сюда пишут письмо» — нет.
    const html = "<form><input name='afdata' value='AAAA'><textarea name='Letter'></textarea></form>";
    expect(parseApplyForm(html)!.letterField).toBe('Letter');
  });

  it('без afdata — null: подавать нечем', () => {
    expect(parseApplyForm("<form><textarea name='TextRes'></textarea></form>")).toBeNull();
  });

  it('пустой afdata тоже null, а не пустая строка в запрос', () => {
    expect(parseApplyForm("<form><input name='afdata' value=''></form>")).toBeNull();
  });
});

describe('careerist — parseTagAttrs', () => {
  it('читает двойные кавычки', () => {
    expect(parseTagAttrs('<input name="a" value="b">')).toMatchObject({ name: 'a', value: 'b' });
  });

  it('читает одинарные', () => {
    expect(parseTagAttrs("<input name='a' value='b'>")).toMatchObject({ name: 'a', value: 'b' });
  });

  it('читает вовсе без кавычек', () => {
    expect(parseTagAttrs('<input name=a value=b>')).toMatchObject({ name: 'a', value: 'b' });
  });

  it('имена атрибутов приводятся к нижнему регистру — ENCTYPE и enctype это одно', () => {
    expect(parseTagAttrs("<form ENCTYPE='multipart/form-data'>")['enctype']).toBe('multipart/form-data');
  });

  it('атрибут без значения не ломает разбор соседей', () => {
    expect(parseTagAttrs("<input disabled name='a'>")).toMatchObject({ name: 'a' });
  });
});

describe('careerist — decodeMsonResponse и плюсы', () => {
  it('плюс разворачивается в пробел', () => {
    // Живая подача принесла ответ, где пробелы закодированы плюсами, и
    // атрибуты формы приезжали склеенными.
    const packed = encodeURIComponent(JSON.stringify({ output: '<form a="1" b="2">' })).replace(/%20/g, '+');
    expect(decodeMsonResponse(packed).output).toBe('<form a="1" b="2">');
  });

  it('настоящий плюс в тексте не теряется', () => {
    // В form-urlencoded буквальный плюс приезжает как %2B — и обязан вернуться.
    const packed = encodeURIComponent(JSON.stringify({ output: 'C++ и Java' })).replace(/%20/g, '+');
    expect(decodeMsonResponse(packed).output).toBe('C++ и Java');
  });
});
