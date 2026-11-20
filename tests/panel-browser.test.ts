import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser, type Page } from 'playwright';
import { startPanel, type PanelDeps } from '../src/ui/server.js';
import { Queue } from '../src/core/queue.js';
import { normalizeVacancy } from '../src/core/vacancy.js';
import { seedSettings, freshSettings, validateSettings, type Settings } from '../src/core/settings.js';
import { clearStop } from '../src/core/sender.js';
import type { Adapter, ApplyResult } from '../src/adapters/types.js';
import type { Config } from '../src/core/config.js';

/**
 * Кнопки панели, нажатые по-настоящему.
 *
 * Остальные тесты интерфейса стучат в его http-ручки напрямую (ui-server) или
 * исполняют отдельные функции из <script> (panel-html). Ни то, ни другое не
 * ловит поломку в самой проводке страницы — а именно она и была замечена в
 * бою: «кнопка Отправить всё не отправляет». Здесь страница открывается в
 * настоящем Chromium, клик делается мышью, и проверяется то, что видит
 * пользователь: подача действительно случилась.
 *
 * Настоящих подач не происходит: адаптер подставной, в сеть не ходит.
 */

const CONFIG: Config = {
  minScore: 40,
  letterModels: ['m:free'],
  searchQueries: [{ query: 'аналитик' }],
  // Нулевые паузы: в бою между подачами стоит 3 секунды, но проверяется здесь
  // не троттлинг, а то, что клик доводит дело до adapter.apply().
  throttle: { hh: { minDelayMs: 0, maxDelayMs: 0 } },
};

function mkSpyAdapter(): Adapter & { applied: string[]; letters: string[]; hold: Promise<void> | null } {
  const applied: string[] = [];
  const letters: string[] = [];
  const spy = {
    name: 'hh',
    applied,
    letters,
    /** Если задан — первая подача ждёт его: так стоп нажимается посреди отправки. */
    hold: null as Promise<void> | null,
    async search() { return []; },
    async apply(vacancy: { sourceId: string }, letter: string): Promise<ApplyResult> {
      applied.push(vacancy.sourceId);
      letters.push(letter);
      if (applied.length === 1 && spy.hold !== null) await spy.hold;
      return { status: 'sent' };
    },
  };
  return spy;
}

let browser: Browser;
let page: Page;
let q: Queue;
let panel: { port: number; close(): Promise<void> };
let adapter: ReturnType<typeof mkSpyAdapter>;
let fillCalls: number;

beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

function seed(sourceId: string, score: number): number {
  q.insertPending(
    normalizeVacancy({
      source: 'hh', sourceId, title: 'Бизнес-аналитик', company: 'Сбер',
      url: `https://hh.ru/vacancy/${sourceId}`, description: 'описание', geo: 'Москва',
      postedAt: '2026-08-20T00:00:00Z',
    }),
    score, ['process-design'], 'письмо', 'full',
  );
  const rows = q.listByStatus('pending');
  return rows[rows.length - 1]!.id;
}

beforeEach(async () => {
  clearStop();
  q = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-pb-')), 'test.db'));
  adapter = mkSpyAdapter();
  fillCalls = 0;
  panel = await startPanel(q, 0, {
    adapters: [adapter],
    config: CONFIG,
    // Подставная генерация: настоящую модель дёргать незачем, проверяется
    // проводка кнопки, а не качество письма.
    fillLetters: async () => {
      fillCalls++;
      let filled = 0;
      for (const row of q.listByStatus('approved')) {
        if (row.letter.trim() === '') { q.setLetter(row.id, 'дописанное письмо', 'full'); filled++; }
      }
      return { found: filled, filled };
    },
  });
  page = await browser.newPage();
});
afterEach(async () => {
  await page.close();
  await panel.close();
  q.close();
});

async function open(hash: string): Promise<void> {
  await page.goto(`http://127.0.0.1:${panel.port}/#${hash}`, { waitUntil: 'domcontentloaded' });
  // Страница рисуется после первого load(); ждём, пока счётчики перестанут
  // быть нулями из разметки.
  await page.waitForFunction(() => document.querySelectorAll('.card').length > 0
    || document.querySelectorAll('.empty').length > 0);
}

describe('панель в браузере — «Отправить всё»', () => {
  it('один клик доводит дело до подачи: adapter.apply вызван, строка стала sent', async () => {
    const id = seed('1', 80);
    q.approve(id, 'письмо');

    await open('approved');
    await page.click('#sendAll');

    await page.waitForFunction(
      () => (document.getElementById('sendHint')?.textContent ?? '').includes('Отправлено'),
      undefined,
      { timeout: 15000 },
    );

    expect(adapter.applied).toEqual(['1']);
    expect(q.listByStatus('sent')).toHaveLength(1);
    expect(q.listByStatus('approved')).toHaveLength(0);
  }, 30000);

  it('второго подтверждения нет — после первого клика кнопка не ждёт ещё одного', async () => {
    // Здесь стояло подтверждение в два клика, и первый клик менял надпись на
    // «Точно отправить N? Нажми ещё раз». Владелец аккаунта его снял: решение
    // принимается на «Принять», и переспрашивать о том же на «Отправить всё»
    // означало выглядеть неработающей кнопкой.
    const id = seed('1', 80);
    q.approve(id, 'письмо');

    await open('approved');
    await page.click('#sendAll');
    await page.waitForFunction(
      () => (document.getElementById('sendHint')?.textContent ?? '').includes('Отправлено'),
      undefined,
      { timeout: 15000 },
    );

    // Ровно одна подача с одного клика.
    expect(adapter.applied).toHaveLength(1);
    const label = await page.textContent('#sendAll');
    expect(label).not.toMatch(/ещё раз/i);
  }, 30000);

  it('отправляет все одобренные строки, а не только первую', async () => {
    for (const sid of ['1', '2', '3']) q.approve(seed(sid, 80), 'письмо');

    await open('approved');
    await page.click('#sendAll');
    await page.waitForFunction(
      () => (document.getElementById('sendHint')?.textContent ?? '').includes('Отправлено'),
      undefined,
      { timeout: 15000 },
    );

    expect(adapter.applied.sort()).toEqual(['1', '2', '3']);
    expect(q.listByStatus('sent')).toHaveLength(3);
  }, 30000);
});

describe('панель в браузере — «Одобрить всё»', () => {
  it('одобряет ВСЁ, что лежит в ожидании, а не только со скором ≥ 75', async () => {
    // Порог был на кнопке, и вакансии со скором ниже он молча оставлял в
    // очереди — при том что очередь уже прошла minScore, core-гейт и три
    // жёстких фильтра на этапе поиска.
    seed('1', 90);
    seed('2', 50);
    seed('3', 41);

    await open('pending');
    await page.click('#approveAll');
    await page.waitForFunction(() => document.querySelectorAll('#list .card').length === 0,
      undefined, { timeout: 15000 });

    expect(q.listByStatus('approved')).toHaveLength(3);
    expect(q.listByStatus('pending')).toHaveLength(0);
  }, 30000);

  it('подхватывает правку письма из textarea, а не письмо из последней загрузки', async () => {
    seed('1', 50);

    await open('pending');
    await page.fill('#list .card textarea', 'правка руками');
    await page.click('#approveAll');
    await page.waitForFunction(() => document.querySelectorAll('#list .card').length === 0,
      undefined, { timeout: 15000 });

    expect(q.listByStatus('approved')[0]!.letter).toBe('правка руками');
  }, 30000);

  it('надпись на кнопке не обещает порога', async () => {
    await open('pending');
    const label = await page.textContent('#approveAll');
    expect(label?.trim()).toBe('Одобрить всё');
  }, 30000);
});


describe('панель в браузере — пустое письмо у одобренной заявки', () => {
  it('карточку видно как проблемную, и в неё МОЖНО вписать письмо руками', async () => {
    // Раньше здесь была только красная надпись, отсылавшая к кнопке, которой
    // не существовало, а вписать текст было некуда вообще.
    const id = seed('1', 80);
    q.approve(id, '');

    await open('approved');
    const warn = await page.textContent('#approvedList .letter-preview');
    expect(warn).toMatch(/ПИСЬМА НЕТ/);

    await page.fill('#approvedList .letter-edit', 'написал руками');
    await page.click('#approvedList [data-act="save"]');
    await page.waitForFunction(
      () => !/ПИСЬМА НЕТ/.test(document.querySelector('#approvedList .letter-preview')?.textContent ?? ''),
      undefined, { timeout: 15000 },
    );

    expect(q.listByStatus('approved')[0]!.letter).toBe('написал руками');
  }, 30000);

  it('вписанное руками письмо помечается режимом manual, а не выдаётся за сгенерированное', async () => {
    const id = seed('1', 80);
    q.approve(id, '');
    await open('approved');
    await page.fill('#approvedList .letter-edit', 'мой текст');
    await page.click('#approvedList [data-act="save"]');
    await page.waitForFunction(
      () => !/ПИСЬМА НЕТ/.test(document.querySelector('#approvedList .letter-preview')?.textContent ?? ''),
      undefined, { timeout: 15000 },
    );
    expect(q.listByStatus('approved')[0]!.letterMode).toBe('manual');
  }, 30000);

  it('у заявки С письмом поля для правки нет — одобренный текст не подменяют', async () => {
    const id = seed('1', 80);
    q.approve(id, 'письмо, которое человек утвердил');
    await open('approved');
    const visible = await page.isVisible('#approvedList .letter-edit');
    expect(visible).toBe(false);
  }, 30000);

  it('кнопка «Дописать письма» существует и действительно запускает генерацию', async () => {
    // Кнопка была обещана в тексте предупреждения и при этом отсутствовала.
    const id = seed('1', 80);
    q.approve(id, '');

    await open('approved');
    await page.click('#fillLetters');
    await page.waitForFunction(
      () => !/ПИСЬМА НЕТ/.test(document.querySelector('#approvedList .letter-preview')?.textContent ?? ''),
      undefined, { timeout: 20000 },
    );

    expect(fillCalls).toBe(1);
    expect(q.listByStatus('approved')[0]!.letter).toBe('дописанное письмо');
  }, 40000);

  it('кнопка есть и на вкладке «В ожидании»', async () => {
    seed('1', 80);
    await open('pending');
    expect(await page.isVisible('#fillLettersPending')).toBe(true);
  }, 30000);
});


describe('панель в браузере — новый пользователь без резюме', () => {
  it('по умолчанию «Добавьте своё первое резюме»; «Найти вакансии» не ищет, а ведёт к резюме', async () => {
    const q2 = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-new-')), 'test.db'));
    let searched = 0;
    const p2 = await startPanel(q2, 0, {
      startSearch: async () => { searched += 1; return { report: { found: 0, queued: 0 }, emptyLetters: 0 } as never; },
      settings: {
        get: () => freshSettings(),
        save: async (raw) => validateSettings(raw),
        suggest: async () => ({ ok: false, error: 'не нужен' }),
      },
    });
    try {
      await page.goto(`http://127.0.0.1:${p2.port}/#settings`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => { document.getElementById('tour')?.remove(); });
      await page.locator('.st-nav-item[data-sec="filters"]').click();
      await expect.poll(() => page.locator('#specEmpty').isVisible()).toBe(true);
      expect(await page.locator('#specList .spec').count()).toBe(0);

      await page.locator('#tab-pending').click();
      await page.click('#searchStart');
      await expect.poll(() => page.textContent('#searchNote')).toMatch(/Сначала добавь резюме/);
      expect(searched).toBe(0);
      await page.click('#searchNoteAddResume');
      await expect.poll(() => page.locator('#specList .spec').count()).toBe(1);
      expect(await page.locator('#pane-settings').isVisible()).toBe(true);
    } finally {
      await p2.close();
      q2.close();
    }
  });
});

describe('панель в браузере — кнопка «Войти в careerist»', () => {
  it('без ручки входа блок спрятан; с ней кнопка запускает вход и показывает ожидание', async () => {
    const q2 = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-cl-')), 'test.db'));
    const bare = await startPanel(q2, 0, {});
    try {
      await page.goto(`http://127.0.0.1:${bare.port}/#settings`, { waitUntil: 'domcontentloaded' });
      await expect.poll(() => page.locator('#careeristLoginBlock').isHidden()).toBe(true);
    } finally { await bare.close(); }

    let started = 0;
    const p2 = await startPanel(q2, 0, {
      careeristLogin: {
        start: () => { started += 1; return { ok: true }; },
        status: () => ({ state: started > 0 ? 'waiting' : 'idle', lastLoginAt: null, error: null }),
        running: () => started > 0,
      },
    });
    try {
      await page.goto(`http://127.0.0.1:${p2.port}/#settings`, { waitUntil: 'domcontentloaded' });
      await page.locator('.st-nav-item[data-sec="accounts"]').click();
      await expect.poll(() => page.textContent('#careeristLoginState')).toMatch(/Вход ещё не выполнен.*careerist/);
      await page.click('#careeristLoginBtn');
      await expect.poll(() => started).toBe(1);
      await expect.poll(() => page.textContent('#careeristLoginState')).toMatch(/Окно careerist\.ru открыто/);
      expect(await page.textContent('#careeristLoginBtn')).toMatch(/Показать окно входа/);
    } finally {
      await p2.close();
      q2.close();
    }
  });
});

describe('панель в браузере — уведомление про VPN', () => {
  /**
   * Панель поднимается своя, с подставленным ответом «где прокси»: настоящий
   * VPN трогать нельзя, а настоящий поиск лезет в netstat и реестр.
   */
  async function withPanel(proxyStatus: NonNullable<PanelDeps['proxyStatus']>, fn: (port: number) => Promise<void>) {
    const q2 = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-vpn-')), 'test.db'));
    const p2 = await startPanel(q2, 0, { proxyStatus });
    try {
      await fn(p2.port);
    } finally {
      await p2.close();
      q2.close();
    }
  }

  it('VPN выключен — на странице висит «требуется включить VPN»', async () => {
    await withPanel(async () => ({ found: null, checked: ['127.0.0.1:10809', '127.0.0.1:10801'] }), async (port) => {
      await page.goto(`http://127.0.0.1:${port}/#pending`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => {
          const w = document.getElementById('proxyWarn');
          return w !== null && w.style.display !== 'none' && /включить VPN/.test(w.textContent ?? '');
        },
        undefined, { timeout: 20000 },
      );
      const txt = await page.textContent('#proxyWarn');
      // Обязана сказать и то, что НЕ ломается: паника на ровном месте хуже
      // молчания, а поиск и отправка без прокси работают.
      expect(txt).toMatch(/письма/i);
      expect(txt).toMatch(/поиск/i);
      // Прокси ищется на каждое письмо, перезапуск не нужен. Раньше полоса
      // гнала перезапускать панель — теперь это был бы лишний шаг.
      expect(txt).not.toMatch(/Ctrl\+C|Панель\.cmd/);
    });
  }, 40000);

  it('прокси на месте — полосы нет', async () => {
    await withPanel(async () => ({
      found: { host: '127.0.0.1', port: 10809, source: 'windows' }, checked: ['127.0.0.1:10809'],
    }), async (port) => {
      await page.goto(`http://127.0.0.1:${port}/#pending`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      expect(await page.isVisible('#proxyWarn')).toBe(false);
    });
  }, 40000);
});

/** Раздел вкладки «Настройки» (меню слева): элементы других разделов скрыты. */
async function settingsSection(name: 'filters' | 'accounts' | 'telegram' | 'auto' | 'chat'): Promise<void> {
  await page.click(`#settingsNav [data-sec="${name}"]`);
}

/** Активная (видимая) карточка фильтра. */
const activeSpec = () => page.locator('#specList .spec:not([hidden])');

describe('вкладка «Настройки» в настоящем браузере', () => {
  let stored: Settings;
  let sp: { port: number; close(): Promise<void> };
  let suggestCalls: Array<{ name: string; resumePdf: string | null }>;

  beforeEach(async () => {
    stored = seedSettings(undefined, null);
    suggestCalls = [];
    sp = await startPanel(q, 0, {
      settings: {
        get: () => stored,
        save: async (raw) => { const r = validateSettings(raw); if (r.ok) stored = r.settings; return r; },
        suggest: async (name, resumePdf) => {
          suggestCalls.push({ name, resumePdf });
          return {
            ok: true,
            suggestion: {
              name: 'Продакт-менеджер',
              queries: ['менеджер продукта', 'product manager'],
              titleWords: ['менеджер продукта'],
              skills: [{ name: 'Роадмап', synonyms: ['роадмап'], weight: 25, core: true }],
              experienceYears: 4,
              salaryFrom: 180000,
            },
          };
        },
      },
    });
  });
  afterEach(async () => { await sp.close(); });

  it('правка веса навыка сохраняется: клик по тегу раскрывает редактор', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    const card = page.locator('.spec').first();
    // Редактор навыка скрыт, пока по тегу не кликнули.
    expect(await card.locator('.skill').first().isHidden()).toBe(true);
    await card.locator('.skill-tag-btn').first().click();
    const weight = card.locator('.skill').first().locator('[data-k="weight"]');
    await weight.fill('30');
    await card.locator('.skill').first().locator('.se-done').click();
    expect(await card.locator('.skill').first().isHidden()).toBe(true);
    await page.click('#settingsSave');
    await expect.poll(() => stored.specialties[0]!.skills[0]!.weight).toBe(30);
    await expect.poll(() => page.textContent('#settingsNote')).toMatch(/Сохранено/);
  });

  it('клик по чипу «Тип занятости» уходит в filters.employment, повторный клик снимает', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    const part = activeSpec().locator('.chips[data-group="employment"] .chip[data-v="PART"]');
    await part.click();
    expect(await part.getAttribute('aria-pressed')).toBe('true');
    await activeSpec().locator('.chips[data-group="workFormat"] .chip[data-v="REMOTE"]').click();
    await activeSpec().locator('.chips[data-group="schedule"] .chip[data-v="FIVE_ON_TWO_OFF"]').click();
    await activeSpec().locator('.chips[data-group="schedule"] .chip[data-v="FIVE_ON_TWO_OFF"]').click();
    await activeSpec().locator('[data-f="workingHours"]').selectOption('HOURS_8');
    await page.click('#settingsSave');
    await expect.poll(() => stored.specialties[0]!.filters?.employment).toEqual(['PART']);
    expect(stored.specialties[0]!.filters?.workFormat).toEqual(['REMOTE']);
    expect(stored.specialties[0]!.filters?.schedule).toEqual([]);
    expect(stored.specialties[0]!.filters?.workingHours).toBe('HOURS_8');
    // После перерисовки с ответа сервера чип остаётся выбранным.
    await expect.poll(() => part.getAttribute('aria-pressed')).toBe('true');
  });

  it('зарплата «От» сохраняется числом, пустое «До» — null, «Не указана» снимается', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await activeSpec().locator('[data-f="salaryFrom"]').fill('150 000');
    await activeSpec().locator('[data-f="includeNoSalary"]').uncheck();
    await page.click('#settingsSave');
    await expect.poll(() => stored.specialties[0]!.filters?.salaryFrom).toBe(150000);
    expect(stored.specialties[0]!.filters?.salaryTo).toBeNull();
    expect(stored.specialties[0]!.filters?.includeNoSalary).toBe(false);
    // Ждём перерисовку карточек с ответа сервера, иначе она сотрёт набранное ниже.
    await expect.poll(() => page.textContent('#settingsNote')).toMatch(/Сохранено/);
    expect(await activeSpec().locator('[data-f="salaryFrom"]').inputValue()).toBe('150 000');
    // Буквы в поле зарплаты не попадают вовсе.
    await activeSpec().locator('[data-f="salaryTo"]').pressSequentially('2x0');
    expect(await activeSpec().locator('[data-f="salaryTo"]').inputValue()).toBe('20');
  });

  it('навык добавляется через поле «Добавьте навык…» и Enter; повтор не добавляется', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    const before = stored.specialties[0]!.skills.length;
    const input = activeSpec().locator('.skill-input');
    await input.fill('Power BI');
    await input.press('Enter');
    await input.fill('power bi');
    await input.press('Enter');
    // Backspace в пустом поле ничего не удаляет.
    await input.press('Backspace');
    expect(await activeSpec().locator('.skill-tag').count()).toBe(before + 1);
    await page.click('#settingsSave');
    await expect.poll(() => stored.specialties[0]!.skills.length).toBe(before + 1);
    expect(stored.specialties[0]!.skills.at(-1)).toMatchObject({ name: 'Power BI', synonyms: ['Power BI'], weight: 10, core: false });
  });

  it('× на теге удаляет навык', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    const before = stored.specialties[0]!.skills.length;
    const firstName = stored.specialties[0]!.skills[0]!.name;
    await activeSpec().locator('.skill-tag .skill-del').first().click();
    await page.click('#settingsSave');
    await expect.poll(() => stored.specialties[0]!.skills.length).toBe(before - 1);
    expect(stored.specialties[0]!.skills.map((k) => k.name)).not.toContain(firstName);
  });

  it('«Заполнить с ИИ» заполняет должность, запросы, опыт, зарплату и навыки', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await page.click('#addSpec');
    const card = activeSpec();
    await card.locator('[data-f="resumePdf"]').fill('C:/cv/резюме.pdf');
    await card.locator('.suggest').click();
    await expect.poll(() => card.locator('[data-f="queries"]').inputValue()).toBe('менеджер продукта\nproduct manager');
    // Пустая должность — берётся предложенная; запрос ушёл с пустым именем.
    expect(suggestCalls.at(-1)).toEqual({ name: '', resumePdf: 'C:/cv/резюме.pdf' });
    expect(await card.locator('[data-f="name"]').inputValue()).toBe('Продакт-менеджер');
    expect(await card.locator('[data-f="experienceYears"]').inputValue()).toBe('4');
    expect(await card.locator('[data-f="salaryFrom"]').inputValue()).toBe('180 000');
    expect(await card.locator('[data-f="titleWords"]').inputValue()).toBe('менеджер продукта');
    expect(await card.locator('.skill-tag').count()).toBe(1);
    expect(await card.locator('.skill-tag.core').count()).toBe(1);
    // Пилюля переключателя подхватила новое название.
    expect(await page.locator('.spec-pill[aria-current="true"]').innerText()).toMatch(/Продакт-менеджер/);
    await page.click('#settingsSave');
    await expect.poll(() => stored.specialties.map((s) => s.name)).toContain('Продакт-менеджер');
    const saved = stored.specialties.find((s) => s.name === 'Продакт-менеджер')!;
    expect(saved.queries).toEqual(['менеджер продукта', 'product manager']);
    expect(saved.experienceYears).toBe(4);
    expect(saved.filters?.salaryFrom).toBe(180000);
  });

  it('«Заполнить с ИИ» не трогает уже вписанную должность и зарплату', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await page.click('#addSpec');
    const card = activeSpec();
    await card.locator('[data-f="name"]').fill('Менеджер продукта');
    await card.locator('[data-f="salaryFrom"]').fill('250000');
    await card.locator('.suggest').click();
    await expect.poll(() => card.locator('.skill [data-k="name"]').first().inputValue()).toBe('Роадмап');
    expect(await card.locator('[data-f="name"]').inputValue()).toBe('Менеджер продукта');
    // Ушёл с поля — разряды расставились пробелами; значение то же, что вписано руками.
    expect(await card.locator('[data-f="salaryFrom"]').inputValue()).toBe('250 000');
    expect(suggestCalls.at(-1)!.name).toBe('Менеджер продукта');
  });

  it('переключение фильтров: видна одна карточка, правка второй сохраняется во вторую', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    expect(stored.specialties.length).toBeGreaterThanOrEqual(2);
    await expect.poll(() => page.locator('.spec-pill').count()).toBe(stored.specialties.length);
    expect(await page.locator('#specList .spec:not([hidden])').count()).toBe(1);
    await page.locator('.spec-pill').nth(1).click();
    expect(await page.locator('.spec').nth(1).isVisible()).toBe(true);
    expect(await page.locator('.spec').nth(0).isVisible()).toBe(false);
    await activeSpec().locator('[data-f="name"]').fill('Аналитик данных');
    expect(await page.locator('.spec-pill').nth(1).innerText()).toMatch(/Аналитик данных/);
    await activeSpec().locator('.chips[data-group="contract"] .chip[data-v="GPH"]').click();
    await page.click('#settingsSave');
    await expect.poll(() => stored.specialties[1]!.name).toBe('Аналитик данных');
    expect(stored.specialties[1]!.filters?.contract).toEqual(['GPH']);
    expect(stored.specialties[0]!.filters?.contract).toEqual([]);
    // После сохранения остаёмся на том же фильтре.
    expect(await page.locator('.spec-pill[aria-current="true"]').innerText()).toMatch(/Аналитик данных/);
  });

  it('выключенный фильтр помечен в пилюле и сохраняется с enabled: false', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await activeSpec().locator('[data-f="enabled"]').uncheck();
    expect(await page.locator('.spec-pill').first().locator('.dot').count()).toBe(1);
    await page.click('#settingsSave');
    await expect.poll(() => stored.specialties[0]!.enabled).toBe(false);
  });

  it('ошибка про второй фильтр переключает на него', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await page.locator('.spec-pill').nth(1).click();
    await activeSpec().locator('[data-f="titleWords"]').fill('');
    await page.locator('.spec-pill').nth(0).click();
    await page.click('#settingsSave');
    await expect.poll(() => page.textContent('#settingsNote')).toMatch(/ключевое слово/);
    expect(await page.locator('.spec').nth(1).isVisible()).toBe(true);
    expect(await page.locator('.spec').nth(1).locator('[data-f="titleWords"]').isVisible()).toBe(true);
  });

  it('«Удалить» убирает карточку без системного диалога, «Вернуть» возвращает её', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    page.on('dialog', (d) => { throw new Error('неожиданный диалог: ' + d.message()); });
    const before = await page.locator('.spec').count();
    await page.click('#addSpec');
    await activeSpec().locator('[data-f="name"]').fill('Временное');
    await activeSpec().locator('.del-spec').click();
    await expect.poll(() => page.locator('.spec').count()).toBe(before);
    expect(await page.locator('.spec-pill').allTextContents()).not.toContain('Временное');
    expect(await page.locator('#specUndo').isVisible()).toBe(true);
    await page.click('#specUndoBtn');
    await expect.poll(() => page.locator('.spec').count()).toBe(before + 1);
    expect(await activeSpec().locator('[data-f="name"]').inputValue()).toBe('Временное');
    expect(await page.locator('#specUndo').isVisible()).toBe(false);
  });

  it('удалил последнее резюме — карточки нет, вместо неё призыв добавить первое', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await page.waitForSelector('#specList .spec');
    expect(await page.locator('#specEmpty').isVisible()).toBe(false);
    for (let n = await page.locator('.spec').count(); n > 0; n--) await activeSpec().locator('.del-spec').click();
    expect(await page.locator('.spec').count()).toBe(0);
    expect(await page.locator('#specEmpty').isVisible()).toBe(true);
    expect(await page.textContent('#specEmpty')).toMatch(/Добавьте своё первое резюме/);
    expect(await page.locator('.spec-switch').isVisible()).toBe(false);
    await page.click('#specEmptyAdd');
    expect(await page.locator('.spec').count()).toBe(1);
    expect(await page.locator('#specEmpty').isVisible()).toBe(false);
    expect(await activeSpec().locator('[data-f="name"]').evaluate((e) => e === document.activeElement)).toBe(true);
  });

  it('индикатор несохранённых изменений и «Сбросить» с подтверждением', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await page.waitForSelector('#specList .spec');
    expect(await page.locator('#settingsDirty').isHidden()).toBe(true);
    expect(await page.isDisabled('#settingsReset')).toBe(true);
    const original = await page.inputValue('#stopWords');
    await page.fill('#stopWords', 'вахта');
    expect(await page.locator('#settingsDirty').isVisible()).toBe(true);
    // Вернул как было — изменений снова нет.
    await page.fill('#stopWords', original);
    expect(await page.locator('#settingsDirty').isHidden()).toBe(true);

    await activeSpec().locator('.chips[data-group="employment"] .chip[data-v="FULL"]').click();
    expect(await page.locator('#settingsDirty').isVisible()).toBe(true);
    page.once('dialog', (d) => { void d.accept(); });
    await page.click('#settingsReset');
    await expect.poll(() => page.locator('#settingsDirty').isHidden()).toBe(true);
    expect(await activeSpec().locator('.chips[data-group="employment"] .chip[data-v="FULL"]').getAttribute('aria-pressed')).toBe('false');

    // После сохранения индикатор гаснет.
    await page.fill('#stopWords', 'вахта');
    await page.click('#settingsSave');
    await expect.poll(() => page.textContent('#settingsNote')).toMatch(/Сохранено/);
    expect(await page.locator('#settingsDirty').isHidden()).toBe(true);
  });

  it('разделы: меню переключает блоки, выбранный раздел помнится после перезагрузки', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    expect(await page.locator('#stopBlock').isVisible()).toBe(true);
    expect(await page.locator('#profileBlock').isVisible()).toBe(true);
    await settingsSection('accounts');
    // #hhLoginBlock здесь не проверяем: без ручки входа (стенд без hhLogin) он прячется сам.
    for (const id of ['#llmBlock', '#captchaBlock']) {
      expect(await page.locator(id).isVisible(), id).toBe(true);
    }
    expect(await page.locator('#specList').isVisible()).toBe(false);
    await page.reload();
    await expect.poll(() => page.locator('#llmBlock').isVisible()).toBe(true);
    await settingsSection('chat');
    for (const id of ['#secretaryBlock', '#calendarBlock', '#followupsBlock', '#hhInboxBlock']) {
      expect(await page.locator(id).isVisible(), id).toBe(true);
    }
    // Кнопка сохранения в липком подвале видна из любого раздела.
    expect(await page.locator('#settingsSave').isVisible()).toBe(true);
  });

  it('тур онбординга: у опытного пользователя каждый шаг настроек подсвечивает свою цель, а не запасную', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await page.waitForSelector('#specList .spec');
    await page.click('#tourStart');
    const missed = await page.evaluate(async () => {
      // const/функции верхнего уровня классического скрипта видны из evaluate по имени.
      // eslint-disable-next-line no-eval
      const steps = eval('TOUR_STEPS') as Array<{ target?: string; tab?: string }>;
      // eslint-disable-next-line no-eval
      const go = eval('goTour') as (i: number) => Promise<void>;
      const bad: string[] = [];
      for (const [i, step] of steps.entries()) {
        // #hhLoginBlock прячется сам, когда у панели нет ручки входа (как на этом стенде): там шаг берёт запасную цель.
        if (step.tab !== 'settings' || !step.target || step.target.startsWith('#hhLoginBlock')) continue;
        await go(i);
        // eslint-disable-next-line no-eval
        const el = eval('tourTargetEl') as Element | null;
        if (!el || !el.matches(step.target) || el.getClientRects().length === 0) bad.push(step.target);
      }
      return bad;
    });
    expect(missed).toEqual([]);
  });

  it('тур не трогает выбранный раздел: прерван — раздел прежний, пройден до конца — «Аккаунты и ключи»', async () => {
    const SECTION_KEY = 'jobAutoapply.settingsSection.v1';
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await page.waitForSelector('#specList .spec');
    await settingsSection('telegram');
    await page.click('#tourStart');
    // Листаем все шаги: шаги настроек сами открывают свои разделы.
    await page.evaluate(async () => {
      // eslint-disable-next-line no-eval
      const steps = eval('TOUR_STEPS') as unknown[];
      // eslint-disable-next-line no-eval
      const go = eval('goTour') as (i: number) => Promise<void>;
      for (let i = 0; i < steps.length - 1; i++) await go(i);
    });
    await page.click('#tour .tour-skip');
    expect(await page.locator('#tour').count()).toBe(0);
    expect(await page.evaluate((k) => localStorage.getItem(k), SECTION_KEY)).toBe('telegram');
    expect(await page.locator('#settingsNav [data-sec="telegram"]').getAttribute('aria-selected')).toBe('true');

    // До конца: последний шаг зовёт к ключу и входу в hh.ru — открыт их раздел.
    await page.click('#tourStart');
    await page.evaluate(async () => {
      // eslint-disable-next-line no-eval
      const steps = eval('TOUR_STEPS') as unknown[];
      // eslint-disable-next-line no-eval
      await (eval('goTour') as (i: number) => Promise<void>)(steps.length - 1);
    });
    await page.click('#tour .tour-next');
    await expect.poll(() => page.locator('#llmBlock').isVisible()).toBe(true);
    expect(await page.evaluate((k) => localStorage.getItem(k), SECTION_KEY)).toBe('telegram');
  });

  it('повтор названия: открывается НОВЫЙ фильтр, который и надо переименовать', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await page.waitForSelector('#specList .spec');
    const first = stored.specialties[0]!.name;
    await page.click('#addSpec');
    await activeSpec().locator('[data-f="name"]').fill(first);
    const newIdx = (await page.locator('#specList .spec').count()) - 1;
    await page.locator('.spec-pill').nth(0).click();
    await page.click('#settingsSave');
    await expect.poll(() => page.textContent('#settingsNote')).toMatch(/повтор названия/);
    expect(await page.locator('#specList .spec').nth(newIdx).isVisible()).toBe(true);
    expect(await page.locator('#specList .spec').nth(0).isVisible()).toBe(false);
  });

  it('ответ ИИ, пришедший после сохранения формы, не теряется молча', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await sp.close();
    sp = await startPanel(q, 0, {
      settings: {
        get: () => stored,
        save: async (raw) => { const r = validateSettings(raw); if (r.ok) stored = r.settings; return r; },
        suggest: async () => {
          await gate;
          return { ok: true, suggestion: { name: null, queries: ['q'], titleWords: ['w'], skills: [{ name: 'S', synonyms: ['s'], weight: 1, core: false }], experienceYears: 2, salaryFrom: null } };
        },
      },
    });
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await page.waitForSelector('#specList .spec');
    await activeSpec().locator('.suggest').click();
    await page.click('#settingsSave');
    await expect.poll(() => page.textContent('#settingsNote')).toMatch(/Сохранено/);
    release();
    await expect.poll(() => page.textContent('#settingsNote')).toMatch(/не подставлен/);
  });

  it('телефон: подвал с несохранёнными изменениями — одна строка', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await page.waitForSelector('#specList .spec');
    await activeSpec().locator('[data-f="name"]').fill('x');
    expect(await page.locator('#settingsDirty').isVisible()).toBe(true);
    const footer = await page.locator('#pane-settings .st-footer').boundingBox();
    expect(footer!.height).toBeLessThan(90);
    const save = await page.locator('#settingsSave').boundingBox();
    const reset = await page.locator('#settingsReset').boundingBox();
    expect(Math.abs(save!.y - reset!.y)).toBeLessThan(2);
  });

  it('узкий экран: меню разделов сверху, горизонтальной прокрутки у вкладки нет', async () => {
    await page.setViewportSize({ width: 600, height: 900 });
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await page.waitForSelector('#specList .spec');
    const nav = await page.locator('#settingsNav').boundingBox();
    const main = await page.locator('#pane-settings .st-main').boundingBox();
    expect(main!.y).toBeGreaterThan(nav!.y + nav!.height - 1);
    const overflow = await page.evaluate(() => {
      const pane = document.getElementById('pane-settings')!;
      return [...pane.querySelectorAll('*')].filter((e) => {
        const el = e as HTMLElement;
        return el.offsetParent !== null && el.getBoundingClientRect().right > pane.clientWidth + 1;
      }).length;
    });
    expect(overflow).toBe(0);
  });

  it('стоп-слово добавляется через поле списка', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await page.fill('#stopWords', '1С\nБитрикс\nBitrix\nвахта');
    await page.click('#settingsSave');
    await expect.poll(() => stored.stopWords).toEqual(['1С', 'Битрикс', 'Bitrix', 'вахта']);
  });

  it('новая специальность: «Предложить» заполняет, сохранение с названием', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await page.click('#addSpec');
    const card = page.locator('.spec').last();
    await card.locator('[data-f="name"]').fill('Менеджер продукта');
    await card.locator('.suggest').click();
    await expect.poll(() => card.locator('.skill [data-k="name"]').first().inputValue()).toBe('Роадмап');
    await page.click('#settingsSave');
    await expect.poll(() => stored.specialties.map((s) => s.name)).toContain('Менеджер продукта');
    expect(stored.specialties.at(-1)!.legacyLetters).toBe(false);
  });

  it('ошибка проверки показывается человеку, а не глотается', async () => {
    await page.goto(`http://127.0.0.1:${sp.port}/#settings`);
    await page.locator('.spec').first().locator('[data-f="name"]').fill('');
    await page.click('#settingsSave');
    await expect.poll(() => page.textContent('#settingsNote')).toMatch(/название/);
  });
});

describe('Telegram во вкладке «Настройки»', () => {
  const CHATS = [
    { id: '-1001', title: 'Работа в ИТ', username: 'workayte', kind: 'channel' as const },
    { id: '-1002', title: 'Закрытый чат аналитиков', username: null, kind: 'group' as const },
  ];
  let stored: Settings;
  let tp: { port: number; close(): Promise<void> };

  beforeEach(async () => {
    stored = seedSettings(undefined, null);
    stored.autoApply = { enabled: true, minScore: 60 };
    tp = await startPanel(q, 0, {
      settings: {
        get: () => stored,
        save: async (raw) => { const r = validateSettings(raw); if (r.ok) stored = r.settings; return r; },
        suggest: async () => ({ ok: false, error: 'не нужен' }),
      },
      telegram: {
        dialogs: async () => ({ ok: true, chats: CHATS }),
        resolve: async (ref) => (ref === '@нет' ? { ok: false, error: 'канал не найден' } : { ok: true, chat: CHATS[0]! }),
      },
    });
  });
  afterEach(async () => { await tp.close(); });

  it('«Выбрать из моих чатов» добавляет отмеченное, сохранение кладёт чаты в настройки', async () => {
    await page.goto(`http://127.0.0.1:${tp.port}/#settings`);
    await settingsSection('telegram');
    await page.click('#tgPick');
    await page.locator('#tgPicker input[data-i="1"]').check();
    await page.click('#tgPickAdd');
    await page.fill('#tgDays', '7');
    await page.click('#settingsSave');
    await expect.poll(() => stored.telegram.chats.map((c) => c.id)).toEqual(['-1002']);
    expect(stored.telegram.firstReadDays).toBe(7);
  });

  it('ошибка «Добавить» показывается человеку', async () => {
    await page.goto(`http://127.0.0.1:${tp.port}/#settings`);
    await settingsSection('telegram');
    await page.fill('#tgRef', '@нет');
    await page.click('#tgAdd');
    await expect.poll(() => page.textContent('#tgNote')).toMatch(/канал не найден/);
  });

  it('включение автоотклика — только через подтверждение; отказ оставляет выключенным', async () => {
    stored.autoApply = { enabled: false, minScore: null };
    await page.goto(`http://127.0.0.1:${tp.port}/#settings`);
    await settingsSection('auto');
    expect(await page.locator('#autoBanner').isHidden()).toBe(true);

    page.once('dialog', (d) => { void d.dismiss(); });
    await page.locator('#autoApply').click();
    await expect.poll(() => page.locator('#autoApply').isChecked()).toBe(false);

    page.once('dialog', (d) => {
      expect(d.message()).toMatch(/без твоего просмотра/);
      void d.accept();
    });
    await page.locator('#autoApply').click();
    await page.fill('#autoMinScore', '55');
    await page.click('#settingsSave');
    await expect.poll(() => stored.autoApply).toEqual({ enabled: true, minScore: 55 });
    await expect.poll(() => page.locator('#autoBanner').isVisible()).toBe(true);
  });

  it('вкладка «Отправлено» помечает отправленное автооткликом', async () => {
    q.insertPending(normalizeVacancy({
      source: 'tg', sourceId: '-1001:9', title: 'Системный аналитик', company: '', url: 'https://t.me/x/9',
      description: 'd', geo: '', postedAt: '2026-09-19T00:00:00Z', contact: 'hr_a',
    }), 70, [], 'Здравствуйте!', 'dm');
    const row = q.listByStatus('pending').find((r) => r.sourceId === '-1001:9')!;
    q.approve(row.id, undefined, 'auto');
    q.markSent(row.id);

    await page.goto(`http://127.0.0.1:${tp.port}/#sent`);
    await expect.poll(() => page.locator('#sentList .card').count()).toBe(1);
    expect(await page.locator('#sentList .card .meta').innerText()).toMatch(/АВТО.*@hr_a/);
  });

  it('сохранение специальностей не трогает автоотклик', async () => {
    await page.goto(`http://127.0.0.1:${tp.port}/#settings`);
    await page.locator('.spec').first().locator('.skill-tag-btn').first().click();
    await page.locator('.spec').first().locator('.skill').first().locator('[data-k="weight"]').fill('29');
    await page.click('#settingsSave');
    await expect.poll(() => stored.specialties[0]!.skills[0]!.weight).toBe(29);
    expect(stored.autoApply).toEqual({ enabled: true, minScore: 60 });
  });
});


describe('панель в браузере — отправка без письма', () => {
  const sendDone = (): Promise<unknown> => page.waitForFunction(
    () => (document.getElementById('sendHint')?.textContent ?? '').includes('Отправлено'),
    undefined, { timeout: 15000 },
  );

  /** Подтверждение ловится слушателем: без него Playwright молча отвечает «Отмена». */
  function onDialog(answer: 'accept' | 'dismiss'): { messages: string[] } {
    const seen = { messages: [] as string[] };
    page.once('dialog', (d) => {
      seen.messages.push(d.message());
      void (answer === 'accept' ? d.accept() : d.dismiss());
    });
    return seen;
  }

  it('есть заявка без письма — перед отправкой предупреждение, и «Отмена» не отправляет ничего', async () => {
    q.approve(seed('1', 80), '');

    await open('approved');
    const dlg = onDialog('dismiss');
    await page.click('#sendAll');
    await expect.poll(() => dlg.messages.length).toBe(1);

    expect(dlg.messages[0]).toMatch(/БЕЗ сопроводительного письма/);
    expect(dlg.messages[0]).toMatch(/У 1 из 1/);
    // Ждём, чтобы убедиться: после отмены отправка не стартует задним числом.
    await page.waitForTimeout(800);
    expect(adapter.applied).toEqual([]);
    expect(q.listByStatus('approved')).toHaveLength(1);
    expect(await page.isDisabled('#sendAll')).toBe(false);
    expect(await page.isVisible('#sendStop')).toBe(false);
  }, 30000);

  it('«ОК» отправляет без письма: apply получил пустое письмо, в итоге названо «БЕЗ ПИСЬМА»', async () => {
    q.approve(seed('1', 80), '');

    await open('approved');
    onDialog('accept');
    await page.click('#sendAll');
    await sendDone();

    expect(adapter.applied).toEqual(['1']);
    expect(adapter.letters).toEqual(['']);
    expect(q.listByStatus('sent')).toHaveLength(1);
    expect(await page.textContent('#sendHint')).toMatch(/Отправлено 1, из них БЕЗ ПИСЬМА 1/);
  }, 30000);

  it('часть заявок с письмом, часть без: в предупреждении считаются только пустые, уходят все', async () => {
    q.approve(seed('1', 80), 'настоящее письмо');
    q.approve(seed('2', 70), '');
    q.approve(seed('3', 60), '   ');

    await open('approved');
    const dlg = onDialog('accept');
    await page.click('#sendAll');
    await sendDone();

    expect(dlg.messages[0]).toMatch(/У 2 из 3/);
    expect(adapter.applied.sort()).toEqual(['1', '2', '3']);
    expect([...adapter.letters].sort()).toEqual(['', '', 'настоящее письмо'].sort());
    expect(await page.textContent('#sendHint')).toMatch(/Отправлено 3, из них БЕЗ ПИСЬМА 2/);
  }, 30000);

  it('у всех заявок есть письма — никакого предупреждения, отправка как раньше', async () => {
    q.approve(seed('1', 80), 'письмо');

    await open('approved');
    let asked = 0;
    page.on('dialog', (d) => { asked++; void d.dismiss(); });
    await page.click('#sendAll');
    await sendDone();

    expect(asked).toBe(0);
    expect(adapter.letters).toEqual(['письмо']);
    expect(await page.textContent('#sendHint')).not.toMatch(/БЕЗ ПИСЬМА/);
  }, 30000);

  it('Telegram без текста: предупреждение говорит, что такие не уйдут вовсе', async () => {
    q.approve(seed('1', 80), '');
    q.insertPending(normalizeVacancy({
      source: 'tg', sourceId: '-1001:5', title: 'Аналитик', company: '', url: 'https://t.me/x/5',
      description: 'd', geo: '', postedAt: '2026-09-19T00:00:00Z', contact: 'hr_x',
    }), 70, [], '', 'none');
    const tgRow = q.listByStatus('pending').find((r) => r.sourceId === '-1001:5')!;
    q.approve(tgRow.id, '');

    await open('approved');
    const dlg = onDialog('dismiss');
    await page.click('#sendAll');
    await expect.poll(() => dlg.messages.length).toBe(1);

    expect(dlg.messages[0]).toMatch(/У 1 из 2/);
    expect(dlg.messages[0]).toMatch(/Telegram/);
    expect(adapter.applied).toEqual([]);
  }, 30000);

  it('карточка без письма больше не обещает «не отправится» — говорит, как оно уйдёт', async () => {
    q.approve(seed('1', 80), '');
    await open('approved');
    const txt = await page.textContent('#approvedList .letter-preview');
    expect(txt).toMatch(/ПИСЬМА НЕТ/);
    expect(txt).not.toMatch(/не отправится/);
    expect(txt).toMatch(/без письма/i);
    // Тот же обман жил в подсказке поля ввода.
    expect(await page.getAttribute('#approvedList .letter-edit', 'placeholder')).not.toMatch(/не отправится/);
  }, 30000);
});

describe('панель в браузере — кнопки «Остановить»', () => {
  const STOP_BUTTONS = ['#searchStop', '#sendStop', '#stopLetters', '#stopLettersPending'];

  async function withPanel(deps: PanelDeps, fn: (port: number, queue: Queue) => Promise<void>): Promise<void> {
    const q2 = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-stop-')), 'test.db'));
    const p2 = await startPanel(q2, 0, deps);
    try { await fn(p2.port, q2); } finally { await p2.close(); q2.close(); }
  }
  const waitAbort = (signal: AbortSignal): Promise<void> => new Promise((r) => {
    if (signal.aborted) r();
    else signal.addEventListener('abort', () => r());
  });

  it('пока ничего не идёт, ни одной кнопки «Остановить» не видно', async () => {
    await open('pending');
    for (const sel of STOP_BUTTONS) expect(await page.locator(sel).isVisible(), sel).toBe(false);
    await open('approved');
    for (const sel of STOP_BUTTONS) expect(await page.locator(sel).isVisible(), sel).toBe(false);
  }, 30000);

  it('поиск: «Остановить поиск» появляется, нажатие останавливает, итог называет остановку, поиск можно запустить снова', async () => {
    let seen: AbortSignal | undefined;
    await withPanel({
      startSearch: async (_limit, signal) => {
        seen = signal;
        await waitAbort(signal);
        return { report: { found: 12, queued: 3, stoppedBecause: 'stopped' }, emptyLetters: 0 };
      },
    }, async (port) => {
      await page.goto(`http://127.0.0.1:${port}/#pending`);
      await page.click('#searchStart');
      await page.locator('#searchStop').waitFor({ state: 'visible', timeout: 10000 });
      expect(await page.isDisabled('#searchStart')).toBe(true);

      await page.click('#searchStop');
      expect(await page.textContent('#searchStop')).toMatch(/Останавливаю/);
      expect(await page.isDisabled('#searchStop')).toBe(true);
      await expect.poll(() => seen?.aborted).toBe(true);

      await page.waitForFunction(
        () => (document.getElementById('searchNote')?.textContent ?? '').includes('ПОИСК ОСТАНОВЛЕН'),
        undefined, { timeout: 15000 },
      );
      const note = await page.textContent('#searchNote');
      expect(note).toMatch(/просмотрено 12/);
      expect(note).toMatch(/в очередь 3/);
      expect(await page.isVisible('#searchStop')).toBe(false);
      expect(await page.isDisabled('#searchStart')).toBe(false);
    });
  }, 40000);

  it('письма: стоп есть на обеих вкладках, нажатие останавливает, итог называет остановку', async () => {
    let seen: AbortSignal | undefined;
    await withPanel({
      fillLetters: async (signal) => {
        seen = signal;
        await waitAbort(signal);
        return { found: 4, filled: 1, stopped: true as const };
      },
    }, async (port, queue) => {
      // «Дописать письма» живая только когда есть что дописывать — кладём заявку без письма.
      queue.insertPending(normalizeVacancy({
        source: 'hh', sourceId: 'L1', title: 'Бизнес-аналитик', company: 'C', url: 'https://hh.ru/vacancy/L1',
        description: 'd', geo: 'Москва', postedAt: '2026-08-20T00:00:00Z',
      }), 70, [], '', 'none');
      queue.approve(queue.listByStatus('pending')[0]!.id, '');

      await page.goto(`http://127.0.0.1:${port}/#approved`);
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('#fillLetters')?.disabled === false);
      await page.click('#fillLetters');

      await page.locator('#stopLetters').waitFor({ state: 'visible', timeout: 10000 });
      // На соседней вкладке та же кнопка тоже появилась.
      await page.click('#tab-pending');
      expect(await page.locator('#stopLettersPending').isVisible()).toBe(true);

      await page.click('#stopLettersPending');
      await expect.poll(() => seen?.aborted).toBe(true);
      await page.waitForFunction(
        () => (document.getElementById('lettersHint')?.textContent ?? '').includes('Остановлено'),
        undefined, { timeout: 15000 },
      );
      expect(await page.textContent('#lettersHint')).toMatch(/заполнено 1 из 4/);
      expect(await page.isVisible('#stopLettersPending')).toBe(false);
      await page.click('#tab-approved');
      expect(await page.isVisible('#stopLetters')).toBe(false);
    });
  }, 40000);

  it('отправка: «Остановить отправку» появляется со стартом; стоп — текущая подача доезжает, остальные остаются одобренными', async () => {
    for (const [sid, score] of [['1', 90], ['2', 80], ['3', 70]] as const) q.approve(seed(sid, score), 'письмо');
    let release!: () => void;
    adapter.hold = new Promise<void>((r) => { release = r; });

    await open('approved');
    await page.click('#sendAll');
    await page.locator('#sendStop').waitFor({ state: 'visible', timeout: 10000 });
    await expect.poll(() => adapter.applied.length).toBe(1);

    await page.click('#sendStop');
    expect(await page.textContent('#sendStop')).toMatch(/Останавливаю/);
    expect(await page.isDisabled('#sendStop')).toBe(true);

    release();
    await page.waitForFunction(
      () => (document.getElementById('sendHint')?.textContent ?? '').includes('Отправлено'),
      undefined, { timeout: 15000 },
    );
    const hint = await page.textContent('#sendHint');
    expect(hint).toMatch(/Отправлено 1/);
    expect(hint).toMatch(/остановлено вручную/);

    expect(adapter.applied).toEqual(['1']);
    expect(q.listByStatus('sent')).toHaveLength(1);
    expect(q.listByStatus('approved')).toHaveLength(2);
    expect(await page.isVisible('#sendStop')).toBe(false);
    expect(await page.isDisabled('#sendAll')).toBe(false);
  }, 40000);

  it('страница, открытая посреди отправки, сразу показывает «Остановить отправку»', async () => {
    for (const sid of ['1', '2']) q.approve(seed(sid, 80), 'письмо');
    let release!: () => void;
    adapter.hold = new Promise<void>((r) => { release = r; });

    await open('approved');
    await page.click('#sendAll');
    await expect.poll(() => adapter.applied.length).toBe(1);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#sendStop').waitFor({ state: 'visible', timeout: 10000 });
    release();
    await page.waitForFunction(
      () => (document.getElementById('sendHint')?.textContent ?? '').includes('Отправлено'),
      undefined, { timeout: 15000 },
    );
  }, 40000);
});

describe('единый дизайн панели (2026-11-20): адаптив, тур, экранирование', () => {
  const TABS = ['pending', 'approved', 'skipped', 'sent', 'dialogs', 'settings'] as const;

  /** Своя панель: «опытный» (резюме, вакансии во всех статусах, длинные названия) или «новичок» (ничего нет). */
  async function withPanel(kind: 'filled' | 'fresh', fn: (port: number) => Promise<void>): Promise<void> {
    const q2 = new Queue(join(mkdtempSync(join(tmpdir(), 'jaa-ui-')), 'test.db'));
    let stored: Settings = kind === 'filled' ? seedSettings(undefined, null) : freshSettings();
    if (kind === 'filled') {
      const add = (sid: string, title: string, score: number, source = 'hh', contact?: string): number => {
        q2.insertPending(normalizeVacancy({
          source, sourceId: sid, title, company: 'ООО «Очень Длинное Название Компании Для Проверки Переноса»',
          url: source === 'tg' ? `https://t.me/x/${sid}` : `https://hh.ru/vacancy/${sid}`,
          description: 'описание '.repeat(200), geo: 'Москва', postedAt: '2026-11-18T00:00:00Z', contact,
        }), score, ['BPMN', 'SQL', 'REST API', 'Требования к интеграциям'], 'письмо '.repeat(80), 'hybrid');
        return q2.idOf(source, sid)!;
      };
      const long = 'Ведущий бизнес-аналитик / Business Analyst в команду платформы расчётов для малого и среднего бизнеса';
      add('p1', long, 86);
      add('p2', 'Системный аналитик', 55);
      add('p3', 'Аналитик', 20);
      add('-1:1', 'Аналитик в Telegram', 72, 'tg', 'hr_anna');
      q2.approve(add('a1', long + ' (одобрено)', 80), 'письмо');
      q2.approve(add('a2', 'Без письма', 60), '');
      q2.skip(add('s1', long + ' (пропущено)', 45));
      const sent = add('d1', long + ' (отправлено)', 77);
      q2.approve(sent, undefined, 'auto');
      q2.markSent(sent);
    }
    const p2 = await startPanel(q2, 0, {
      settings: {
        get: () => stored,
        save: async (raw) => { const r = validateSettings(raw); if (r.ok) stored = r.settings; return r; },
        suggest: async () => ({ ok: false, error: 'не нужен' }),
      },
    });
    try { await fn(p2.port); } finally { await p2.close(); q2.close(); }
  }

  for (const kind of ['filled', 'fresh'] as const) {
    const who = kind === 'filled' ? 'заполненная очередь' : 'новый пользователь: нет резюме, пустая очередь';

    it(`390px (${who}): ни на одной вкладке нет горизонтальной прокрутки страницы`, async () => {
      await withPanel(kind, async (port) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`http://127.0.0.1:${port}/#pending`);
        await page.waitForFunction(() => document.querySelectorAll('#list .card, #list .empty').length > 0);
        const wide: string[] = [];
        for (const t of TABS) {
          await page.click(`#tab-${t}`);
          await page.waitForTimeout(150);
          const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
          if (r.sw > r.iw) wide.push(`${t}: ${r.sw} > ${r.iw}`);
          // Выбранная вкладка видна в своей полосе, а не уехала за край экрана.
          const tab = await page.locator(`#tab-${t}`).boundingBox();
          expect(tab!.x, t).toBeGreaterThanOrEqual(-1);
          expect(tab!.x + tab!.width, t).toBeLessThanOrEqual(391);
        }
        expect(wide).toEqual([]);
        if (kind === 'filled') {
          // Карточка вакансии на телефоне — в одну колонку: письмо под описанием.
          await page.click('#tab-pending');
          const card = page.locator('#list .card').first();
          const main = await card.locator('.card-main').boundingBox();
          const side = await card.locator('.card-side').boundingBox();
          expect(side!.y).toBeGreaterThan(main!.y + main!.height - 1);
        }
      });
    }, 40000);

    it(`тур проходит все шаги без ошибок (${who}), каждый шаг с целью подсвечивает видимый элемент`, async () => {
      await withPanel(kind, async (port) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
          await page.goto(`http://127.0.0.1:${port}/#pending`);
          await page.waitForFunction(() => document.querySelectorAll('#list .card, #list .empty').length > 0);
          await page.click('#tourStart');
          const report = await page.evaluate(async () => {
            // eslint-disable-next-line no-eval
            const steps = eval('TOUR_STEPS') as Array<{ target?: string }>;
            // eslint-disable-next-line no-eval
            const go = eval('goTour') as (i: number) => Promise<void>;
            const bad: string[] = [];
            let highlighted = 0;
            for (let i = 0; i < steps.length; i++) {
              await go(i);
              if (!document.getElementById('tour')) { bad.push(`${i + 1}: тур закрылся`); break; }
              // eslint-disable-next-line no-eval
              const el = eval('tourTargetEl') as Element | null;
              const spot = document.querySelector('#tour .tour-spot')!;
              const card = document.querySelector('#tour .tour-card')!;
              if ((document.querySelector('#tour .tour-text')!.textContent ?? '').trim() === '') bad.push(`${i + 1}: пустой текст`);
              if (!steps[i]!.target) continue;
              if (el === null) {
                // Цели нет (новичок без резюме) — карточка по центру, без «окна».
                if (!card.classList.contains('center') || !spot.classList.contains('none')) bad.push(`${i + 1}: нет цели, но карточка не по центру`);
                continue;
              }
              highlighted++;
              const r = el.getBoundingClientRect();
              if (el.getClientRects().length === 0 || r.width === 0 || r.height === 0) bad.push(`${i + 1}: цель невидима`);
              if (spot.classList.contains('none')) bad.push(`${i + 1}: цель есть, а «окна» нет`);
            }
            return { bad, highlighted, total: steps.length };
          });
          expect(report.bad, `ширина ${width}`).toEqual([]);
          expect(report.highlighted).toBeGreaterThan(report.total / 2);
          // Последний шаг закрывает тур и открывает «Аккаунты и ключи».
          await page.click('#tour .tour-next');
          expect(await page.locator('#tour').count()).toBe(0);
          await expect.poll(() => page.locator('#llmBlock').isVisible()).toBe(true);
        }
        expect(errors).toEqual([]);
      });
    }, 60000);
  }

  it('обновлённое обучение покажется и тем, кто прошёл старое: ключ тура — .v2', async () => {
    await open('pending');
    // eslint-disable-next-line no-eval
    expect(await page.evaluate(() => eval('TOUR_KEY') as string)).toBe('jobAutoapply.onboardingDone.v2');
  }, 30000);

  it('название вакансии экранируется: <img onerror> в заголовке не становится элементом', async () => {
    const evil = '<img src=x onerror="window.__pwned=1">Аналитик';
    q.insertPending(normalizeVacancy({
      source: 'hh', sourceId: 'x1', title: evil, company: '<b>Злая</b> компания', geo: '<i>Москва</i>',
      url: 'javascript:alert(1)', description: 'd', postedAt: '2026-11-18T00:00:00Z',
    }), 50, ['<u>навык</u>'], 'письмо', 'hybrid');
    q.insertPending(normalizeVacancy({
      source: 'hh', sourceId: 'x2', title: evil, company: 'C', geo: 'G', url: 'https://hh.ru/vacancy/x2',
      description: 'd', postedAt: '2026-11-18T00:00:00Z',
    }), 50, [], 'письмо', 'hybrid');
    q.skip(q.idOf('hh', 'x2')!);
    await open('pending');
    await expect.poll(() => page.locator('#skippedList .card').count()).toBe(1);
    for (const sel of ['#list', '#skippedList']) {
      expect(await page.locator(`${sel} img`).count(), sel).toBe(0);
      expect(await page.locator(`${sel} .card a.title`).first().textContent(), sel).toBe(evil);
    }
    expect(await page.locator('#list .card b, #list .card i, #list .card u').count()).toBe(0);
    // Из чужого текста кликается только http(s): javascript:-ссылка не становится ссылкой.
    expect(await page.locator('#list .card a.title').getAttribute('href')).toBe('#');
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  }, 30000);

  it('вкладка из адреса видна целиком и при загрузке: прокрутку полосы считают после вставки иконок', async () => {
    await withPanel('filled', async (port) => {
      for (const width of [390, 900, 1000]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto('about:blank');
        await page.goto(`http://127.0.0.1:${port}/#settings`);
        await page.waitForFunction(() => document.querySelectorAll('#list .card').length > 0);
        const r = await page.evaluate(() => {
          const bar = document.querySelector('nav.tabs')!.getBoundingClientRect();
          const tab = document.getElementById('tab-settings')!.getBoundingClientRect();
          return { barL: bar.left, barR: bar.right, l: tab.left, r: tab.right };
        });
        expect(r.l, `ширина ${width}`).toBeGreaterThanOrEqual(r.barL - 1);
        expect(r.r, `ширина ${width}`).toBeLessThanOrEqual(r.barR + 1);
      }
      // На 900px шесть вкладок помещаются без прокрутки полосы.
      await page.setViewportSize({ width: 900, height: 900 });
      expect(await page.evaluate(() => {
        const bar = document.querySelector('nav.tabs')!;
        return bar.scrollWidth <= bar.clientWidth;
      })).toBe(true);
    });
  }, 40000);

  it('выбранная вкладка не меняет ширину: полоса не «прыгает» при переключении', async () => {
    await open('pending');
    const lefts = () => page.evaluate(() => [...document.querySelectorAll('nav.tabs .tab')].map((b) => Math.round((b as HTMLElement).offsetLeft)));
    const before = await lefts();
    await page.click('#tab-settings');
    expect(await lefts()).toEqual(before);
  }, 30000);

  it('телефон, идёт поиск: видна одна «Остановить поиск», подпись не обрезана', async () => {
    await page.setViewportSize({ width: 360, height: 800 });
    await open('pending');
    // Состояние, которое ставит pollSearch(): старт неактивен, стоп показан.
    await page.evaluate(() => {
      (document.getElementById('searchStart') as HTMLButtonElement).disabled = true;
      document.getElementById('searchStop')!.hidden = false;
    });
    expect(await page.isVisible('#searchStart')).toBe(false);
    const lbl = await page.evaluate(() => {
      const l = document.querySelector('#searchStop .lbl') as HTMLElement;
      return { sw: l.scrollWidth, cw: l.clientWidth };
    });
    expect(lbl.sw).toBeLessThanOrEqual(lbl.cw);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }, 30000);

  it('пустая очередь у новичка зовёт кнопкой в настройки', async () => {
    await withPanel('fresh', async (port) => {
      await page.goto(`http://127.0.0.1:${port}/#pending`);
      const cta = page.locator('#pendingEmptyCta');
      await expect.poll(() => cta.textContent()).toMatch(/Открыть настройки/);
      await cta.click();
      expect(await page.isVisible('#pane-settings')).toBe(true);
      expect(await page.isVisible('#specEmpty')).toBe(true);
    });
  }, 30000);

  it('тур с клавиатуры: Enter на «Назад» листает назад, на «Пропустить» закрывает, Tab не уходит под затемнение', async () => {
    await open('pending');
    await page.click('#tourStart');
    // eslint-disable-next-line no-eval
    await page.evaluate(() => (eval('goTour') as (i: number) => Promise<void>)(2));
    // eslint-disable-next-line no-eval
    const idx = () => page.evaluate(() => eval('tourIdx') as number);
    await page.focus('#tour .tour-back');
    await page.keyboard.press('Enter');
    await expect.poll(idx).toBe(1);
    for (let k = 0; k < 5; k++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('#tour'))).toBe(true);
    }
    await page.focus('#tour .tour-skip');
    await page.keyboard.press('Enter');
    expect(await page.locator('#tour').count()).toBe(0);
  }, 30000);

  it('досрочный выход из тура возвращает на вкладку, с которой его начали', async () => {
    await open('approved');
    await page.click('#tourStart');
    // Третий шаг уводит в «Настройки».
    // eslint-disable-next-line no-eval
    await page.evaluate(() => (eval('goTour') as (i: number) => Promise<void>)(2));
    expect(await page.isVisible('#pane-settings')).toBe(true);
    await page.click('#tour .tour-skip');
    expect(await page.isVisible('#pane-approved')).toBe(true);
    expect(await page.evaluate(() => location.hash)).toBe('#approved');
  }, 30000);

  it('иконки заполняются во всём документе, а у «Обучения» нет эмодзи', async () => {
    await open('pending');
    for (const sel of ['#tourStart', '#searchStart', '#tab-pending', '#tab-settings', '#approveAll', '#settingsNav [data-sec="filters"]']) {
      expect(await page.locator(`${sel} svg`).count(), sel).toBeGreaterThan(0);
    }
    expect(await page.textContent('#tourStart')).not.toContain('❓');
  }, 30000);
});
