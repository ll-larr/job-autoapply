import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { ApiCaptchaSolver, makeCaptchaSolver, type CaptchaSolver } from '../src/core/captcha-solver.js';
import { solveCaptchaAuto } from '../src/adapters/hh.js';
import { freshSettings, validateSettings } from '../src/core/settings.js';

/** Подменный fetch: отвечает по очереди из списка и запоминает запросы. */
function fakeFetch(replies: unknown[]): { fetchImpl: typeof fetch; calls: Array<{ url: string; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const reply = replies.shift() ?? { errorId: 0 };
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('ApiCaptchaSolver', () => {
  it('createTask → processing → ready, ответ и жалоба на неверный', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { errorId: 0, taskId: 77 },
      { errorId: 0, status: 'processing' },
      { errorId: 0, status: 'ready', solution: { text: ' ab12 ' } },
      { errorId: 0, status: 'success' },
    ]);
    const solver = new ApiCaptchaSolver({ apiKey: 'k', fetchImpl, sleep: async () => {}, pollMs: 0 });
    const s = await solver.solveImage(Buffer.from('png'));
    expect(s.text).toBe('ab12');
    expect(calls[0]!.url).toBe('https://api.rucaptcha.com/createTask');
    expect(calls[0]!.body).toMatchObject({
      clientKey: 'k',
      task: { type: 'ImageToTextTask', body: Buffer.from('png').toString('base64') },
    });
    expect(calls[1]!.body).toMatchObject({ clientKey: 'k', taskId: 77 });
    await s.reportIncorrect();
    expect(calls[3]!.url).toBe('https://api.rucaptcha.com/reportIncorrect');
  });

  it('ошибка сервиса (нет денег) — понятное исключение', async () => {
    const { fetchImpl } = fakeFetch([{ errorId: 10, errorCode: 'ERROR_ZERO_BALANCE' }]);
    const solver = new ApiCaptchaSolver({ apiKey: 'k', provider: '2captcha', fetchImpl, sleep: async () => {} });
    await expect(solver.solveImage(Buffer.from('x'))).rejects.toThrow(/ERROR_ZERO_BALANCE/);
  });

  it('makeCaptchaSolver: без ключа или выключено — null', () => {
    expect(makeCaptchaSolver(undefined)).toBeNull();
    expect(makeCaptchaSolver({ enabled: false, apiKey: 'k', provider: 'rucaptcha' })).toBeNull();
    expect(makeCaptchaSolver({ enabled: true, apiKey: null, provider: 'rucaptcha' })).toBeNull();
    expect(makeCaptchaSolver({ enabled: true, apiKey: 'k', provider: 'rucaptcha' })).not.toBeNull();
  });
});

describe('настройки: раздел captcha', () => {
  it('сохраняется и проверяется', () => {
    const base = freshSettings();
    const ok = validateSettings({ ...base, captcha: { enabled: true, apiKey: ' abc ', provider: '2captcha' } });
    expect(ok.ok && ok.settings.captcha).toEqual({ enabled: true, apiKey: 'abc', provider: '2captcha' });
    expect(validateSettings({ ...base, captcha: { enabled: true, apiKey: 'a', provider: 'x' } }).ok).toBe(false);
    const none = validateSettings(base);
    expect(none.ok && none.settings.captcha).toBeUndefined();
  });
});

// Окно капчи как на hh.ru: картинка, поле, «Отправить». Верный ответ — «ok42».
const CAPTCHA_FORM = `<html><body>
<form id="other"><button type="submit" id="apply">Откликнуться</button></form>
<div role="dialog" id="cap"><h2>Complete the CAPTCHA</h2>
<p>To confirm you are not a robot, enter the text from the picture:</p>
<img id="pic" width="120" height="40" src="/account/captcha/image?x=1">
<input placeholder="Text from the picture"><button>Отправить</button></div>
<script>
  window.applyClicks = 0;
  document.getElementById('apply').addEventListener('click', (e) => { e.preventDefault(); window.applyClicks++; });
  document.querySelector('#cap button').addEventListener('click', () => {
    const v = document.querySelector('#cap input').value;
    if (v === 'ok42') document.getElementById('cap').remove();
    else document.querySelector('#cap input').value = '';
  });
</script></body></html>`;

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

async function captchaPage(): Promise<Page> {
  const context = await browser.newContext();
  await context.route('**/*', (r) => {
    const url = r.request().url();
    if (url.includes('/account/captcha/image')) {
      return r.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text x="10" y="28">ok42</text></svg>',
      });
    }
    if (url === 'https://hh.ru/captcha-test') return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: CAPTCHA_FORM });
    return r.abort();
  });
  const page = await context.newPage();
  await page.goto('https://hh.ru/captcha-test');
  return page;
}

function scripted(answers: string[]): CaptchaSolver & { images: number; reported: number } {
  const s = {
    images: 0,
    reported: 0,
    async solveImage(png: Buffer) {
      expect(png.length).toBeGreaterThan(0);
      s.images++;
      const text = answers.shift() ?? '';
      return { text, reportIncorrect: async () => { s.reported++; } };
    },
  };
  return s;
}

describe('solveCaptchaAuto', () => {
  it('вписывает ответ и жмёт «Отправить», а не «Откликнуться»', async () => {
    const page = await captchaPage();
    const solver = scripted(['ok42']);
    const r = await solveCaptchaAuto(page, solver, { settleMs: 2_000, pollMs: 50 });
    expect(r).toEqual({ solved: true, attempts: 1 });
    expect(await page.evaluate(() => (window as unknown as { applyClicks: number }).applyClicks)).toBe(0);
    await page.context().close();
  });

  it('неверный ответ — жалоба сервису и вторая попытка', async () => {
    const page = await captchaPage();
    const solver = scripted(['nope', 'ok42']);
    const r = await solveCaptchaAuto(page, solver, { settleMs: 500, pollMs: 50 });
    expect(r).toEqual({ solved: true, attempts: 2 });
    expect(solver.reported).toBe(1);
    await page.context().close();
  });

  it('ошибка сервиса обрывает попытки сразу', async () => {
    const page = await captchaPage();
    const solver: CaptchaSolver = { solveImage: async () => { throw new Error('сервис капчи: ERROR_ZERO_BALANCE'); } };
    const r = await solveCaptchaAuto(page, solver, { settleMs: 500, pollMs: 50 });
    expect(r.solved).toBe(false);
    expect(r.reason).toMatch(/ZERO_BALANCE/);
    await page.context().close();
  });
});
