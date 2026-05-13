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
