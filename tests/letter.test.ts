import { describe, it, expect, afterEach } from 'vitest';
import {
  findForbiddenClaim, buildPrompt, readLetterTemplate, generateLetter, isUsableLetter,
  describeHttpFailure, isProxyBlockPage,
} from '../src/core/letter.js';
import type { LetterInput } from '../src/core/letter.js';
import { setCandidateName } from '../src/core/profile.js';
import { normalizeVacancy } from '../src/core/vacancy.js';

function mk(over: Partial<Parameters<typeof normalizeVacancy>[0]> = {}) {
  return normalizeVacancy({
    source: 'hh', sourceId: '1', title: 'Бизнес-аналитик', company: 'Сбер',
    url: 'u', description: 'Описание вакансии', geo: 'Москва',
    postedAt: '2026-08-20T00:00:00Z', ...over,
  });
}

const RESUME = 'РЕЗЮМЕ АРТЁМА';

describe('скелет письма', () => {
  // Решение владельца 2026-10-08: скелет один, templates/ai-llm-ba.md, и письмо
  // везде hybrid — модель дописывает только {{FIT}}. Скелет правят руками, и
  // без {{FIT}} письмо ушло бы без единого слова про вакансию.
  it('читается templates/ai-llm-ba.md, и в нём есть {{FIT}}', () => {
    const text = readLetterTemplate();
    expect(text).toContain('{{FIT}}');
    expect(text).not.toContain('{{HOOK}}');
  });
});

describe('buildPrompt — снимок промпта писем', () => {
  // Снимок обновлён 2026-10-08 после правки владельцем инструкции (только
  // {{FIT}}) и удаления режима full: промпт письма теперь один, hybrid.
  it('промпт письма — без непреднамеренных изменений', () => {
    const p = buildPrompt({
      vacancy: mk(), matched: ['sql'], resume: RESUME, template: 'СКЕЛЕТ {{FIT}}', role: 'Бизнес-аналитик',
    });
    expect(p.messages[0].content).toMatchSnapshot('hybrid');
  });
});

describe('buildPrompt — специальность', () => {
  // Имя перестало быть вписанным в промпт 2026-09-20: копию проекта отдают
  // другому человеку, и правка имени не должна требовать правки кода.
  it('имя из настроек попадает в промпт и подставляется в {{SIGNATURE}} скелета', () => {
    setCandidateName('Иван Петров');
    const p = buildPrompt({
      vacancy: mk(), matched: [], resume: RESUME, template: 'Текст {{FIT}}\n\n{{SIGNATURE}}', role: 'Бизнес-аналитик',
    });
    expect(p.messages[0].content).toContain('Кандидат: Иван Петров.');
    expect(p.messages[0].content).toContain('{{FIT}}\n\nИван Петров');
    setCandidateName(null);
  });

  it('имени нет — строки «Кандидат» нет', () => {
    const p = buildPrompt({ vacancy: mk(), matched: [], resume: RESUME, template: 'x', role: 'Бизнес-аналитик' });
    expect(p.messages[0].content).not.toContain('Кандидат:');
  });

  it('специальность вакансии — в инструкции', () => {
    const p = buildPrompt({
      vacancy: mk(), matched: [], resume: RESUME, template: 'С', role: 'Менеджер продукта',
    });
    expect(p.messages[0].content).toContain('по специальности «Менеджер продукта»');
  });
});

describe('buildPrompt — порядок сообщений для OpenRouter', () => {
  it('стабильный блок (инструкция + резюме) идёт первым, как system-сообщение', () => {
    const p = buildPrompt({
      vacancy: mk(), matched: ['sql'], resume: RESUME, template: 'x', role: 'БА',
    });
    expect(p.messages[0].role).toBe('system');
    expect(p.messages[0].content).toContain(RESUME);
  });

  it('текст вакансии идёт в user-сообщение и отсутствует в system — он волатилен', () => {
    const p = buildPrompt({
      vacancy: mk({ description: 'УНИКАЛЬНЫЙ ТЕКСТ' }), matched: ['sql'],
      resume: RESUME, template: 'x', role: 'БА',
    });
    expect(p.messages[0].content).not.toContain('УНИКАЛЬНЫЙ ТЕКСТ');
    expect(p.messages[1].role).toBe('user');
    expect(p.messages[1].content).toContain('УНИКАЛЬНЫЙ ТЕКСТ');
  });

  it('скелет письма идёт в system-сообщении после резюме', () => {
    const p = buildPrompt({ vacancy: mk(), matched: [], resume: RESUME, template: 'СКЕЛЕТ', role: 'БА' });
    const system = p.messages[0].content;
    expect(system.indexOf('=== РЕЗЮМЕ ===')).toBeLessThan(system.indexOf('=== СКЕЛЕТ ==='));
    expect(system.endsWith('=== СКЕЛЕТ ===\nСКЕЛЕТ')).toBe(true);
  });

  it('не содержит cache_control — это фича Anthropic, OpenRouter её не понимает', () => {
    const p = buildPrompt({
      vacancy: mk(), matched: [], resume: RESUME, template: 'x', role: 'БА',
    });
    expect(JSON.stringify(p)).not.toContain('cache_control');
  });

  it('инструкция запрещает упоминать диплом и университет', () => {
    const p = buildPrompt({ vacancy: mk(), matched: [], resume: RESUME, template: 'x', role: 'БА' });
    expect(p.messages[0].content).toMatch(/диплом/i);
    expect(p.messages[0].content).toMatch(/университет/i);
  });

  it('инструкция запрещает преувеличивать SQL и авторство API-контрактов', () => {
    const p = buildPrompt({ vacancy: mk(), matched: [], resume: RESUME, template: 'x', role: 'БА' });
    expect(p.messages[0].content).toMatch(/Postman/);
    expect(p.messages[0].content).toMatch(/контракт/i);
    expect(p.messages[0].content).toMatch(/сложные запросы с нуля/i);
  });

  it('инструкция требует прямо назвать junior+/middle для стажировок', () => {
    const p = buildPrompt({ vacancy: mk(), matched: [], resume: RESUME, template: 'x', role: 'БА' });
    expect(p.messages[0].content).toMatch(/стажировка/i);
    expect(p.messages[0].content).toMatch(/junior\+\/middle/);
  });
});

describe('generateLetter', () => {
  const ORIGINAL_KEY = process.env['OPENROUTER_API_KEY'];

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env['OPENROUTER_API_KEY'];
    else process.env['OPENROUTER_API_KEY'] = ORIGINAL_KEY;
  });

  const input = { vacancy: mk(), matched: [], resume: RESUME, template: 't', role: 'БА' };

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
    'Я аналитик.',
    '',
    '{{FIT}}',
    '',
    'Артём',
  ].join('\n');

  const base = (over: Partial<LetterInput> = {}): LetterInput => ({
    vacancy: mk(),
    matched: [],
    resume: RESUME,
    template: SKELETON,
    role: 'Бизнес-аналитик',
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

  it('принимает письмо, где вставка заполнена', () => {
    const filled = [
      'Здравствуйте!',
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
    // Настоящий случай из живого прогона 2026-08-30: вставка заполнена, но
    // постоянный текст скелета модель переписала по-своему и испортила
    // ("интервьюирую" -> "intervieuирую", "защищаю" -> "защищай"). Внешне
    // письмо выглядит нормальным и предыдущие проверки проходит.
    const skeleton = [
      'Здравствуйте!',
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
      'Я intervieuирую владельцев процесса, собираю схему AS-IS, нахожу узкие места и защищай TO-BE.',
      '',
      'Вёл AS-IS в похожем проекте.',
      '',
      'Артём',
    ].join('\n');
    expect(isUsableLetter(corrupted, base({ template: skeleton }))).toBe(false);
  });

  it('принимает письмо, где скелет дошёл дословно, а вставка заполнена', () => {
    const skeleton = [
      'Здравствуйте!',
      '',
      'Я интервьюирую владельцев процесса, собираю схему AS-IS, нахожу узкие места и защищаю TO-BE.',
      '',
      '{{FIT}}',
      '',
      'Артём',
    ].join('\n');
    const good = skeleton.replace('{{FIT}}', 'Вёл AS-IS в похожем проекте.');
    expect(isUsableLetter(good, base({ template: skeleton }))).toBe(true);
  });

  it('отбраковывает неподставленные {{TITLE}} и {{COMPANY}}, если они есть в скелете', () => {
    const skeleton = 'Здравствуйте! Откликаюсь на {{TITLE}} в {{COMPANY}}.\n\n{{FIT}}';
    const unfilled = 'Здравствуйте! Откликаюсь на {{TITLE}} в {{COMPANY}}.\n\nВёл AS-IS в похожем проекте.';
    expect(isUsableLetter(unfilled, base({ template: skeleton }))).toBe(false);
  });
});

// До 2026-09-23 скелеты кончались буквальной подписью «кандидат». Подпись
// подставляет код, не модель: {{SIGNATURE}} в скелете, если он там есть,
// заменяется именем из настроек (в ai-llm-ba.md с 2026-10-08 его нет —
// письмо от лица бота-ассистента, но механизм остаётся).
describe('подпись в скелете', () => {
  const SIGNED = [
    'Здравствуйте!',
    '',
    'Я интервьюирую владельцев процесса, собираю схему AS-IS, нахожу узкие места и защищаю TO-BE.',
    '',
    '{{FIT}}',
    '',
    '{{SIGNATURE}}',
    '',
  ].join('\n');

  const input = (): LetterInput => ({
    vacancy: mk(), matched: [], resume: RESUME, template: SIGNED, role: 'Бизнес-аналитик',
  });

  const skeletonOf = (content: string): string => content.split('=== СКЕЛЕТ ===\n')[1] ?? '';

  afterEach(() => setCandidateName(null));

  it('имя из настроек встаёт в подпись скелета', () => {
    setCandidateName('Иван Петров');
    const skeleton = skeletonOf(buildPrompt(input()).messages[0].content);
    expect(skeleton).not.toContain('{{SIGNATURE}}');
    expect(skeleton.trimEnd().endsWith('{{FIT}}\n\nИван Петров')).toBe(true);
  });

  it('имени нет — подписи в скелете нет', () => {
    const skeleton = skeletonOf(buildPrompt(input()).messages[0].content);
    expect(skeleton).not.toContain('{{SIGNATURE}}');
    expect(skeleton.trimEnd().endsWith('{{FIT}}')).toBe(true);
  });

  it('письмо с именем в подписи годно, скелет с вырезанной вставкой — нет', () => {
    setCandidateName('Иван Петров');
    const filled = SIGNED
      .replace('{{FIT}}', 'Вёл AS-IS в похожем проекте.')
      .replace('{{SIGNATURE}}', 'Иван Петров');
    expect(isUsableLetter(filled, input())).toBe(true);
    const stripped = SIGNED.replace('{{FIT}}', '').replace('{{SIGNATURE}}', 'Иван Петров');
    expect(isUsableLetter(stripped, input())).toBe(false);
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

  // Решение владельца 2026-10-08: этих навыков у него нет, в письме они недопустимы.
  it.each([
    'строил пользовательские метрики продукта',
    'настраивал пользовательских метрик для команды',
    'работал с пользовательскими метриками',
    'собирал дашборды в Power BI',
    'отчёты в PowerBI',
    'визуализация в power-bi',
  ])('ловит недопустимый навык: «%s»', (text) => {
    expect(findForbiddenClaim(text)).not.toBeNull();
  });

  it('не принимает за запрещённое соседние законные слова: пользовательские истории и метрики качества', () => {
    // В резюме есть user story («пользовательские истории») и «метрики качества
    // ответов» LLM-пайплайнов — ловить нужно именно «пользовательские метрики».
    expect(findForbiddenClaim('писал пользовательские истории и use case')).toBeNull();
    expect(findForbiddenClaim('считал метрики качества ответов LLM')).toBeNull();
  });

  it('письмо с выдумкой считается негодным и уходит на повтор', () => {
    const skeleton = ['Здравствуйте!', '', 'Я аналитик.', '', '{{FIT}}', '', 'Артём'].join('\n');
    const lying = skeleton.replace('{{FIT}}', 'Писал запросы с оконными функциями.');
    expect(isUsableLetter(lying, {
      vacancy: mk(), matched: [], resume: RESUME, template: skeleton, role: 'Бизнес-аналитик',
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
