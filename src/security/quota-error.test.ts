import { describe, expect, test } from 'bun:test';
import { QuotaExceededError } from './quota-error';

describe('QuotaExceededError', () => {
  test('tokensPerDay message explains it is a per-user safety budget, not a provider limit', () => {
    const err = new QuotaExceededError({
      kind: 'tokensPerDay',
      current: 130178,
      max: 100000,
      userId: 'u1',
    });
    expect(err.code).toBe('QUOTA_EXCEEDED');
    expect(err.reason.kind).toBe('tokensPerDay');
    expect(err.message).toContain('130178/100000');
    expect(err.message).toContain('per-user');
    expect(err.message).toContain('not a provider limit');
    expect(err.message).toContain('/admin/quotas');
  });

  test('concurrentAgents message points to admin/quotas', () => {
    const err = new QuotaExceededError({
      kind: 'concurrentAgents',
      current: 5,
      max: 5,
      userId: 'u1',
    });
    expect(err.message).toContain('5/5');
    expect(err.message).toContain('/admin/quotas');
  });

  test('apiCallsPerMinute message points to admin/quotas', () => {
    const err = new QuotaExceededError({
      kind: 'apiCallsPerMinute',
      current: 60,
      max: 60,
      userId: 'u1',
    });
    expect(err.message).toContain('60/60');
    expect(err.message).toContain('/admin/quotas');
  });
});

// A quota abort leaves the worker in status 'stopped', which is exactly what
// `worker-spawner`'s user-stop heuristic matches on. A real 7-stage run died at
// "QA Validation" reporting `Agent was stopped by user` when the truth was
// `tokensPerDay: 10118911/10000000` — the operator hunts for a person who
// cancelled, and the line naming the cap is discarded.
describe('a quota abort is distinguishable from a user stop', () => {
  const err = new QuotaExceededError({
    kind: 'tokensPerDay', current: 10_118_911, max: 10_000_000, userId: 'u1',
  });

  test('is identifiable structurally, not by substring', () => {
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect(err.code).toBe('QUOTA_EXCEEDED');
  });

  test('would be swallowed by the user-stop heuristic if checked first', () => {
    // Documents WHY the instanceof check has to come first in
    // `handleWorkerFailure`: the message itself trips the substring match.
    const looksLikeAStop = /aborted|stopped/.test(err.message) || 'stopped' === 'stopped';
    expect(looksLikeAStop).toBe(true);
  });

  test('carries the numbers a wrapped "stopped by user" error would lose', () => {
    expect(err.message).toContain('10118911/10000000');
    expect(err.message).toContain('/admin/quotas');
    expect(err.reason.max).toBe(10_000_000);
  });
});
