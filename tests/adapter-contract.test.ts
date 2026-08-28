import { describe, it, expect } from 'vitest';
import { isHaltingResult } from '../src/adapters/types.js';
import type { Adapter, ApplyResult } from '../src/adapters/types.js';

describe('isHaltingResult', () => {
  it('captcha и auth_required останавливают очередь', () => {
    expect(isHaltingResult({ status: 'captcha' })).toBe(true);
    expect(isHaltingResult({ status: 'auth_required' })).toBe(true);
  });

  it('обычные исходы очередь не останавливают', () => {
    const ok: ApplyResult[] = [
      { status: 'sent' },
      { status: 'already_applied' },
      { status: 'failed', reason: 'кнопка не найдена' },
    ];
    for (const r of ok) expect(isHaltingResult(r)).toBe(false);
  });
});

describe('Adapter surface', () => {
  it('интерфейс состоит ровно из name, search и apply', () => {
    const stub: Adapter = {
      name: 'stub',
      async search() { return []; },
      async apply() { return { status: 'sent' }; },
    };
    expect(Object.keys(stub).sort()).toEqual(['apply', 'name', 'search']);
  });
});
