/**
 * Phase 3f — docker-isolation helper tests.
 *
 * The pure helpers (`userLabel`, `userNetworkName`, the *Flags
 * generators, `isolationActive`) need no Docker daemon — they're
 * straight derivations. The `inspectOwnership` / `ensureUserNetwork`
 * helpers shell out to `docker`; those tests are gated on docker
 * being available and are skipped otherwise.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

const hasDocker = ['/usr/bin/docker', '/usr/local/bin/docker', '/bin/docker']
  .some((p) => existsSync(p));

beforeAll(() => {
  process.env.MASTER_KEY ??= 'a'.repeat(64);
  process.env.JWT_SECRET ??= 'b'.repeat(32);
  process.env.SESSION_SECRET ??= 'c'.repeat(32);
  process.env.LOG_LEVEL ??= 'error';
});

afterEach(async () => {
  // Reset config flags between tests.
  const { getConfig } = await import('@/config');
  getConfig().security.dockerIsolation = 'off';
});

describe('userLabel', () => {
  test('returns octipus.user_id=<userId>', async () => {
    const { userLabel } = await import('@/security/docker-isolation');
    expect(userLabel('11111111-1111-1111-1111-111111111111'))
      .toBe('octipus.user_id=11111111-1111-1111-1111-111111111111');
  });
});

describe('userNetworkName', () => {
  test('strips non-alphanumerics and uses first 12 chars', async () => {
    const { userNetworkName } = await import('@/security/docker-isolation');
    // First 12 alphanumeric chars of the uuid (no dashes).
    expect(userNetworkName('abcdef12-3456-7890-1234-567890abcdef'))
      .toBe('octipus_user_abcdef123456');
  });

  test('survives unusual ids', async () => {
    const { userNetworkName } = await import('@/security/docker-isolation');
    expect(userNetworkName('user/123')).toBe('octipus_user_user123');
  });
});

describe('isolationActive', () => {
  test('false when dockerIsolation is "off"', async () => {
    const { isolationActive } = await import('@/security/docker-isolation');
    const { getConfig } = await import('@/config');
    getConfig().security.dockerIsolation = 'off';
    expect(isolationActive('11111111-1111-1111-1111-111111111111')).toBe(false);
  });

  test('false for system / local / empty userIds even when on', async () => {
    const { isolationActive } = await import('@/security/docker-isolation');
    const { getConfig } = await import('@/config');
    getConfig().security.dockerIsolation = 'enforce';
    expect(isolationActive('system')).toBe(false);
    expect(isolationActive('local')).toBe(false);
    expect(isolationActive('')).toBe(false);
    expect(isolationActive(null)).toBe(false);
  });

  test('true when both flags on and a real userId is supplied', async () => {
    const { isolationActive } = await import('@/security/docker-isolation');
    const { getConfig } = await import('@/config');
    getConfig().security.dockerIsolation = 'enforce';
    expect(isolationActive('11111111-1111-1111-1111-111111111111')).toBe(true);
  });
});

describe('flag generators', () => {
  test('listFilterFlags is empty when isolation is off', async () => {
    const { listFilterFlags } = await import('@/security/docker-isolation');
    expect(listFilterFlags('11111111-1111-1111-1111-111111111111')).toEqual([]);
  });

  test('listFilterFlags emits --filter label=… when on', async () => {
    const { listFilterFlags } = await import('@/security/docker-isolation');
    const { getConfig } = await import('@/config');
    getConfig().security.dockerIsolation = 'enforce';
    expect(listFilterFlags('11111111-1111-1111-1111-111111111111')).toEqual([
      '--filter', 'label=octipus.user_id=11111111-1111-1111-1111-111111111111',
    ]);
  });

  test('runIsolationFlags emits --label and --network when on', async () => {
    const { runIsolationFlags } = await import('@/security/docker-isolation');
    const { getConfig } = await import('@/config');
    getConfig().security.dockerIsolation = 'enforce';
    const flags = runIsolationFlags('11111111-1111-1111-1111-111111111111');
    expect(flags).toContain('--label');
    expect(flags).toContain('octipus.user_id=11111111-1111-1111-1111-111111111111');
    expect(flags).toContain('--network');
    expect(flags).toContain('octipus_user_111111111111');
  });

  test('buildIsolationFlags emits only --label (image builds have no network)', async () => {
    const { buildIsolationFlags } = await import('@/security/docker-isolation');
    const { getConfig } = await import('@/config');
    getConfig().security.dockerIsolation = 'enforce';
    const flags = buildIsolationFlags('11111111-1111-1111-1111-111111111111');
    expect(flags).toEqual([
      '--label', 'octipus.user_id=11111111-1111-1111-1111-111111111111',
    ]);
  });
});

describe.skipIf(!hasDocker)('inspectOwnership against a live Docker daemon', () => {
  // We don't actually create containers from this test — that risks
  // leaving state on the host. The "container doesn't exist" path is
  // enough to verify the helper handles a real `docker inspect`
  // invocation correctly.
  test('returns "not_found" for a nonexistent container', async () => {
    const { inspectOwnership } = await import('@/security/docker-isolation');
    const r = await inspectOwnership(
      'octipus-3f-doesnotexist-' + Math.random().toString(36).slice(2, 8),
      '11111111-1111-1111-1111-111111111111',
    );
    expect(r).toBe('not_found');
  });
});
