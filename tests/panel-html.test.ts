import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * panel.html — единственный файл интерфейса, чистый HTML+JS без сборки
 * (см. src/ui/server.ts: он читается и отдаётся как есть, readFileSync).
 * Юнит-тестов на встроенный <script> в проекте раньше не было; вместо того
 * чтобы поднимать headless-браузер ради двух чистых функций форматирования,
 * извлекаем исходник конкретной функции по имени и выполняем его через
 * `new Function` — сама функция самодостаточна (никаких обращений к DOM),
 * так что это настоящее исполнение реального кода страницы, а не его копия.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractFunction(html: string, name: string): any {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  if (start === -1) throw new Error(`функция ${name} не найдена в panel.html`);
  const braceStart = html.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  const source = html.slice(start, i);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function(`${source}\nreturn ${name};`)();
}

const html = readFileSync('src/ui/panel.html', 'utf8');

describe('panel.html — buildSendResultText (задача task-review-fixes, находка 6)', () => {
  const buildSendResultText = extractFunction(html, 'buildSendResultText');

  it('упоминает пропущенные источники и причину, когда unthrottledSources непусто', () => {
    // src/core/sender.ts документирует unthrottledSources как: "The caller is
    // responsible for surfacing this — a skip that nobody looks at is as bad
    // as no protection at all." Раньше строка результата собиралась только
    // из sent/failed/halted, и площадка без записи в config.throttle
    // отправляла молча ноль заявок, а панель писала "Отправлено 0, не удалось
    // 0" — неотличимо от пустой очереди.
    const text = buildSendResultText({ sent: 2, failed: 0, halted: null, unthrottledSources: ['hrge'] });
    expect(text).toMatch(/hrge/);
    expect(text).toMatch(/throttle|пропущ/i);
  });

  it('молчит про пропуски, когда unthrottledSources пуст', () => {
    const text = buildSendResultText({ sent: 3, failed: 1, halted: null, unthrottledSources: [] });
    expect(text).not.toMatch(/пропущ/i);
    expect(text).toContain('Отправлено 3');
    expect(text).toContain('не удалось 1');
  });

  it('упоминает и остановку, и пропущенные источники одновременно, если есть оба', () => {
    const text = buildSendResultText({
      sent: 1, failed: 0,
      halted: { source: 'hh', reason: 'captcha' },
      unthrottledSources: ['hrge'],
    });
    expect(text).toMatch(/captcha/);
    expect(text).toMatch(/hrge/);
  });
});

describe('panel.html — formatElapsed (задача task-review-fixes, находка 9)', () => {
  const formatElapsed = extractFunction(html, 'formatElapsed');

  it('показывает прошедшее время в секундах, когда startedAt задан', () => {
    // startedAt писался в SendState/SearchState (src/ui/server.ts) и не
    // читался ни одной ручкой статуса — для операции, идущей минутами, "уже
    // прошло N секунд" не декоративная мелочь.
    expect(formatElapsed(1000, 4500)).toBe(' (4 c)'); // (4500-1000)/1000=3.5 -> round 4
  });

  it('пустая строка, когда startedAt отсутствует (операция ещё не запускалась)', () => {
    expect(formatElapsed(null, Date.now())).toBe('');
    expect(formatElapsed(undefined, Date.now())).toBe('');
  });

  it('не уходит в отрицательное время при небольшом рассинхроне часов', () => {
    expect(formatElapsed(5000, 4999)).toBe(' (0 c)');
  });
});

describe('panel.html — buildSendResultText, Telegram', () => {
  const buildSendResultText = extractFunction(html, 'buildSendResultText');

  it('называет отложенные контакты и предупреждения', () => {
    const text = buildSendResultText({
      sent: 1, failed: 0, halted: null, unthrottledSources: [],
      deferredContacts: [{ contact: 'hr_a', until: 0, title: 'БА' }],
      warnings: ['БА: резюме не приложилось'],
    });
    expect(text).toContain('отложено 1');
    expect(text).toContain('резюме не приложилось');
  });

  it('молчит, когда откладывать и предупреждать нечего', () => {
    const text = buildSendResultText({ sent: 2, failed: 0, halted: null, unthrottledSources: [] });
    expect(text).toBe('Отправлено 2, не удалось 0.');
  });
});

describe('panel.html — выбор модели для писем (2026-09-20)', () => {
  it('в списке есть DeepSeek, Sonnet и GLM', () => {
    for (const id of ['deepseek/deepseek-v4-flash', 'anthropic/claude-sonnet-5', 'z-ai/glm-5.3']) {
      expect(html).toContain(id);
    }
  });

  it('поле ключа скрыто по умолчанию и не уходит в автозаполнение браузера', () => {
    expect(html).toMatch(/id="llmKey"[^>]*type="password"|type="password"[^>]*id="llmKey"/);
    expect(html).toMatch(/id="llmKey"[^>]*autocomplete="off"/);
  });

  it('chosenModel: пустой выбор и пустая «другая» — null, иначе id модели', () => {
    // chosenModel читает MODEL_OTHER из области страницы; в new Function её
    // нет, поэтому кладём ту же константу в глобальную область теста.
    (globalThis as unknown as Record<string, string>)['MODEL_OTHER'] = '__other__';
    const chosenModel = extractFunction(html, 'chosenModel');
    expect(chosenModel('', '')).toBeNull();
    expect(chosenModel('z-ai/glm-5.3', '')).toBe('z-ai/glm-5.3');
    expect(chosenModel('__other__', '  ')).toBeNull();
    expect(chosenModel('__other__', ' mistral/x ')).toBe('mistral/x');
  });
});
