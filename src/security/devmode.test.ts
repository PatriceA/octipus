/**
 * devMode authorization policy.
 *
 * devMode/projectPath let the caller point the agent's filesystem tools at an
 * arbitrary host path — a sandbox escape for a non-admin. Octipus is always
 * multi-user, so it is an admin-only capability regardless of config.
 */
import { describe, expect, test } from 'bun:test';
import { devModeAllowed } from './devmode';

describe('devModeAllowed', () => {
  test('allowed only for admins', () => {
    expect(devModeAllowed(true)).toBe(true);
    expect(devModeAllowed(false)).toBe(false);
  });
});
