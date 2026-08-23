import { afterEach, describe, expect, test } from 'vitest';
import { getOrchestratorHooks } from './orchestrator/hooks';
import { installRunLogHooks, toolCallEvent } from './run-log';

/**
 * The subscriber, not the DB write: `appendRunEvent` swallows its own errors by
 * design, so what has to be pinned down is WHICH dispatches produce an event
 * and what the payload carries — in particular that it never carries argument
 * VALUES.
 */
const SESSION = '11111111-2222-3333-4444-555555555555';

describe('run log — tool:after subscriber', () => {
  afterEach(() => {
    getOrchestratorHooks()._clearForTesting();
  });

  const fire = (over: Record<string, unknown> = {}) =>
    getOrchestratorHooks().fire('tool:after', {
      toolId: 'filesystem',
      toolName: 'read_file',
      args: { path: '/etc/passwd', token: 'sk-secret' },
      agent: { userId: 'u1', sessionId: SESSION, role: 'coding' },
      status: 'success',
      result: 'contents',
      durationMs: 12,
      ...over,
    } as never);

  test('installs exactly one subscriber however often it is called', () => {
    const off = installRunLogHooks();
    installRunLogHooks();
    expect(getOrchestratorHooks()._count('tool:after')).toBe(1);
    off();
  });

  test('a subscribed dispatch still runs the rest of the chain', async () => {
    const off = installRunLogHooks();
    let laterRan = false;
    getOrchestratorHooks().register('tool:after', () => { laterRan = true; });
    await fire();
    expect(laterRan).toBe(true);
    off();
  });

  const ctx = {
    toolId: 'filesystem',
    toolName: 'read_file',
    args: { path: '/etc/passwd', token: 'sk-secret' },
    agent: { sessionId: SESSION, role: 'coding' },
    status: 'success',
    durationMs: 12,
  };

  test('a call with no session is not logged — there is no run to attribute it to', () => {
    expect(toolCallEvent({ ...ctx, agent: { sessionId: '' } })).toBeNull();
  });

  test('a synthetic non-uuid session is not logged — run_id is a uuid column', () => {
    expect(toolCallEvent({ ...ctx, agent: { sessionId: 'artifact-refresh:u1' } })).toBeNull();
  });

  test('the payload records arg NAMES only, never their values', () => {
    const event = toolCallEvent(ctx)!;
    expect(event.payload?.args).toEqual(['path', 'token']);
    expect(JSON.stringify(event)).not.toContain('sk-secret');
    expect(JSON.stringify(event)).not.toContain('/etc/passwd');
  });

  test('it records shape, timing and outcome', () => {
    const event = toolCallEvent(ctx)!;
    expect(event.runId).toBe(SESSION);
    expect(event.subject).toBe('tool');
    expect(event.subjectId).toBe('filesystem__read_file');
    expect(event.event).toBe('tool_call');
    expect(event.payload).toMatchObject({ status: 'success', durationMs: 12, role: 'coding' });
  });
});
