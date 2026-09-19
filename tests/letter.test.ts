import { describe, it, expect, afterEach } from 'vitest';
import {
  findForbiddenClaim, buildPrompt, pickTemplate, pickMode, generateLetter, isUsableLetter,
  describeHttpFailure, isProxyBlockPage,
} from '../src/core/letter.js';
import type { LetterInput } from '../src/core/letter.js';
import { normalizeVacancy } from '../src/core/vacancy.js';

function mk(over: Partial<Parameters<typeof normalizeVacancy>[0]> = {}) {
  return normalizeVacancy({
    source: 'hh', sourceId: '1', title: 'Бизнес-аналитик', company: 'Сбер',
    url: 'u', description: 'Описание вакансии', geo: 'Москва',
    postedAt: '2026-08-20T00:00:00Z', ...over,
  });
}

const RESUME = 'РЕЗЮМЕ АРТЁМА';

describe('pickMode', () => {
  it('скор ниже порога — hybrid', () => expect(pickMode(60, 75)).toBe('hybrid'));
  it('скор на пороге — full', () => expect(pickMode(75, 75)).toBe('full'));
  it('скор выше порога — full', () => expect(pickMode(90, 75)).toBe('full'));
});

describe('pickTemplate', () => {
  it('площадка hrge даёт английский скелет', () => {
    expect(pickTemplate(mk({ source: 'hrge' }), ['sql'])).toBe('english-generic');
  });
  it('совпадение ai-llm даёт ai-llm-ba', () => {
    expect(pickTemplate(mk(), ['ai-llm', 'sql'])).toBe('ai-llm-ba');
  });
  it('продуктовые ключевики дают product-ba', () => {
    expect(pickTemplate(mk(), ['product'])).toBe('product-ba');
  });
  it('иначе fullstack-analyst', () => {
    expect(pickTemplate(mk(), ['sql', 'bpmn'])).toBe('fullstack-analyst');
  });
});

describe('buildPrompt — снимок промпта писем', () => {
  // Снимок снят 2026-09-19 ДО выноса общих правил в COMMON_WRITING_RULES
  // (core/dm.ts берёт их для сообщений рекрутёру). Промпт писем не должен
  // измениться ни на символ — ни в hybrid, ни в full.
  it('hybrid и full — без изменений', () => {
    for (const mode of ['hybrid', 'full'] as const) {
      const p = buildPrompt({ vacancy: mk(), matched: ['sql'], mode, resume: RESUME, template: 'СКЕЛЕТ {{HOOK}} {{FIT}}' });
      expect(p.messages[0].content).toMatchSnapshot(mode);
    }
  });
});

describe('buildPrompt — специальность', () => {
  it('без role — прежняя первая строка про бизнес-аналитика', () => {
    const p = buildPrompt({ vacancy: mk(), matched: [], mode: 'full', resume: RESUME, template: '' });
    expect(p.messages[0].content).toMatch(/^Ты помогаешь кандидату откликаться на вакансии бизнес-аналитика\./);
  });

  it('с role — специальность в инструкции, и в hybrid, и в full', () => {
    for (const mode of ['full', 'hybrid'] as const) {
      const p = buildPrompt({ vacancy: mk(), matched: [], mode, resume: RESUME, template: 'С', role: 'Менеджер продукта' });
      expect(p.messages[0].content).toContain('по специальности «Менеджер продукта»');
      expect(p.messages[0].content).not.toContain('вакансии бизнес-аналитика.');
    }
  });
});

describe('buildPrompt — порядок сообщений для OpenRouter', () => {
  it('стабильный блок (инструкция + резюме) идёт первым, как system-сообщение', () => {
    const p = buildPrompt({
      vacancy: mk(), matched: ['sql'], mode: 'hybrid', resume: RESUME, template: 'x',
    });
    expect(p.messages[0].role).toBe('system');
    expect(p.messages[0].content).toContain(RESUME);
  });

  it('текст вакансии идёт в user-сообщение и отсутствует в system — он волатилен', () => {
    const p = buildPrompt({
      vacancy: mk({ description: 'УНИКАЛЬНЫЙ ТЕКСТ' }), matched: ['sql'],
      mode: 'hybrid', resume: RESUME, template: 'x',
    });
    expect(p.messages[0].content).not.toContain('УНИКАЛЬНЫЙ ТЕКСТ');
    expect(p.messages[1].role).toBe('user');
    expect(p.messages[1].content).toContain('УНИКАЛЬНЫЙ ТЕКСТ');
  });

  it('режим full не подмешивает скелет', () => {
    const p = buildPrompt({
      vacancy: mk(), matched: [], mode: 'full', resume: RESUME, template: 'СКЕЛЕТ',
    });
    expect(JSON.stringify(p)).not.toContain('СКЕЛЕТ');
  });

  it('не содержит cache_control — это фича Anthropic, OpenRouter её не понимает', () => {
    const p = buildPrompt({
      vacancy: mk(), matched: [], mode: 'hybrid', resume: RESUME, template: 'x',
    });
    expect(JSON.stringify(p)).not.toContain('cache_control');
  });

  it('инструкция запрещает упоминать диплом и университет, в обоих режимах', () => {
    const hybrid = buildPrompt({ vacancy: mk(), matched: [], mode: 'hybrid', resume: RESUME, template: 'x' });
    const full = buildPrompt({ vacancy: mk(), matched: [], mode: 'full', resume: RESUME, template: 'x' });
    expect(hybrid.messages[0].content).toMatch(/диплом/i);
    expect(hybrid.messages[0].content).toMatch(/университет/i);
    expect(full.messages[0].content).toMatch(/диплом/i);
    expect(full.messages[0].content).toMatch(/университет/i);
  });

  it('инструкция запрещает преувеличивать SQL и авторство API-контрактов, в обоих режимах', () => {
    const hybrid = buildPrompt({ vacancy: mk(), matched: [], mode: 'hybrid', resume: RESUME, template: 'x' });
    const full = buildPrompt({ vacancy: mk(), matched: [], mode: 'full', resume: RESUME, template: 'x' });
    for (const p of [hybrid, full]) {
      expect(p.messages[0].content).toMatch(/Postman/);
      expect(p.messages[0].content).toMatch(/контракт/i);
      expect(p.messages[0].content).toMatch(/сложные запросы с нуля/i);
    }
  });

  it('инструкция требует прямо назвать junior+/middle для стажировок, в обоих режимах', () => {
    const hybrid = buildPrompt({ vacancy: mk(), matched: [], mode: 'hybrid', resume: RESUME, template: 'x' });
    const full = buildPrompt({ vacancy: mk(), matched: [], mode: 'full', resume: RESUME, template: 'x' });
    for (const p of [hybrid, full]) {
      expect(p.messages[0].content).toMatch(/стажировка/i);
      expect(p.messages[0].content).toMatch(/junior\+\/middle/);
    }
  });
});

describe('generateLetter', () => {
  const ORIGINAL_KEY = process.env['OPENROUTER_API_KEY'];

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env['OPENROUTER_API_KEY'];
    else process.env['OPENROUTER_API_KEY'] = ORIGINAL_KEY;
  });

  const input = { vacancy: mk(), matched: [], mode: 'hybrid' as const, resume: RESUME, template: 't' };

  it('возвращает текст первой же модели, если та ответила успешно', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ГОТОВОЕ ПИСЬМО' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const r = await generateLetter(input, { models: ['model-a:free'], fetchImpl });

    expect(r.letter).toBe('ГОТОВОЕ ПИСЬМО');
    expect(r.mode).toBe('hybrid');
    expect(calls).toBe(1);
  });

  it('шлёт запрос на openrouter с ключом из окружения, без ключа нигде в теле', async () => {
    process.env['OPENROUTER_API_KEY'] = 'secret-test-key';
    let seenUrl = '';
    let seenAuth: string | null = null;
    let seenBody = '';
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = (init?.headers as Record<string, string>)?.['Authorization'] ?? null;
      seenBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'X' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await generateLetter(input, { models: ['model-a:free'], fetchImpl });

    expect(seenUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(seenAuth).toBe('Bearer secret-test-key');
    expect(seenBody).not.toContain('secret-test-key');
  });

  it('когда первая модель отвечает ошибкой, пробует следующую по списку из config.letterModels', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    const calledModels: string[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      calledModels.push(body.model);
      if (body.model === 'model-a:free') {
        return new Response('rate limited', { status: 429 });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ПИСЬМО ОТ ВТОРОЙ МОДЕЛИ' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    // attemptsPerModel: 1 — здесь проверяется именно переход между записями,
    // а не повторы внутри одной. Повторы проверяются отдельным тестом ниже.
    const r = await generateLetter(
      input,
      { models: ['model-a:free', 'model-b:free'], attemptsPerModel: 1, fetchImpl },
    );

    expect(calledModels).toEqual(['model-a:free', 'model-b:free']);
    expect(r.letter).toBe('ПИСЬМО ОТ ВТОРОЙ МОДЕЛИ');
    expect(r.mode).toBe('hybrid');
  });

  it('повторяет одну и ту же запись, прежде чем идти дальше', async () => {
    // Нужно из-за openrouter/free: это метамодель, и повторный вызов может
    // уйти на другую живую модель под капотом. Без повторов цепочка из одной
    // записи сдавалась бы после первой же неудачи.
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 3) return new Response('rate limited', { status: 429 });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ПИСЬМО С ТРЕТЬЕЙ ПОПЫТКИ' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const r = await generateLetter(input, { models: ['openrouter/free'], fetchImpl });

    expect(calls).toBe(3);
    expect(r.letter).toBe('ПИСЬМО С ТРЕТЬЕЙ ПОПЫТКИ');
  });

  it('сдаётся после исчерпания попыток и возвращает пустое письмо', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('rate limited', { status: 429 });
    }) as unknown as typeof fetch;

    const r = await generateLetter(
      input,
      { models: ['openrouter/free'], attemptsPerModel: 2, fetchImpl },
    );

    expect(calls).toBe(2);
    expect(r.letter).toBe('');
    expect(r.mode).toBe('none');
  });

  it('когда все модели из списка отвечают ошибкой, возвращает пустое письмо и режим none', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;

    const r = await generateLetter(
      input,
      { models: ['model-a:free', 'model-b:free'], fetchImpl },
    );

    expect(r.letter).toBe('');
    expect(r.mode).toBe('none');
  });

  it('на сетевой ошибке всех моделей возвращает пустое письмо и режим none — не бросает', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    const fetchImpl = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;

    const r = await generateLetter(
      input,
      { models: ['model-a:free', 'model-b:free'], fetchImpl },
    );

    expect(r.letter).toBe('');
    expect(r.mode).toBe('none');
  });

  it('на ответе без текста (сломанная форма) переходит к следующей модели', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      if (body.model === 'model-a:free') {
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ПИСЬМО ОТ ВТОРОЙ МОДЕЛИ' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const r = await generateLetter(
      input,
      { models: ['model-a:free', 'model-b:free'], fetchImpl },
    );

    expect(r.letter).toBe('ПИСЬМО ОТ ВТОРОЙ МОДЕЛИ');
  });

  it('без OPENROUTER_API_KEY возвращает пустое письмо и режим none, не трогая сеть', async () => {
    delete process.env['OPENROUTER_API_KEY'];
    let touched = false;
    const fetchImpl = (async () => {
      touched = true;
      throw new Error('network must not be touched when the key is missing');
    }) as unknown as typeof fetch;

    const r = await generateLetter(
      input,
      { models: ['model-a:free', 'model-b:free'], fetchImpl },
    );

    expect(r.letter).toBe('');
    expect(r.mode).toBe('none');
    expect(touched).toBe(false);
  });
});

describe('isUsableLetter', () => {
  const SKELETON = [
    'Здравствуйте!',
    '',
    '{{HOOK}}',
    '',
    'Я аналитик.',
    '',
    '{{FIT}}',
    '',
    'Артём',
  ].join('\n');

  const base = (over: Partial<LetterInput> = {}): LetterInput => ({
    vacancy: mk(),
    matched: [],
    mode: 'hybrid',
    resume: RESUME,
    template: SKELETON,
    ...over,
  });

  it('отбраковывает скелет, из которого плейсхолдеры просто вырезали', () => {
    // Ровно то, что вернула живая модель 2026-08-29: письмо синтаксически
    // чистое, но про конкретную вакансию в нём нет ни слова.
    const stripped = ['Здравствуйте!', '', 'Я аналитик.', '', 'Артём'].join('\n');
    expect(isUsableLetter(stripped, base())).toBe(false);
  });

  it('отбраковывает текст с незаполненным плейсхолдером', () => {
    expect(isUsableLetter(SKELETON, base())).toBe(false);
  });

  it('отбраковывает пустой ответ', () => {
    expect(isUsableLetter('   ', base())).toBe(false);
  });

  it('принимает письмо, где врезки заполнены', () => {
    const filled = [
      'Здравствуйте!',
      '',
      'Вас зацепила автоматизация закупок.',
      '',
      'Я аналитик.',
      '',
      'Вёл AS-IS в похожем проекте.',
      '',
      'Артём',
    ].join('\n');
    expect(isUsableLetter(filled, base())).toBe(true);
  });

  it('отбраковывает письмо, в котором модель переписала и покорёжила скелет', () => {
    // Настоящий случай из живого прогона 2026-08-30: врезки заполнены, но
    // постоянный текст скелета модель переписала по-своему и испортила
    // ("интервьюирую" -> "intervieuирую", "защищаю" -> "защищай"). Внешне
    // письмо выглядит нормальным и предыдущие проверки проходит.
    const skeleton = [
      'Здравствуйте!',
      '',
      '{{HOOK}}',
      '',
      'Я интервьюирую владельцев процесса, собираю схему AS-IS, нахожу узкие места и защищаю TO-BE.',
      '',
      '{{FIT}}',
      '',
      'Артём',
    ].join('\n');
    const corrupted = [
      'Здравствуйте!',
      '',
      'Вакансия про оптимизацию процессов.',
      '',
      'Я intervieuирую владельцев процесса, собираю схему AS-IS, нахожу узкие места и защищай TO-BE.',
      '',
      'Вёл AS-IS в похожем проекте.',
      '',
      'Артём',
    ].join('\n');
    expect(isUsableLetter(corrupted, base({ template: skeleton }))).toBe(false);
  });

  it('принимает письмо, где скелет дошёл дословно, а врезки заполнены', () => {
    const skeleton = [
      'Здравствуйте!',
      '',
      '{{HOOK}}',
      '',
      'Я интервьюирую владельцев процесса, собираю схему AS-IS, нахожу узкие места и защищаю TO-BE.',
      '',
      '{{FIT}}',
      '',
      'Артём',
    ].join('\n');
    const good = skeleton
      .replace('{{HOOK}}', 'Вакансия про оптимизацию процессов.')
      .replace('{{FIT}}', 'Вёл AS-IS в похожем проекте.');
    expect(isUsableLetter(good, base({ template: skeleton }))).toBe(true);
  });

  it('в режиме full скелет не с чем сравнивать, проверяются только плейсхолдеры', () => {
    expect(isUsableLetter('Любой связный текст письма.', base({ mode: 'full' }))).toBe(true);
    expect(isUsableLetter('Текст с {{FIT}} внутри.', base({ mode: 'full' }))).toBe(false);
  });
});

describe('findForbiddenClaim', () => {
  it('ловит выдуманную глубину SQL', () => {
    // Настоящий текст, который модель вернула 2026-08-30. В резюме нет ни
    // JOIN, ни оконных функций; пользователь сказал, что сложные запросы
    // с нуля не пишет.
    const real = 'создавал отчётные запросы с JOIN, оконными функциями и агрегатами';
    expect(findForbiddenClaim(real)).not.toBeNull();
  });

  it('ловит приписанное проектирование контрактов API', () => {
    expect(findForbiddenClaim('проектировал контракты API для смежных команд')).not.toBeNull();
  });

  it('ловит прямое "писал контракты API" (стем без приставки)', () => {
    expect(findForbiddenClaim('писал контракты API для нескольких сервисов')).not.toBeNull();
  });

  it('не запрещает сам навык, только заявленную глубину', () => {
    // "SQL" и "API" сами по себе законны: он их читает и правит.
    expect(findForbiddenClaim('читаю и правлю SQL, работаю с API через Postman')).toBeNull();
  });

  // Регрессия: старый паттерн /(проектирова|разрабатыва|писа)[а-яё]*\s+(контракт|API)/i
  // ловил стем "писа" как ПОДСТРОКУ внутри "на+писа+л" — кириллица не даёт
  // воспользоваться \b (тот же класс проблемы, что документирован в шапке
  // core/screening.ts), так что приставка перед стемом ничем не была
  // отгорожена. "написал API-документацию к интеграции" — то, что реально
  // подтверждено резюме (он читает и описывает чужой API через Postman/curl,
  // но не проектирует его сам), — отбраковывалось наравне с настоящей
  // выдумкой. isUsableLetter возвращал false, цепочка сжигала все попытки по
  // всем моделям, и письмо уходило пустым без единой названной причины.
  it('НЕ ловит "написал API-документацию" — это не авторство контракта, а описание чужого API', () => {
    expect(findForbiddenClaim('написал API-документацию к интеграции')).toBeNull();
  });

  it('НЕ ловит другие приставочные формы того же стема — подписал/расписал', () => {
    expect(findForbiddenClaim('подписал контракт на техническое обслуживание')).toBeNull();
  });

  it('письмо с выдумкой считается негодным и уходит на повтор', () => {
    const skeleton = ['Здравствуйте!', '', '{{HOOK}}', '', 'Я аналитик.', '', '{{FIT}}', '', 'Артём'].join('\n');
    const lying = skeleton
      .replace('{{HOOK}}', 'Задачи близки к моим.')
      .replace('{{FIT}}', 'Писал запросы с оконными функциями.');
    expect(isUsableLetter(lying, {
      vacancy: mk(), matched: [], mode: 'hybrid', resume: RESUME, template: skeleton,
    })).toBe(false);
  });
});


describe('describeHttpFailure — причина, а не догадка', () => {
  const BLOCK_BODY = '{ "success": false, "error": "Access denied by security policy." }';

  it('403 от блок-страницы провайдера НЕ называется проблемой ключа', () => {
    // Прокси не нашёлся (VPN выключен), запрос ушёл напрямую и упёрся в
    // блокировку, которая отвечает 403 с этим телом. Первая версия этой
    // функции звала такой ответ «ключ отвергнут», и живой прогон 2026-09-01
    // отправил владельца проверять совершенно исправный ключ.
    const msg = describeHttpFailure(403, BLOCK_BODY);
    expect(msg).toMatch(/мимо прокси/i);
    expect(msg).not.toMatch(/ключ.*отвергнут/i);
  });

  it('называет, что делать: включить VPN, без перезапуска', () => {
    // Прокси ищется на каждое письмо заново, так что перезапуск не нужен и
    // советовать его — гнать человека делать лишнее.
    const msg = describeHttpFailure(403, BLOCK_BODY);
    expect(msg).toMatch(/включи VPN/i);
    expect(msg).not.toMatch(/use-env-proxy|перезапусти/i);
  });

  it('403 БЕЗ признаков блокировки по-прежнему читается как отказ ключа', () => {
    const msg = describeHttpFailure(403, '{"error":{"message":"No auth credentials found"}}');
    expect(msg).toMatch(/ключ/i);
    expect(msg).not.toMatch(/прокси/i);
  });

  it('401 — отказ ключа', () => {
    expect(describeHttpFailure(401, '{}')).toMatch(/ключ/i);
  });

  it('402 говорит про деньги, а не про ключ и не про лимит', () => {
    const msg = describeHttpFailure(402, '{}');
    expect(msg).toMatch(/деньги|баланс/i);
    expect(msg).not.toMatch(/ключ/i);
  });

  it('429 говорит про лимит', () => {
    expect(describeHttpFailure(429, '{}')).toMatch(/лимит/i);
  });

  it('незнакомый статус показывает начало тела, а не проглатывает его', () => {
    const msg = describeHttpFailure(500, 'upstream exploded in a specific way');
    expect(msg).toContain('500');
    expect(msg).toContain('upstream exploded');
  });
});

describe('isProxyBlockPage', () => {
  it('узнаёт блок-страницу по телу', () => {
    expect(isProxyBlockPage('{ "success": false, "error": "Access denied by security policy." }')).toBe(true);
  });

  it('обычный ответ OpenRouter блок-страницей не считает', () => {
    expect(isProxyBlockPage('{"error":{"message":"Insufficient credits","code":402}}')).toBe(false);
  });

  it('пустое тело — не блокировка', () => {
    expect(isProxyBlockPage('')).toBe(false);
  });
});
