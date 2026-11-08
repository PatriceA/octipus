import { afterEach, describe, expect, test } from 'vitest';
import { getAgentHooks, type ToolResultContext } from '@/core/agent/hooks';
import { markToolExecutionUncertain, uncertainExecutionRecord } from '@/core/tool-execution-error';
import { GatewayEventBus } from '@/core/gateway/event-bus';
import { buildExtensionContext } from '@/extensions/api';
import { fireToolAfter } from './base-tool';

/**
 * `tool:after` result replacement: the value a handler leaves in `ctx.result`
 * is what the dispatch answers with, and a handler that throws on a success
 * withholds the result instead of letting it through half-redacted.
 */

function ctx(over: Partial<ToolResultContext> = {}): ToolResultContext {
  return { toolId: 'shell', toolName: 'run', args: {}, agent: { userId: 'u', sessionId: 's' },
    status: 'success', result: { stdout: 'token sk-abc123' }, durationMs: 1, ...over };
}

afterEach(() => getAgentHooks()._clearForTesting());

describe('tool:after', () => {
  test('with no handler the result passes through untouched', async () => {
    const c = ctx();
    expect(await fireToolAfter(c)).toBe(c.result);
  });

  test('a handler replaces the result; later handlers see the replacement', async () => {
    const hooks = getAgentHooks();
    hooks.register('tool:after', (c) => {
      c.result = { stdout: String((c.result as { stdout: string }).stdout).replace(/sk-\w+/g, '[redacted]') };
    });
    let seen: unknown;
    hooks.register('tool:after', (c) => { seen = c.result; });
    const out = await fireToolAfter(ctx());
    expect(out).toEqual({ stdout: 'token [redacted]' });
    expect(seen).toEqual(out);
  });

  test('fail-closed on success: a throwing handler withholds the result and names the hook', async () => {
    const hooks = getAgentHooks();
    let laterRan = false;
    hooks.register('tool:after', (c) => { c.result = 'half'; throw new Error('redactor down'); });
    hooks.register('tool:after', () => { laterRan = true; });
    const out = await fireToolAfter(ctx()) as { error: string };
    expect(out.error).toMatch(/^tool:after hook failed: redactor down\. shell\.run ran, but its result was withheld/);
    expect(JSON.stringify(out)).not.toContain('sk-abc123');
    expect(JSON.stringify(out)).not.toContain('half');
    expect(laterRan).toBe(false);
  });

  test('a trusted extension hook that throws is named in the withheld result', async () => {
    const { api, loaded } = buildExtensionContext('redactor', '/x/index.ts', new GatewayEventBus(), true);
    api.hook('tool:after', () => { throw new Error('boom'); });
    const out = await fireToolAfter(ctx()) as { error: string };
    expect(out.error).toContain('tool:after hook failed: extension "redactor": boom');
    await loaded.dispose();
  });

  test('fail-open on a failure outcome: the error stands and ctx.result is ignored', async () => {
    const hooks = getAgentHooks();
    let secondRan = false;
    hooks.register('tool:after', (c) => { c.result = 'ignored?'; throw new Error('tracer down'); });
    hooks.register('tool:after', () => { secondRan = true; });
    for (const status of ['error', 'cancelled', 'denied'] as const) {
      secondRan = false;
      // The caller rethrows the original error; what it returns here is unused.
      await expect(fireToolAfter(ctx({ status, result: undefined, error: new Error('x') }))).resolves.toBeUndefined();
      expect(secondRan).toBe(true);
    }
  });

  test('an uncertain execution stays marked uncertain through a replacement', async () => {
    const original = { stdout: 'secret' };
    markToolExecutionUncertain(original, 'rec-1');
    getAgentHooks().register('tool:after', (c) => { c.result = 'redacted'; });
    const out = await fireToolAfter(ctx({ result: original }));
    expect(out).toEqual({ result: 'redacted' });
    expect(uncertainExecutionRecord(out)).toBe('rec-1');

    getAgentHooks()._clearForTesting();
    getAgentHooks().register('tool:after', () => { throw new Error('down'); });
    const withheld = await fireToolAfter(ctx({ result: original }));
    expect(uncertainExecutionRecord(withheld)).toBe('rec-1');
  });
});
