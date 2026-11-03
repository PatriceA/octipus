/**
 * onlyOnChange: a check turning red starts one merged turn; green results and
 * checks that stay red start none (hooks/event-changes.ts).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Hook } from '@/core/types';
import { initializeStorage } from '@/db/storage';
import {
  type CheckObservation, checkState, describeChanges, gateCheckChange, isCheckChange, observeGithubCheck, recordCheckStates, resetPendingCheckChanges,
} from './event-changes';
import type { TriggerContext } from './triggers';

beforeAll(() => { initializeStorage({ mode: 'embedded' }); });

let hookN = 0;
let hookId = '';
beforeEach(() => { hookId = `hook-${++hookN}`; });
afterEach(() => {
  resetPendingCheckChanges();
  vi.useRealTimers();
});

const hook = (actionConfig: Record<string, unknown> = {}): Hook => ({
  id: hookId, userId: '11111111-1111-4111-8111-111111111111', sessionId: null,
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

/** Run the gate; `fired` collects merged turns. */
const fired: TriggerContext[] = [];
const gate = (h: Hook, ctx: TriggerContext) => gateCheckChange(h, ctx, async (merged) => { fired.push(merged); });
beforeEach(() => { fired.length = 0; });

describe('observeGithubCheck', () => {
  test('reads check_run, check_suite, workflow_run and status', () => {
    expect(observeGithubCheck('check_run', checkRun('lint', 'failure').webhook!.body, 5))
      .toEqual({ subject: 'acme/app#7', name: 'lint', state: 'fail', conclusion: 'failure', observedAt: 5 });
    expect(observeGithubCheck('check_run', checkRun('lint', 'success', null).webhook!.body))
      .toMatchObject({ subject: 'acme/app@feature', state: 'pass' });
    expect(observeGithubCheck('check_suite', { action: 'completed', repository: { full_name: 'a/b' }, check_suite: { conclusion: 'timed_out', app: { slug: 'github-actions' }, head_branch: 'main', pull_requests: [] } }))
      .toMatchObject({ subject: 'a/b@main', name: 'suite:github-actions', state: 'fail', conclusion: 'timed_out' });
    expect(observeGithubCheck('workflow_run', { action: 'completed', repository: { full_name: 'a/b' }, workflow_run: { name: 'CI', conclusion: 'cancelled', head_branch: 'x' } }))
      .toMatchObject({ name: 'CI', state: 'other' });
    expect(observeGithubCheck('status', { repository: { full_name: 'a/b' }, context: 'ci/jenkins', state: 'error', branches: [{ name: 'dev' }] }))
      .toMatchObject({ subject: 'a/b@dev', name: 'ci/jenkins', state: 'fail', conclusion: 'error' });
  });

  test('an unfinished check is observed as other; other events are not observed', () => {
    expect(observeGithubCheck('check_run', checkRun('lint', null, 7, 'created').webhook!.body)).toMatchObject({ state: 'other', conclusion: 'created' });
    expect(observeGithubCheck('workflow_run', { action: 'in_progress', repository: { full_name: 'a/b' }, workflow_run: { name: 'CI' } })).toMatchObject({ state: 'other' });
    expect(observeGithubCheck('issue_comment', { action: 'created', repository: { full_name: 'a/b' } })).toBeNull();
    expect(observeGithubCheck(undefined, {})).toBeNull();
    expect(checkState('stale')).toBe('other');
  });
});

const obs = (state: 'pass' | 'fail', observedAt: number): CheckObservation =>
  ({ subject: 's', name: 'lint', state, conclusion: state === 'fail' ? 'failure' : 'success', observedAt });

describe('isCheckChange / recordCheckStates', () => {
  test('pass → fail is a change, fail → fail is not, pass then fail again is', async () => {
    expect(await isCheckChange(hookId, obs('fail', 1))).toEqual({ change: true, previous: null });
    await recordCheckStates(hookId, [obs('fail', 1)]);
    expect((await isCheckChange(hookId, obs('fail', 2))).change).toBe(false);
    await recordCheckStates(hookId, [obs('pass', 3)]);
    expect(await isCheckChange(hookId, obs('fail', 4))).toEqual({ change: true, previous: 'pass' });
    expect((await isCheckChange(`${hookId}-other`, obs('fail', 4))).previous).toBeNull();
  });

  test('an older observation never overwrites a newer one', async () => {
    await recordCheckStates(hookId, [obs('pass', 10)]);
    await recordCheckStates(hookId, [obs('fail', 5)]);
    expect((await isCheckChange(hookId, obs('fail', 11))).previous).toBe('pass');
  });
});

describe('gateCheckChange', () => {
  test('a green check is skipped and recorded; an unfinished one is skipped', async () => {
    expect(await gate(hook(), checkRun('lint', 'success'))).toMatchObject({ result: { success: true, data: { skipped: 'no change' } } });
    expect(await gate(hook(), checkRun('lint', null, 7, 'in_progress'))).toMatchObject({ result: { data: { skipped: 'check not finished' } } });
    expect((await isCheckChange(hookId, { ...obs('fail', Date.now()), subject: 'acme/app#7' })).previous).toBe('pass');
  });

  test('without a window, a check turning red runs now with the change, staying red is skipped', async () => {
    const shared = checkRun('lint', 'failure');
    const red = await gate(hook({ changeMergeWindowSeconds: 0 }), shared);
    expect('context' in red && red.context.checkChanges?.map((c) => c.name)).toEqual(['lint']);
    // The context other hooks of the delivery share is not modified.
    expect(shared.checkChanges).toBeUndefined();
    expect(await gate(hook({ changeMergeWindowSeconds: 0 }), checkRun('lint', 'failure'))).toMatchObject({ result: { data: { skipped: 'no change', previous: 'fail' } } });
  });

  test('a push that fails three checks fires once, with all three', async () => {
    vi.useFakeTimers();
    const results = [];
    for (const name of ['lint', 'test', 'build']) results.push(await gate(hook(), checkRun(name, 'failure')));
    expect(results.map((r) => 'result' in r && (r.result.data as { merged: boolean }).merged)).toEqual([false, true, true]);
    expect(fired).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(fired).toHaveLength(1));
    expect(fired[0].checkChanges?.map((c) => c.name)).toEqual(['lint', 'test', 'build']);
    expect(describeChanges(fired[0].checkChanges!)).toBe('Checks that turned failing on acme/app#7:\n- lint: failure\n- test: failure\n- build: failure');
    expect(await gate(hook(), checkRun('test', 'failure'))).toMatchObject({ result: { data: { skipped: 'no change' } } });
  });

  test('a re-run that passes inside the window is not overwritten by the stale failure', async () => {
    vi.useFakeTimers();
    await gate(hook(), checkRun('lint', 'failure'));
    await vi.advanceTimersByTimeAsync(30_000);
    await gate(hook(), checkRun('lint', 'success'));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(fired).toHaveLength(1));
    // The next failure is a change again.
    expect(await gate(hook({ changeMergeWindowSeconds: 0 }), checkRun('lint', 'failure'))).toHaveProperty('context');
  });

  test('another pull request is its own subject', async () => {
    vi.useFakeTimers();
    await gate(hook(), checkRun('lint', 'failure', 7));
    await gate(hook(), checkRun('lint', 'failure', 8));
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(fired).toHaveLength(2));
  });

  test('passes through what it does not gate', async () => {
    const comment: TriggerContext = { webhook: { path: 'gh', method: 'POST', headers: { 'x-github-event': 'issue_comment' }, body: { action: 'created', repository: { full_name: 'acme/app' } } } };
    expect(await gate(hook(), comment)).toEqual({ context: comment });
    const green = checkRun('lint', 'success');
    expect(await gate(hook({ onlyOnChange: false }), green)).toEqual({ context: green });
    expect(await gate(hook({ readOnly: true, orchestrated: false }), green)).toEqual({ context: green });
    const decided = { ...green, checkChanges: [] };
    expect(await gate(hook(), decided)).toEqual({ context: decided });
  });
});
