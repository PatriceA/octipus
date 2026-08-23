import { describe, expect, test } from 'vitest';
import type { Hook } from '@/core/types';
import { resolveHookSessionId } from './actions';
import type { TriggerContext } from './triggers';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ctx(over: Partial<TriggerContext> = {}): TriggerContext {
  return over as TriggerContext;
}
function hook(over: Partial<Hook> = {}): Hook {
  return { id: 'hook-1', userId: 'user-1', sessionId: null, ...over } as Hook;
}

describe('resolveHookSessionId', () => {
  test('uses the inbound message session and does not flag persistence', () => {
    const r = resolveHookSessionId(ctx({ message: { metadata: { sessionId: 'msg-sess' } } as never }), hook());
    expect(r).toEqual({ sessionId: 'msg-sess', minted: false });
  });

  test('uses the inbound agent session', () => {
    const r = resolveHookSessionId(ctx({ agent: { sessionId: 'agent-sess' } as never }), hook());
    expect(r).toEqual({ sessionId: 'agent-sess', minted: false });
  });

  test('reuses the hook persisted session across runs', () => {
    const r = resolveHookSessionId(ctx(), hook({ sessionId: 'hook-sess' }));
    expect(r).toEqual({ sessionId: 'hook-sess', minted: false });
  });

  test('mints a new id on the first run of a scheduled hook and flags it for persistence', () => {
    const r = resolveHookSessionId(ctx(), hook({ sessionId: null }));
    expect(r.minted).toBe(true);
    expect(r.sessionId).toMatch(UUID_RE);
  });

  test('an inbound trigger session takes precedence over the hook session', () => {
    const r = resolveHookSessionId(
      ctx({ message: { metadata: { sessionId: 'msg-sess' } } as never }),
      hook({ sessionId: 'hook-sess' }),
    );
    expect(r).toEqual({ sessionId: 'msg-sess', minted: false });
  });

  test('with no hook present it never flags persistence', () => {
    const r = resolveHookSessionId(ctx());
    expect(r.minted).toBe(false);
    expect(r.sessionId).toMatch(UUID_RE);
  });

  test('ignores a non-string message sessionId and falls through to the hook session', () => {
    const r = resolveHookSessionId(
      ctx({ message: { metadata: { sessionId: 12345 } } as never }),
      hook({ sessionId: 'hook-sess' }),
    );
    expect(r).toEqual({ sessionId: 'hook-sess', minted: false });
  });
});
