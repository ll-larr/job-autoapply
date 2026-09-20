import { describe, it, expect, afterEach } from 'vitest';
import { applyLlmSettings, orderModels } from '../src/core/llm.js';
import { complete, hasApiKey, setApiKey } from '../src/core/openrouter.js';
import { seedSettings } from '../src/core/settings.js';
import type { Config } from '../src/core/config.js';

const KEY = process.env['OPENROUTER_API_KEY'];
afterEach(() => {
  setApiKey(null);
  if (KEY === undefined) delete process.env['OPENROUTER_API_KEY'];
  else process.env['OPENROUTER_API_KEY'] = KEY;
});

function config(): Config {
  return {
    minScore: 40,
    letterFullThreshold: 75,
    letterModels: ['google/gemma-4-31b-it:free', 'openrouter/free'],
    throttle: {},
  };
}

describe('orderModels', () => {
  it('выбранная идёт первой, остальные остаются запасными', () => {
    expect(orderModels(['a', 'b'], 'z-ai/glm-5.3')).toEqual(['z-ai/glm-5.3', 'a', 'b']);
  });

  it('выбранная уже была в списке — не дублируется', () => {
    expect(orderModels(['a', 'b'], 'b')).toEqual(['b', 'a']);
  });

  it('ничего не выбрано — список как в config.json', () => {
    expect(orderModels(['a', 'b'], null)).toEqual(['a', 'b']);
  });
});

describe('applyLlmSettings', () => {
  it('ставит выбранную модель первой в config.letterModels', () => {
    const c = config();
    const s = seedSettings(undefined, null);
    s.llm = { apiKey: null, model: 'anthropic/claude-sonnet-5' };
    applyLlmSettings(c, s);
    expect(c.letterModels).toEqual(['anthropic/claude-sonnet-5', 'google/gemma-4-31b-it:free', 'openrouter/free']);
  });

  it('смена модели не накапливает список — прежний выбор уходит', () => {
    const c = config();
    const s = seedSettings(undefined, null);
    s.llm = { apiKey: null, model: 'anthropic/claude-sonnet-5' };
    applyLlmSettings(c, s);
    s.llm = { apiKey: null, model: 'deepseek/deepseek-v4-flash' };
    applyLlmSettings(c, s);
    expect(c.letterModels).toEqual(['deepseek/deepseek-v4-flash', 'google/gemma-4-31b-it:free', 'openrouter/free']);
  });

  it('выбор сняли — возвращается исходный список из config.json', () => {
    const c = config();
    const s = seedSettings(undefined, null);
    s.llm = { apiKey: null, model: 'z-ai/glm-5.3' };
    applyLlmSettings(c, s);
    s.llm = { apiKey: null, model: null };
    applyLlmSettings(c, s);
    expect(c.letterModels).toEqual(['google/gemma-4-31b-it:free', 'openrouter/free']);
  });

  it('ключ из настроек главнее OPENROUTER_API_KEY и уходит в запрос', async () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-env';
    const s = seedSettings(undefined, null);
    s.llm = { apiKey: 'sk-panel', model: null };
    applyLlmSettings(config(), s);
    expect(hasApiKey()).toBe(true);

    let seen: string | null = null;
    await complete([{ role: 'user', content: 'x' }], {
      models: ['m'],
      attemptsPerModel: 1,
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers).get('Authorization');
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      },
    });
    expect(seen).toBe('Bearer sk-panel');
  });

  it('ключа в настройках нет — берётся из окружения', () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-env';
    const s = seedSettings(undefined, null);
    s.llm = { apiKey: null, model: null };
    applyLlmSettings(config(), s);
    expect(hasApiKey()).toBe(true);
  });

  it('ключа нет нигде — hasApiKey говорит об этом честно', () => {
    delete process.env['OPENROUTER_API_KEY'];
    const s = seedSettings(undefined, null);
    applyLlmSettings(config(), s);
    expect(hasApiKey()).toBe(false);
  });
});
