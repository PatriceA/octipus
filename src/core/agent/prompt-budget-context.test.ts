/**
 * Context-fill registry: the number the TUI status bar shows as `ctx NN%`.
 * Bounded so a long-lived backend with many sessions cannot grow it forever.
 */
import { describe, expect, test } from 'vitest';
import { getContextFill, recordContextFill } from './prompt-budget';

describe('context fill registry', () => {
  test('records and reads back the last fill for a session', () => {
    recordContextFill('s-1', { promptTokens: 41_000, contextWindow: 100_000 });
    expect(getContextFill('s-1')).toEqual({ promptTokens: 41_000, contextWindow: 100_000 });
    recordContextFill('s-1', { promptTokens: 52_000, contextWindow: 100_000 });
    expect(getContextFill('s-1')?.promptTokens).toBe(52_000);
  });

  test('unknown session has no fill', () => {
    expect(getContextFill('never-seen')).toBeUndefined();
  });

  test('evicts the least-recently-recorded session past the cap', () => {
    for (let i = 0; i < 250; i++) recordContextFill(`bulk-${i}`, { promptTokens: i });
    expect(getContextFill('bulk-0')).toBeUndefined();
    expect(getContextFill('bulk-249')?.promptTokens).toBe(249);
  });
});
