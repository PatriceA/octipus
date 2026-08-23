import { describe, expect, test } from 'vitest';
import { generateRunId, getRunContext, getRunId, runWithContext } from './run-context';

describe('run-context (WS4)', () => {
  test('generateRunId is prefixed and unique', () => {
    const a = generateRunId();
    const b = generateRunId();
    expect(a).toMatch(/^run_/);
    expect(a).not.toBe(b);
  });

  test('runId/context are undefined outside any run', () => {
    expect(getRunId()).toBeUndefined();
    expect(getRunContext()).toBeUndefined();
  });

  test('runWithContext binds the context for the callback and its awaits', async () => {
    const runId = generateRunId();
    const result = await runWithContext({ runId, sessionId: 's1', channel: 'api' }, async () => {
      expect(getRunId()).toBe(runId);
      expect(getRunContext()?.sessionId).toBe('s1');
      await Promise.resolve();
      // Still bound across an await boundary.
      expect(getRunId()).toBe(runId);
      return 'ok';
    });
    expect(result).toBe('ok');
    // Unbound again after the run completes.
    expect(getRunId()).toBeUndefined();
  });

  test('nested runs shadow correctly and restore the outer context', async () => {
    const outer = generateRunId();
    const inner = generateRunId();
    await runWithContext({ runId: outer }, async () => {
      expect(getRunId()).toBe(outer);
      await runWithContext({ runId: inner }, async () => {
        expect(getRunId()).toBe(inner);
      });
      expect(getRunId()).toBe(outer);
    });
  });
});
