/**
 * onlyOnChange: a check turning red starts one merged turn; green results and
 * checks that stay red start none (hooks/event-changes.ts).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Hook } from '@/core/types';
import { initializeStorage } from '@/db/storage';
import { executeAction } from './actions';
import {
  checkState, describeChanges, isCheckChange, observeGithubCheck, recordCheckStates, resetPendingCheckChanges,
} from './event-changes';
import type { TriggerContext } from './triggers';

const turns = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock('@/core/agent', () => ({
  getAgentService: () => ({
    handleMessage: async (_s: string, _u: string, message: string) => {
      turns.messages.push(message);
      return { agentId: 'agent-1', response: '' };
    },
  }),
}));
vi.mock('@/db/repositories/session-repository', () => ({
  sessionRepository: { findById: async () => null, addFlowLabel: async () => {}, clearFlowLabel: async () => {} },
}));

beforeAll(() => { initializeStorage({ mode: 'embedded' }); });

let hookN = 0;
let hookId = '';
beforeEach(() => {
  turns.messages = [];
  hookId = `hook-${++hookN}`;
});
afterEach(() => {
  resetPendingCheckChanges();
  vi.useRealTimers();
});

const hook = (actionConfig: Record<string, unknown> = {}): Hook => ({
  id: hookId, userId: '11111111-1111-4111-8111-111111111111', sessionId: '44444444-4444-4444-8444-444444444444',
  trigger: 'webhook', action: 'spawn_agent', triggerConfig: { webhookPath: 'gh' },
  actionConfig: { agentPrompt: 'Look at the failing checks.', orchestrated: true, onlyOnChange: true, ...actionConfig },
} as unknown as Hook);

function checkRun(name: string, conclusion: string | null, pr: number | null = 7, action = 'completed'): TriggerContext {
  return {
    webhook: {
      path: 'gh', method: 'POST', headers: { 'x-github-event': 'check_run' },
      body: {
        action, repository: { full_name: 'acme/app' },
        check_run: { name, conclusion, pull_requests: pr === null ? [] : [{ number: pr }], check_suite: { head_branch: 'feature' } },
      },
    },
  };
}

describe('observeGithubCheck', () => {
  test('reads check_run, check_suite, workflow_run and status', () => {
    expect(observeGithubCheck('check_run', checkRun('lint', 'failure').webhook!.body))
      .toEqual({ subject: 'acme/app#7', name: 'lint', state: 'fail', conclusion: 'failure' });
    expect(observeGithubCheck('check_run', checkRun('lint', 'success', null).webhook!.body))
      .toMatchObject({ subject: 'acme/app@feature', state: 'pass' });
    expect(observeGithubCheck('check_suite', { action: 'completed', repository: { full_name: 'a/b' }, check_suite: { conclusion: 'timed_out', app: { slug: 'github-actions' }, head_branch: 'main', pull_requests: [] } }))
      .toEqual({ subject: 'a/b@main', name: 'suite:github-actions', state: 'fail', conclusion: 'timed_out' });
    expect(observeGithubCheck('workflow_run', { action: 'completed', repository: { full_name: 'a/b' }, workflow_run: { name: 'CI', conclusion: 'cancelled', head_branch: 'x' } }))
      .toMatchObject({ name: 'CI', state: 'other' });
    expect(observeGithubCheck('status', { repository: { full_name: 'a/b' }, context: 'ci/jenkins', state: 'error', branches: [{ name: 'dev' }] }))
      .toEqual({ subject: 'a/b@dev', name: 'ci/jenkins', state: 'fail', conclusion: 'error' });
  });

  test('ignores unfinished checks and other events', () => {
    expect(observeGithubCheck('check_run', checkRun('lint', null, 7, 'created').webhook!.body)).toBeNull();
    expect(observeGithubCheck('issue_comment', { action: 'created', repository: { full_name: 'a/b' } })).toBeNull();
    expect(observeGithubCheck(undefined, {})).toBeNull();
    expect(checkState('stale')).toBe('other');
  });
});

describe('isCheckChange', () => {
  test('pass → fail is a change, fail → fail is not, pass then fail again is', async () => {
    const red = { subject: 's', name: 'lint', state: 'fail' as const, conclusion: 'failure' };
    const green = { ...red, state: 'pass' as const, conclusion: 'success' };
    expect(await isCheckChange(hookId, red)).toEqual({ change: true, previous: null });
    await recordCheckStates(hookId, [red]);
    expect((await isCheckChange(hookId, red)).change).toBe(false);
    await recordCheckStates(hookId, [green]);
    expect(await isCheckChange(hookId, red)).toEqual({ change: true, previous: 'pass' });
    // Another hook has its own state.
    expect((await isCheckChange(`${hookId}-other`, red)).previous).toBeNull();
  });
});

describe('spawn_agent with onlyOnChange', () => {
  test('a green check starts no turn', async () => {
    const r = await executeAction(hook({ changeMergeWindowSeconds: 0 }), checkRun('lint', 'success'));
    expect(r).toMatchObject({ success: true, data: { skipped: 'no change' } });
    expect(turns.messages).toHaveLength(0);
  });

  test('without a window, a check turning red is the turn, and staying red starts none', async () => {
    await executeAction(hook({ changeMergeWindowSeconds: 0 }), checkRun('lint', 'success'));
    const red = await executeAction(hook({ changeMergeWindowSeconds: 0 }), checkRun('lint', 'failure'));
    expect(red.success).toBe(true);
    expect(turns.messages).toHaveLength(1);
    expect(turns.messages[0]).toMatch(/<webhook_event>[\s\S]*Checks that turned failing on acme\/app#7:\n- lint: failure[\s\S]*<\/webhook_event>/);
    const again = await executeAction(hook({ changeMergeWindowSeconds: 0 }), checkRun('lint', 'failure'));
    expect(again).toMatchObject({ data: { skipped: 'no change', previous: 'fail' } });
    expect(turns.messages).toHaveLength(1);
  });

  test('a push that fails three checks wakes the agent once, with all three', async () => {
    vi.useFakeTimers();
    const results = [];
    for (const name of ['lint', 'test', 'build']) results.push(await executeAction(hook(), checkRun(name, 'failure')));
    expect(results.map((r) => (r.data as { merged: boolean }).merged)).toEqual([false, true, true]);
    expect(turns.messages).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(turns.messages).toHaveLength(1));
    expect(turns.messages[0]).toContain('- lint: failure\n- test: failure\n- build: failure');
    // The states were recorded when the turn fired: a repeat is no change.
    expect((await executeAction(hook(), checkRun('test', 'failure'))).data).toMatchObject({ skipped: 'no change' });
  });

  test('another pull request is its own subject', async () => {
    vi.useFakeTimers();
    await executeAction(hook(), checkRun('lint', 'failure', 7));
    await executeAction(hook(), checkRun('lint', 'failure', 8));
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(turns.messages).toHaveLength(2));
  });

  test('deliveries that are not check results are not filtered', async () => {
    const r = await executeAction(hook(), { webhook: { path: 'gh', method: 'POST', headers: { 'x-github-event': 'issue_comment' }, body: { action: 'created', repository: { full_name: 'acme/app' } } } });
    expect(r.success).toBe(true);
    expect(turns.messages).toHaveLength(1);
  });

  test('a hook without onlyOnChange runs on every check delivery', async () => {
    await executeAction(hook({ onlyOnChange: false }), checkRun('lint', 'success'));
    await executeAction(hook({ onlyOnChange: false }), checkRun('lint', 'success'));
    expect(turns.messages).toHaveLength(2);
  });

  test('the trigger context other hooks of the delivery share is not modified', async () => {
    const shared = checkRun('lint', 'failure');
    await executeAction(hook({ changeMergeWindowSeconds: 0 }), shared);
    expect(shared.checkChanges).toBeUndefined();
  });

  test('describeChanges lists each check', () => {
    expect(describeChanges([{ subject: 'a#1', name: 'x', state: 'fail', conclusion: 'timed_out' }])).toBe('Checks that turned failing on a#1:\n- x: timed_out');
  });
});
