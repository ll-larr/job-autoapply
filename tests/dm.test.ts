import { describe, it, expect, afterEach } from 'vitest';
import {
  buildDmMessages, isUsableDm, generateDm, readDmTemplate, assembleDm, fitLimit, fitProblem,
  parseDmAnswer, vacancyTextProblem, DM_MAX_LENGTH, DM_TEMPLATE_PATH,
} from '../src/core/dm.js';
import { normalizeVacancy } from '../src/core/vacancy.js';

const V = normalizeVacancy({
  source: 'tg', sourceId: '-1001:7', title: 'Системный аналитик', company: '', url: 'https://t.me/workayte/7',
  description: 'Нужен BPMN, UML, SQL. Контакты: @hr', geo: '', postedAt: '2026-09-19T00:00:00Z',
  contact: 'hr', channel: 'Работа в ИТ',
});
const KEY = process.env['OPENROUTER_API_KEY'];
afterEach(() => { if (KEY === undefined) delete process.env['OPENROUTER_API_KEY']; else process.env['OPENROUTER_API_KEY'] = KEY; });

const TEMPLATE = 'Привет! Я - Хаер, ИИ агент кандидата.\n\nАртём - бизнес-аналитик.\n\n{{FIT}}\n\nБуду ждать обратную связь, спасибо!\n';
const FIT = 'Он делал BPMN-схемы в Camunda для склада и сократил инвентаризацию на 85%, как раз под вашу задачу.';
const GOOD = `Вакансия: Системный аналитик\nСсылка на пост: https://t.me/workayte/7\n\nПривет! Я - Хаер, ИИ агент кандидата.\n\nАртём - бизнес-аналитик.\n\n${FIT}\n\nБуду ждать обратную связь, спасибо!`;

describe('assembleDm', () => {
  it('строка с вакансией и ссылкой, скелет дословно, текст модели на месте {{FIT}}', () => {
    expect(assembleDm(TEMPLATE, FIT, V)).toBe(GOOD);
  });
  it('«$» и «&» в тексте модели не работают как шаблон замены', () => {
    expect(assembleDm(TEMPLATE, 'Зарплата $& и $1', V)).toContain('\n\nЗарплата $& и $1\n\n');
  });
});

describe('assembleDm: {{VACANCY}} в скелете', () => {
  const WITH_SLOT = 'Привет! Пишу по вакансии {{VACANCY}}\n\n{{FIT}}\n\nПока!';
  it('название и ссылка встают на место {{VACANCY}}, строки с вакансией сверху нет', () => {
    expect(assembleDm(WITH_SLOT, FIT, V))
      .toBe(`Привет! Пишу по вакансии Системный аналитик: https://t.me/workayte/7\n\n${FIT}\n\nПока!`);
  });
  it('подстановка за один проход: плейсхолдер в названии вакансии или тексте модели не разворачивается', () => {
    const sly = normalizeVacancy({ ...V, title: 'Аналитик {{FIT}} $&', postedAt: V.postedAt, contact: 'hr' });
    const text = assembleDm(WITH_SLOT, 'Текст модели {{VACANCY}}', sly);
    expect(text).toBe('Привет! Пишу по вакансии Аналитик {{FIT}} $&: https://t.me/workayte/7\n\nТекст модели {{VACANCY}}\n\nПока!');
  });
});

describe('assembleDm: строка модели на месте {{VACANCY}}', () => {
  it('берётся строка модели, а не «название: ссылка» кода', () => {
    const text = assembleDm('Пишу по вакансии {{VACANCY}}\n\n{{FIT}}', FIT, V, 'Системный аналитик (https://t.me/workayte/7)');
    expect(text).toBe(`Пишу по вакансии Системный аналитик (https://t.me/workayte/7)\n\n${FIT}`);
  });
});

describe('parseDmAnswer: ответ модели', () => {
  const LINE = 'Системный аналитик (https://t.me/workayte/7)';
  it('первая строка со ссылкой — это {{VACANCY}}, остальное — {{FIT}}', () => {
    expect(parseDmAnswer(`${LINE}\n\n${FIT}\n`, V)).toEqual({ vacancy: LINE, fit: FIT });
    expect(parseDmAnswer(`${LINE}\n${FIT}`, V)).toEqual({ vacancy: LINE, fit: FIT });
  });
  it('первой строки со ссылкой нет — весь ответ это {{FIT}}, а вакансию подставит код', () => {
    expect(parseDmAnswer(FIT, V)).toEqual({ vacancy: null, fit: FIT });
    expect(parseDmAnswer(`«${FIT}»`, V)).toEqual({ vacancy: null, fit: FIT });
  });
});

describe('vacancyTextProblem: строка модели на месте {{VACANCY}}', () => {
  it('название и ссылка (со скобками, двоеточием) — годна', () => {
    expect(vacancyTextProblem('Системный аналитик (https://t.me/workayte/7)', V)).toBeNull();
    expect(vacancyTextProblem('Системный аналитик: https://t.me/workayte/7', V)).toBeNull();
  });
  it('плейсхолдер, две ссылки, целый абзац вместо строки — негодны', () => {
    expect(vacancyTextProblem('{{VACANCY}} https://t.me/workayte/7', V)).toMatch(/плейсхолдер/);
    expect(vacancyTextProblem('https://t.me/workayte/7 https://t.me/workayte/7', V)).toMatch(/одна/);
    expect(vacancyTextProblem(`https://t.me/workayte/7 ${'а'.repeat(80)}`, V)).toMatch(/длиннее/);
  });
});

describe('fitLimit', () => {
  it('сколько остаётся на {{FIT}}, чтобы всё сообщение не превысило DM_MAX_LENGTH', () => {
    const limit = fitLimit(TEMPLATE, V);
    expect(assembleDm(TEMPLATE, 'а'.repeat(limit), V)).toHaveLength(DM_MAX_LENGTH);
  });
  it('скелет, который сам не помещается, — ноль, а не отрицательное число', () => {
    expect(fitLimit('я'.repeat(DM_MAX_LENGTH + 50) + '{{FIT}}', V)).toBe(0);
  });
});

describe('buildDmMessages', () => {
  const [system, user] = buildDmMessages({ vacancy: V, resume: 'РЕЗЮМЕ', role: 'Системный аналитик', template: TEMPLATE });
  it('пишет «HIRE! Agent», ИИ агент, о кандидате — в третьем лице', () => {
    expect(system!.content).toContain('«HIRE! Agent»');
    expect(system!.content).toContain('ИИ агент, а не человек и не сам кандидат');
    expect(system!.content).toContain('в третьем лице');
  });
  it('скелет идёт в кавычках, модели названы оба плейсхолдера и велено заполнить {{FIT}}', () => {
    expect(system!.content).toContain(`Структура сообщения собрана в скелете "${TEMPLATE.trim()}"`);
    expect(system!.content).toMatch(/содержится плейсхолдер \{\{VACANCY\}\} и \{\{FIT\}\}/);
    expect(system!.content).toMatch(/Вместо \{\{FIT\}\} напиши два-три предложения/);
  });
  it('возвращать велено название с ссылкой вместо {{VACANCY}} и текст вместо {{FIT}}, с пределом длины под скелет', () => {
    expect(system!.content).toMatch(
      /возвращаешь: только название вакансии с ссылкой на нее вместо плейсхолдера \{\{VACANCY\}\} и текст, который встанет вместо \{\{FIT\}\}/,
    );
    const chars = Number(/два-три предложения, не длиннее (\d+) символов/.exec(system!.content)?.[1]);
    expect(chars).toBeGreaterThan(0);
    expect(chars).toBeLessThanOrEqual(fitLimit(TEMPLATE, V));
  });
  it('специальность — со строчной буквы, предел длины — из DM_MAX_LENGTH', () => {
    expect(system!.content).toContain('кандидата, чье резюме ты используешь для ответа на вопросы - системный аналитик.');
    expect(system!.content).toContain(`не больше ${DM_MAX_LENGTH} символов`);
  });
  it('резюме — после инструкции', () => {
    expect(system!.content).toMatch(/=== РЕЗЮМЕ ===\nРЕЗЮМЕ$/);
  });
  it('без правил письма, которые здесь неверны', () => {
    expect(system!.content).not.toContain('Не начинай с упоминания того, что это отклик');
    expect(system!.content).not.toContain('"Резюме прикреплено"');
  });
  it('общие запреты письма — на месте', () => {
    expect(system!.content).toContain('Никаких длинных тире');
    expect(system!.content).toContain('диплом');
  });
  it('в user — пост, ссылка, название чата', () => {
    expect(user!.content).toContain('https://t.me/workayte/7');
    expect(user!.content).toContain('Работа в ИТ');
    expect(user!.content).toContain('Нужен BPMN');
  });
});

describe('скелет templates/tg-dm.md', () => {
  const template = readDmTemplate();
  it('по одному {{VACANCY}} (выше {{FIT}}) и {{FIT}}', () => {
    expect(template.match(/\{\{FIT\}\}/g)).toHaveLength(1);
    expect(template.match(/\{\{VACANCY\}\}/g)).toHaveLength(1);
    expect(template.indexOf('{{VACANCY}}')).toBeLessThan(template.indexOf('{{FIT}}'));
    expect(DM_TEMPLATE_PATH).toBe('templates/tg-dm.md');
  });
  it('в собранном сообщении не остаётся ни одного плейсхолдера, а ссылка на пост одна', () => {
    const text = assembleDm(template, FIT, V);
    expect(text).not.toMatch(/\{\{/);
    expect(text.split(V.url)).toHaveLength(2);
  });
  it('оставляет под {{FIT}} место на 2–3 предложения даже при длинном названии вакансии', () => {
    const long = normalizeVacancy({ ...V, title: 'а'.repeat(120), postedAt: V.postedAt, contact: 'hr' });
    expect(fitLimit(template, long)).toBeGreaterThanOrEqual(300);
  });
  it('собранное сообщение со стандартным текстом проходит проверку', () => {
    expect(isUsableDm(assembleDm(template, FIT, V), V)).toBeNull();
  });
});

describe('isUsableDm: готовое сообщение', () => {
  it('годное — null', () => {
    expect(isUsableDm(GOOD, V)).toBeNull();
  });
  it('пустое — негодно', () => {
    expect(isUsableDm('  ', V)).toMatch(/пуст/);
  });
  it('без ссылки на пост — негодно', () => {
    expect(isUsableDm(GOOD.replace('https://t.me/workayte/7', ''), V)).toMatch(/ссылк/);
  });
  it('длиннее предела — негодно', () => {
    expect(isUsableDm(`${GOOD} ${'а'.repeat(DM_MAX_LENGTH)}`, V)).toMatch(/длин/);
  });
  it('выдуманный навык — негодно', () => {
    expect(isUsableDm(GOOD.replace('BPMN-схемы', 'оконные функции'), V)).toMatch(/оконные функции/);
  });
  it('латиница и кириллица в одном слове («Figма») — негодно, со словом в причине', () => {
    expect(isUsableDm(GOOD.replace('Camunda', 'Camundа'), V)).toMatch(/«Camundа».*латиниц/);
    expect(isUsableDm(GOOD.replace('BPMN-схемы', 'Figма-схемы'), V)).toMatch(/латиниц/);
  });
  it('слова через дефис и чистая латиница не считаются смесью', () => {
    expect(isUsableDm(GOOD.replace('BPMN-схемы', 'BPMN-схемы и LLM-продукты, SQL, Jira'), V)).toBeNull();
  });
});

describe('fitProblem: текст модели на месте {{FIT}}', () => {
  const LIMIT = 400;
  it('годный — null', () => {
    expect(fitProblem(FIT, V, LIMIT)).toBeNull();
  });
  it('пустой, обрывок, остаток плейсхолдера, лишняя ссылка, слишком длинный — негодны', () => {
    expect(fitProblem('', V, LIMIT)).toMatch(/пуст/);
    expect(fitProblem('Подходит.', V, LIMIT)).toMatch(/\{\{FIT\}\} не заполнен/);
    expect(fitProblem(`${FIT} {{FIT}}`, V, LIMIT)).toMatch(/плейсхолдер/);
    expect(fitProblem(`${FIT} https://t.me/workayte/7`, V, LIMIT)).toMatch(/лишняя ссылка/);
    expect(fitProblem('а'.repeat(LIMIT + 1), V, LIMIT)).toMatch(/длиннее 400/);
  });
});

describe('generateDm', () => {
  const reply = (answers: string[]) => async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: answers.shift() } }] }));
  const INPUT = { vacancy: V, resume: 'R', role: 'Системный аналитик', readTemplate: () => TEMPLATE };

  it('модель вернула только текст для {{FIT}} — сообщение собирает код: скелет дословно, mode dm', async () => {
    process.env['OPENROUTER_API_KEY'] = 'k';
    const r = await generateDm(INPUT, { models: ['m'], attemptsPerModel: 1, fetchImpl: reply([FIT]) });
    expect(r.mode).toBe('dm');
    expect(r.letter).toBe(GOOD);
  });
  describe('скелет с {{VACANCY}}', () => {
    const WITH_SLOT = 'Привет!\nПишу тебе по вакансии {{VACANCY}}\n\n{{FIT}}\n\nПока!';
    const opts = (answers: string[]) => ({ models: ['m'], attemptsPerModel: answers.length, fetchImpl: reply(answers) });
    const input = { ...INPUT, readTemplate: () => WITH_SLOT };
    const ref = 'Системный аналитик (https://t.me/workayte/7)';

    it('модель вернула вакансию со ссылкой и текст — её строка встаёт на место {{VACANCY}}', async () => {
      process.env['OPENROUTER_API_KEY'] = 'k';
      const r = await generateDm(input, opts([`${ref}\n\n${FIT}`]));
      expect(r.mode).toBe('dm');
      expect(r.letter).toBe(`Привет!\nПишу тебе по вакансии ${ref}\n\n${FIT}\n\nПока!`);
    });
    it('модель вернула один только текст — «название: ссылку» подставляет код', async () => {
      process.env['OPENROUTER_API_KEY'] = 'k';
      const r = await generateDm(input, opts([FIT]));
      expect(r.letter).toBe(`Привет!\nПишу тебе по вакансии Системный аналитик: https://t.me/workayte/7\n\n${FIT}\n\nПока!`);
    });
    it('строка с вакансией негодна (две ссылки, целый абзац, пустой текст) — пробуется следующий ответ', async () => {
      process.env['OPENROUTER_API_KEY'] = 'k';
      const r = await generateDm(input, opts([
        `https://t.me/workayte/7 https://t.me/workayte/7\n\n${FIT}`,
        `https://t.me/workayte/7 ${'а'.repeat(90)}\n\n${FIT}`,
        ref,
        `${ref}\n\n${FIT}`,
      ]));
      expect(r.letter).toBe(`Привет!\nПишу тебе по вакансии ${ref}\n\n${FIT}\n\nПока!`);
    });
  });
  it('кавычки вокруг текста снимаются, кавычки внутри остаются', async () => {
    process.env['OPENROUTER_API_KEY'] = 'k';
    const inner = 'Он работал над «Системой учёта» и «Порталом заказов» и сократил путь заявки на 30%, как у вас.';
    const r = await generateDm(INPUT, { models: ['m'], attemptsPerModel: 1, fetchImpl: reply([`«${FIT}»`]) });
    expect(r.letter).toBe(GOOD);
    const r2 = await generateDm(INPUT, { models: ['m'], attemptsPerModel: 1, fetchImpl: reply([inner]) });
    expect(r2.letter).toContain(`\n\n${inner}\n\n`);
  });
  it('негодные ответы (обрывок, со ссылкой, слишком длинный, выдуманный навык) пропускаются, годный возвращается', async () => {
    process.env['OPENROUTER_API_KEY'] = 'k';
    const limit = fitLimit(TEMPLATE, V);
    const r = await generateDm(INPUT, {
      models: ['m'], attemptsPerModel: 5,
      fetchImpl: reply([
        'Без ссылки', `${FIT} https://t.me/workayte/7`, 'а'.repeat(limit + 1), 'Он писал оконные функции в отчётах для склада, как раз под вашу задачу.', FIT,
      ]),
    });
    expect(r.mode).toBe('dm');
    expect(r.letter).toBe(GOOD);
  });
  it('все ответы негодны — пустое сообщение с причиной последней попытки', async () => {
    process.env['OPENROUTER_API_KEY'] = 'k';
    const r = await generateDm(INPUT, { models: ['m'], attemptsPerModel: 1, fetchImpl: reply(['Подходит.']) });
    expect(r).toMatchObject({ letter: '', mode: 'none' });
    expect(r.failure).toMatch(/\{\{FIT\}\} не заполнен/);
  });
  it('скелет по умолчанию — templates/tg-dm.md', async () => {
    process.env['OPENROUTER_API_KEY'] = 'k';
    const bodies: string[] = [];
    await generateDm({ vacancy: V, resume: 'R', role: 'Системный аналитик' }, {
      models: ['m'], attemptsPerModel: 1,
      fetchImpl: async (_url, init) => {
        bodies.push(String(init?.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: 'нет' } }] }));
      },
    });
    const system = (JSON.parse(bodies[0]!) as { messages: Array<{ content: string }> }).messages[0]!.content;
    expect(system).toContain(readDmTemplate().trim());
  });
  it('нечитаемый скелет или скелет без {{FIT}} — пустое сообщение с причиной, а не исключение, и в модель не ходим', async () => {
    process.env['OPENROUTER_API_KEY'] = 'k';
    let calls = 0;
    const opts = { models: ['m'], fetchImpl: async () => { calls++; return new Response('{}'); } };
    const unreadable = await generateDm({ ...INPUT, readTemplate: () => { throw new Error('ENOENT'); } }, opts);
    expect(unreadable).toMatchObject({ letter: '', mode: 'none' });
    expect(unreadable.failure).toMatch(/tg-dm\.md.*ENOENT/);
    const noSlot = await generateDm({ ...INPUT, readTemplate: () => 'Привет!' }, opts);
    expect(noSlot).toMatchObject({ letter: '', mode: 'none' });
    expect(noSlot.failure).toMatch(/нет \{\{FIT\}\}/);
    expect(calls).toBe(0);
  });
});
