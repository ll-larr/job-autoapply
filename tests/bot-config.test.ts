import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveBotConfig, DEFAULT_BOT_LIMITS, type Config } from '../src/core/config.js';
import { TEXTS, BUTTONS } from '../src/bot/texts.js';

const base = (): Config => ({
  minScore: 40, letterFullThreshold: 60, letterModels: ['m1'], throttle: {},
});

describe('resolveBotConfig', () => {
  it('без блока bot — внятная ошибка, а не молчаливые умолчания', () => {
    expect(() => resolveBotConfig(base())).toThrow(/config\.json.*bot/i);
  });

  it('лимиты добираются умолчаниями, models падает на letterModels', () => {
    const c: Config = { ...base(), bot: { profile: { github: 'https://github.com/x', telegram: '@ll_larr' } } };
    const r = resolveBotConfig(c);
    expect(r.limits).toEqual(DEFAULT_BOT_LIMITS);
    expect(r.models).toEqual(['m1']);
    expect(r.profile.telegram).toBe('@ll_larr');
  });

  it('заданный лимит перекрывает умолчание, остальные остаются', () => {
    const c: Config = {
      ...base(),
      bot: { profile: { github: 'g', telegram: '@t' }, limits: { perChatPerDay: 5 } },
    };
    const r = resolveBotConfig(c);
    expect(r.limits.perChatPerDay).toBe(5);
    expect(r.limits.perBotPerDay).toBe(DEFAULT_BOT_LIMITS.perBotPerDay);
  });

  it('пустой profile — отказ: рекрутёр не должен получить ответ с пустыми ссылками', () => {
    const c = { ...base(), bot: { profile: { github: '', telegram: '@t' } } } as Config;
    expect(() => resolveBotConfig(c)).toThrow(/profile/);
  });

  it('config.json в репозитории содержит рабочий блок bot', () => {
    const c = JSON.parse(readFileSync('config.json', 'utf8')) as Config;
    const r = resolveBotConfig(c);
    expect(r.profile.github).toMatch(/^https?:\/\//);
    expect(r.profile.telegram).toMatch(/^@/);
  });
});

describe('тексты', () => {
  it('дословные формулировки владельца не переписаны', () => {
    expect(TEXTS.start).toBe('Выбери нужную функцию в меню ниже!');
    expect(TEXTS.cvCaption).toBe('Резюме кандидата:');
    expect(TEXTS.askMeet).toBe('Укажи дату и время когда хочешь провести собеседование с кандидатом в формате "дд.мм;чч:мм"');
    expect(TEXTS.offTopic).toBe('Я отвечаю только на вопросы по вакансиям и опыту кандидата');
    // Контакт подставляется из config.json (bot.profile.telegram) с 2026-09-20:
    // в чужой копии проекта бот слал бы рекрутёров к прежнему владельцу.
    expect(TEXTS.limit('@someone')).toBe('Мои лимиты на сегодня закончились, напишите кандидату напрямую - @someone');
    expect(TEXTS.modelFailure).toBe('Не получается ответить прямо сейчас, повторите запрос чуть позже');
    expect(TEXTS.badFile).toBe('Принимаю вакансию текстом, ссылкой или файлом pdf, docx, txt, md');
  });

  it('кнопки клавиатуры — четыре, в порядке спеки', () => {
    expect([...BUTTONS]).toEqual(['Резюме', 'Профиль', 'Прикрепить вакансию', 'Назначить собеседование']);
  });
});
