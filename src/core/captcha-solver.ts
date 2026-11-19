/**
 * Автоматическое решение капчи-картинки через сервис распознавания
 * (ruCaptcha / 2captcha — у них один и тот же API v2).
 *
 * Включено по решению владельца 2026-11-19: риск для аккаунта hh.ru он принял
 * сам. Картинка уходит стороннему сервису, где её распознаёт человек или модель;
 * ответ вписывает адаптер (adapters/hh.ts#solveCaptchaAuto). Не решилось —
 * остаётся прежнее ожидание человека в окне браузера.
 */

export type CaptchaProvider = 'rucaptcha' | '2captcha';

export const CAPTCHA_API_BASE: Record<CaptchaProvider, string> = {
  rucaptcha: 'https://api.rucaptcha.com',
  '2captcha': 'https://api.2captcha.com',
};

export interface CaptchaSolution {
  text: string;
  /** Сказать сервису, что ответ неверный: деньги за него вернут, а качество поднимут. */
  reportIncorrect(): Promise<void>;
}

export interface CaptchaSolver {
  solveImage(png: Buffer): Promise<CaptchaSolution>;
}

export interface ApiCaptchaSolverOptions {
  apiKey: string;
  provider?: CaptchaProvider;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Сколько всего ждать ответа. Обычно картинку решают за 5–20 с. */
  timeoutMs?: number;
  pollMs?: number;
}

interface ApiResponse {
  errorId?: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: number;
  status?: string;
  solution?: { text?: string };
}

export class ApiCaptchaSolver implements CaptchaSolver {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly pollMs: number;

  constructor(private readonly opts: ApiCaptchaSolverOptions) {
    this.base = CAPTCHA_API_BASE[opts.provider ?? 'rucaptcha'];
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => { setTimeout(r, ms); }));
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.pollMs = opts.pollMs ?? 5_000;
  }

  private async call(method: string, body: Record<string, unknown>): Promise<ApiResponse> {
    const res = await this.fetchImpl(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: this.opts.apiKey, ...body }),
    });
    if (!res.ok) throw new Error(`сервис капчи: ${method} ответил HTTP ${res.status}`);
    const data = (await res.json()) as ApiResponse;
    if (data.errorId !== undefined && data.errorId !== 0) {
      // Самые частые: ERROR_KEY_DOES_NOT_EXIST (ключ), ERROR_ZERO_BALANCE (баланс).
      throw new Error(`сервис капчи: ${data.errorCode ?? 'ошибка'}${data.errorDescription ? ` — ${data.errorDescription}` : ''}`);
    }
    return data;
  }

  async solveImage(png: Buffer): Promise<CaptchaSolution> {
    const created = await this.call('createTask', {
      task: {
        type: 'ImageToTextTask',
        body: png.toString('base64'),
        comment: 'введите текст с картинки',
      },
      // Капча hh.ru бывает кириллицей — русскоязычные исполнители.
      languagePool: 'rn',
    });
    const taskId = created.taskId;
    if (taskId === undefined) throw new Error('сервис капчи: не вернул taskId');

    const deadline = Date.now() + this.timeoutMs;
    // Раньше 5 с ответа не бывает — сервис просит не дёргать его зря.
    await this.sleep(this.pollMs);
    for (;;) {
      const r = await this.call('getTaskResult', { taskId });
      if (r.status === 'ready') {
        const text = (r.solution?.text ?? '').trim();
        if (text === '') throw new Error('сервис капчи: пустой ответ');
        return {
          text,
          reportIncorrect: async () => {
            await this.call('reportIncorrect', { taskId }).catch(() => {});
          },
        };
      }
      if (Date.now() >= deadline) throw new Error('сервис капчи: не решил за отведённое время');
      await this.sleep(this.pollMs);
    }
  }
}

/** Собирает решатель из настроек; без ключа или выключенный — null (ждём человека). */
export function makeCaptchaSolver(
  s: { enabled: boolean; apiKey: string | null; provider: CaptchaProvider } | undefined,
  fetchImpl?: typeof fetch,
): CaptchaSolver | null {
  if (s === undefined || !s.enabled || s.apiKey === null || s.apiKey.trim() === '') return null;
  return new ApiCaptchaSolver({ apiKey: s.apiKey.trim(), provider: s.provider, fetchImpl });
}
