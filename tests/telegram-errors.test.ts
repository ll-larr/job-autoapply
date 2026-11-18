import { describe, it, expect } from 'vitest';
import { errors } from 'telegram';
import { classifyTgError, describeTgFailure } from '../src/telegram/errors.js';

function rpc(message: string): Error {
  const e = new errors.RPCError(message, {} as never, 400);
  return e;
}

describe('classifyTgError', () => {
  it('FloodWaitError — секунды ожидания', () => {
    const e = new errors.FloodWaitError({ request: {} as never, capture: 42 });
    expect(classifyTgError(e)).toEqual({ kind: 'flood_wait', seconds: 42 });
  });

  it.each([
    ['PEER_FLOOD', 'peer_flood'],
    ['USER_PRIVACY_RESTRICTED', 'privacy'],
    ['USER_IS_BLOCKED', 'privacy'],
    ['YOU_BLOCKED_USER', 'privacy'],
    ['USERNAME_NOT_OCCUPIED', 'not_found'],
    ['USERNAME_INVALID', 'not_found'],
    ['AUTH_KEY_UNREGISTERED', 'auth'],
    ['SESSION_REVOKED', 'auth'],
    ['USER_DEACTIVATED', 'auth'],
    ['CHANNEL_PRIVATE', 'chat_unavailable'],
    ['CHAT_FORBIDDEN', 'chat_unavailable'],
  ])('%s → %s', (message, kind) => {
    expect(classifyTgError(rpc(message)).kind).toBe(kind);
  });

  it('«No user has "x" as username» от getEntity — not_found', () => {
    expect(classifyTgError(new Error('No user has "recruiter" as username')).kind).toBe('not_found');
  });

  it('всё остальное — other с текстом', () => {
    expect(classifyTgError(new Error('socket hang up'))).toEqual({ kind: 'other', message: 'socket hang up' });
  });

  it('описание по-русски называет, что делать', () => {
    expect(describeTgFailure({ kind: 'auth' })).toMatch(/npm run tg:login/);
    expect(describeTgFailure({ kind: 'peer_flood' })).toMatch(/ограничил/);
    expect(describeTgFailure({ kind: 'privacy' })).toMatch(/вручную/);
  });
});
