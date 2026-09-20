import { createProxiedFetch } from './proxy.js';

/**
 * Один вызов OpenRouter с перебором моделей. Вынесено из letter.ts
 * 2026-09-18: кроме писем модель теперь зовут «Предложить навыки»
 * (core/suggest.ts), а дальше — личные сообщения рекрутёрам. Логика перебора,
 * таймаутов и причин отказа — та же, что была у писем, и держится в одном
 * месте, чтобы не разойтись.
 */

export interface ChatMessage { role: 'system' | 'user'; content: string }

export interface CompletionOptions {
  /** Модели OpenRouter, в порядке попытки. Первая, что ответит пригодным текстом, и используется. */
  models: string[];
  /**
   * Сколько раз пробовать одну и ту же запись, прежде чем перейти к следующей.
   * По умолчанию 3. Имеет смысл, потому что `openrouter/free` — метамодель:
   * она сама выбирает живую бесплатную модель, и повторный вызов может уйти
   * на другую. Для жёстко заданной модели повтор помогает от временных 429.
   */
  attemptsPerModel?: number;
  /**
   * Потолок на одну попытку, мс. По умолчанию 90 000. Бесплатные модели умеют
   * вставать намертво или тянуть минутами: живой прогон 2026-08-30 отдал письмо
   * через 371 секунду. Без потолка один такой запрос стопорит весь конвейер.
   */
  timeoutMs?: number;
  /**
   * Для тестов — подмена сетевого fetch, как в src/adapters/hrge.ts. По
   * умолчанию запрос идёт через прокси, найденный в момент запроса.
   */
  fetchImpl?: typeof fetch;
}

export type CompletionResult =
  | { ok: true; text: string; model: string }
  | { ok: false; failure: string };


const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Достаёт текст ответа из тела OpenRouter chat-completions, не веря его форме. */
export function extractText(body: unknown): string | undefined {
  const choices = (body as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = first?.message?.content;
  return typeof content === 'string' && content !== '' ? content : undefined;
}

/**
 * Признак блок-страницы провайдера. Ловится по телу, а не по статусу: 403
 * отдаёт и OpenRouter, когда ключ негоден, и блокировка, когда Node пошёл
 * напрямую. Тело у них разное, и только оно позволяет назвать причину верно.
 */
export function isProxyBlockPage(body: string): boolean {
  return /Access denied by security policy/i.test(body);
}

/**
 * Почему письмо не получилось. Человекочитаемая строка, а не код: она идёт
 * прямиком в панель и в консоль.
 *
 * Существует потому, что молчаливый провал уже стоил живого прогона:
 * 2026-08-31 поиск вернул двадцать вакансий с пустыми письмами и ни словом не
 * объяснил, почему. Причина оказалась банальной — на счету OpenRouter
 * кончились деньги, платная модель отвечала 402, бесплатные 429, — но чтобы
 * это выяснить, пришлось лезть в код и стучаться в API руками. `!res.ok`
 * здесь раньше просто отбрасывался вместе со статусом и телом ответа.
 */
export function describeHttpFailure(status: number, body: string): string {
  // Блок-страница провайдера, а НЕ ответ OpenRouter. Так бывает, когда прокси
  // не нашёлся (см. src/core/proxy.ts): запрос идёт напрямую и упирается в
  // блокировку, которая отвечает 403 с этим телом.
  //
  // Отличать обязательно. Первая версия этой функции звала такой ответ
  // «ключ отвергнут», и живой прогон 2026-09-01 отправил владельца проверять
  // совершенно исправный ключ. Различитель — тело, а не статус.
  if (isProxyBlockPage(body)) {
    return 'запрос ушёл МИМО прокси и упёрся в блокировку провайдера (403 «Access denied by security policy»). '
      + 'Это не ответ OpenRouter и не проблема ключа. Включи VPN: прокси ищется на каждое письмо '
      + 'заново, следующее уже пойдёт через него';
  }
  if (status === 401 || status === 403) {
    return `ключ OpenRouter отвергнут (HTTP ${status}) — проверь ключ в панели `
      + '(«Настройки» → «Модель для писем») или OPENROUTER_API_KEY в .env';
  }
  if (status === 402) {
    return 'на счету OpenRouter кончились деньги (HTTP 402) — пополни баланс или выбери бесплатную модель '
      + 'в панели («Настройки» → «Модель для писем»)';
  }
  if (status === 429) {
    return 'лимит запросов (HTTP 429) — у бесплатных моделей он общий на всех, стоит подождать или добавить платную';
  }
  // Текст ошибки от OpenRouter бывает содержательным — показываем начало.
  const hint = body.trim().slice(0, 160);
  return `HTTP ${status}${hint === '' ? '' : ` — ${hint}`}`;
}

// Прокси нужен только модели: OpenRouter — единственный адресат за блокировкой.
const proxiedFetch = createProxiedFetch();

/**
 * Ключ, вписанный в панели (data/settings.json, секция llm). Хранится в
 * модуле, а не в CompletionOptions, по той же причине, по которой там же
 * читался process.env: `complete` зовут из пяти мест (письма, личные
 * сообщения, анкета hh, «Предложить навыки», бот), и протаскивать ключ через
 * все сигнатуры значило бы переписать их все ради значения, которое во всём
 * процессе одно.
 *
 * null — ключ из панели не задан, берём из окружения (.env).
 */
let panelApiKey: string | null = null;

/**
 * Ставит ключ из настроек панели. Зовётся из core/llm.ts при старте команды и
 * после каждого сохранения настроек.
 */
export function setApiKey(key: string | null): void {
  panelApiKey = key === null || key.trim() === '' ? null : key.trim();
}

/**
 * Ключ панели главнее OPENROUTER_API_KEY: его человек только что вписал
 * руками, а переменная окружения могла остаться от прежнего владельца копии
 * проекта — и молча писала бы письма с чужого счёта.
 */
export function resolveApiKey(): string | undefined {
  if (panelApiKey !== null) return panelApiKey;
  const fromEnv = process.env['OPENROUTER_API_KEY']?.trim();
  return fromEnv === undefined || fromEnv === '' ? undefined : fromEnv;
}

/** Есть ли чем звать модель. Для отчёта поиска и команды letters. */
export function hasApiKey(): boolean {
  return resolveApiKey() !== undefined;
}

/**
 * Пробует модели по порядку, каждую — `attemptsPerModel` раз. `reject`
 * возвращает причину, по которой ответ негоден, или null: негодный ответ —
 * такая же неудача, как HTTP-ошибка, и перебор идёт дальше. Не бросает
 * никогда: любой сбой превращается в `{ ok: false, failure }` с последней
 * причиной — её показывают человеку.
 */
export async function complete(
  messages: ChatMessage[],
  options: CompletionOptions,
  reject: (text: string) => string | null = () => null,
): Promise<CompletionResult> {
  const apiKey = resolveApiKey();
  if (apiKey === undefined) {
    return {
      ok: false,
      failure: 'ключ OpenRouter не задан — впиши его в панели («Настройки» → «Модель для писем») '
        + 'или положи OPENROUTER_API_KEY в .env рядом с package.json',
    };
  }

  // Последняя увиденная причина. Именно последняя, а не первая: цепочка идёт
  // от бесплатных моделей к запасным, и человеку полезнее знать, обо что
  // споткнулась ПОСЛЕДНЯЯ попытка, чем то, что первая бесплатная привычно
  // отдала 429.
  let failure = 'ни одна модель из letterModels не ответила пригодным текстом';
  const fetchImpl = options.fetchImpl ?? proxiedFetch;
  const attempts = options.attemptsPerModel ?? 3;
  const timeoutMs = options.timeoutMs ?? 90_000;

  for (const model of options.models) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        // Таймаут обязателен. Бесплатные модели умеют вставать намертво: живой
        // прогон 2026-08-30 провисел больше пяти минут без единого байта ответа.
        const res = await fetchImpl(OPENROUTER_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          failure = `${model}: ${describeHttpFailure(res.status, await res.text().catch(() => ''))}`;
          continue;
        }
        const text = extractText(await res.json());
        if (text === undefined) {
          failure = `${model}: ответ без текста`;
          continue;
        }
        const why = reject(text);
        if (why !== null) {
          failure = `${model}: ${why}`;
          continue;
        }
        return { ok: true, text, model };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failure = `${model}: ${msg.includes('timeout') || msg.includes('aborted')
          ? `модель не ответила за ${timeoutMs / 1000} с`
          : msg.slice(0, 160)}`;
      }
    }
  }
  return { ok: false, failure };
}
