import { describe, it, expect } from 'vitest';
import type { BrowserContext } from 'playwright';
import { makeContextCache, profileLaunchOptions } from '../src/browser.js';

/**
 * Регрессия, пойманная живой отправкой 2026-08-31: «Отправка упала:
 * browserContext.newPage: Target page, context or browser has been closed».
 *
 * Причина была в проверке живости опросом. `context.pages()` у ЗАКРЫТОГО
 * контекста не бросает — он спокойно отдаёт пустой массив, — поэтому приём
 * «дёрнем и поймаем исключение» всегда отвечал «жив» и возвращал наружу
 * мёртвый контекст. Здесь это и проверяется: фейковый контекст ведёт себя
 * ровно так же, как настоящий, и pages() у него после close() тоже молчит.
 */
function mkFakeContext(): BrowserContext & { closed: boolean; emitClose: () => void } {
  const listeners: Array<() => void> = [];
  const ctx = {
    closed: false,
    pages: () => [],
    // Настоящий BrowserContext здесь НЕ бросает после закрытия — в этом и был
    // весь фокус. Фейк обязан врать так же, иначе тест доказывает не то.
    once: (event: string, fn: () => void) => { if (event === 'close') listeners.push(fn); },
    close: async () => { ctx.closed = true; ctx.emitClose(); },
    emitClose: () => { for (const fn of listeners.splice(0)) fn(); },
  };
  return ctx as unknown as BrowserContext & { closed: boolean; emitClose: () => void };
}

describe('makeContextCache', () => {
  it('открывает контекст лениво — до первого get() браузер не запускается', async () => {
    let opened = 0;
    makeContextCache(async () => { opened++; return mkFakeContext(); });
    expect(opened).toBe(0);
  });

  it('второй get() переиспользует тот же контекст', async () => {
    let opened = 0;
    const cache = makeContextCache(async () => { opened++; return mkFakeContext(); });
    const a = await cache.get();
    const b = await cache.get();
    expect(a).toBe(b);
    expect(opened).toBe(1);
  });

  it('после close() следующий get() открывает НОВЫЙ контекст', async () => {
    const cache = makeContextCache(async () => mkFakeContext());
    const a = await cache.get();
    await cache.close();
    const b = await cache.get();
    expect(b).not.toBe(a);
  });

  it('контекст, закрытый ИЗВНЕ, тоже приводит к переоткрытию', async () => {
    // Человек закрыл окно Chromium руками — обычное дело, а не ошибка. Именно
    // этот случай и падал: кеш отдавал мёртвый контекст, а newPage() на нём
    // бросал «Target page, context or browser has been closed».
    const cache = makeContextCache(async () => mkFakeContext());
    const a = (await cache.get()) as ReturnType<typeof mkFakeContext>;

    a.emitClose(); // как если бы браузер закрыли снаружи

    const b = await cache.get();
    expect(b).not.toBe(a);
  });

  it('мёртвый контекст не отдаётся наружу, даже если pages() молчит', async () => {
    // Прямая проверка того, на чём всё сломалось: pages() у закрытого
    // контекста исключения не бросает, значит опрашивать его бесполезно.
    const cache = makeContextCache(async () => mkFakeContext());
    const a = (await cache.get()) as ReturnType<typeof mkFakeContext>;
    await a.close();
    expect(a.pages()).toEqual([]); // не бросил — вот и вся ловушка

    const b = (await cache.get()) as ReturnType<typeof mkFakeContext>;
    expect(b.closed).toBe(false);
  });

  it('close() на неоткрытом кеше безопасен', async () => {
    const cache = makeContextCache(async () => mkFakeContext());
    await expect(cache.close()).resolves.toBeUndefined();
  });

  it('повторный close() безопасен', async () => {
    const cache = makeContextCache(async () => mkFakeContext());
    await cache.get();
    await cache.close();
    await expect(cache.close()).resolves.toBeUndefined();
  });

  it('падение открытия не оставляет кеш в состоянии «открыт»', async () => {
    let attempt = 0;
    const cache = makeContextCache(async () => {
      attempt++;
      if (attempt === 1) throw new Error('профиль занят');
      return mkFakeContext();
    });
    await expect(cache.get()).rejects.toThrow(/профиль занят/);
    // Вторая попытка обязана снова попробовать открыть, а не вернуть undefined.
    await expect(cache.get()).resolves.toBeDefined();
    expect(attempt).toBe(2);
  });
});

describe('profileLaunchOptions', () => {
  it('браузер запускается МИМО системного прокси', () => {
    // На машине владельца в настройках Windows постоянно стоит VPN-клиент, а
    // Chromium берёт прокси именно оттуда. Через него careerist.ru в браузере
    // отдаёт ERR_TIMED_OUT — то есть подача на careerist молча ломалась бы,
    // пока включён VPN. Браузер ходит только на площадки, и им прокси не
    // нужен ни при каких обстоятельствах.
    expect(profileLaunchOptions(true).args).toContain('--no-proxy-server');
  });

  it('headless передаётся как просили', () => {
    expect(profileLaunchOptions(true).headless).toBe(true);
    expect(profileLaunchOptions(false).headless).toBe(false);
  });

  it('локаль русская — выдача и разметка площадок от неё зависят', () => {
    expect(profileLaunchOptions(false).locale).toBe('ru-RU');
  });
});
