import { afterAll, describe, expect, test } from 'vitest';
import { setCapabilitiesForTest } from '@/core/capabilities/gates';
import { capabilityRefused } from './capability-guard';

describe('capabilityRefused', () => {
  afterAll(() => setCapabilitiesForTest({ embedding: true }));

  test('a capability that is not configured answers 409 with what is missing and where to set it up', () => {
    setCapabilitiesForTest({ embedding: false });
    const set: { status?: number } = {};
    expect(capabilityRefused(set, 'embedding')).toEqual({
      error: expect.stringMatching(/embedding model/),
      code: 'capability_not_configured',
      capability: 'embedding',
      setupHref: '/topics',
    });
    expect(set.status).toBe(409);
  });

  test('configured: nothing to refuse, the status is untouched', () => {
    setCapabilitiesForTest({ embedding: true });
    const set: { status?: number } = {};
    expect(capabilityRefused(set, 'embedding')).toBeNull();
    expect(set.status).toBeUndefined();
  });
});
