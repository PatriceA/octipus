/**
 * Phase 1c — root agent permission gate.
 *
 * Verifies the cross-tenant guards added to PermissionManager:
 *
 *   - alice cannot approve OR deny bob's pending request via
 *     PermissionManager.approve / deny (silent no-op, returns false,
 *     row stays pending).
 *   - admin override (`{ admin: true }`) lets the resolution succeed
 *     regardless of ownership.
 *   - getPendingRequests(userId) returns only that user's rows.
 *
 * Backed by ephemeral PGlite — no Docker.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-perm-iso-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: aliceId, username: 'alice' },
    { id: bobId, username: 'bob' },
  ]);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function createPendingRequest(userId: string): Promise<string> {
  const { getPermissionManager } = await import('@/security/permissions');
  const pm = getPermissionManager();
  return pm.requestApproval(
    userId,
    'agent-' + userId.slice(0, 4),
    'shell',
    'execute',
    { command: 'ls' },
    undefined,
    'shell',
  );
}

describe('PermissionManager.approve cross-tenant', () => {
  test('alice cannot approve bob’s pending request — silent no-op', async () => {
    const { getPermissionManager } = await import('@/security/permissions');
    const pm = getPermissionManager();

    const reqId = await createPendingRequest(bobId);

    // Alice attempts to approve — must return false, row stays pending.
    const ok = await pm.approve(reqId, aliceId);
    expect(ok).toBe(false);

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT status FROM permission_requests WHERE id='${reqId}'`);
    expect(rows[0]?.status).toBe('pending');
  });

  test('bob can approve his own request', async () => {
    const { getPermissionManager } = await import('@/security/permissions');
    const pm = getPermissionManager();

    const reqId = await createPendingRequest(bobId);
    const ok = await pm.approve(reqId, bobId);
    expect(ok).toBe(true);

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT status, resolved_by FROM permission_requests WHERE id='${reqId}'`);
    expect(rows[0]?.status).toBe('approved');
    expect(rows[0]?.resolved_by).toBe(bobId);
  });

  test('admin override lets a non-owner approve', async () => {
    const { getPermissionManager } = await import('@/security/permissions');
    const pm = getPermissionManager();

    const reqId = await createPendingRequest(bobId);
    const ok = await pm.approve(reqId, aliceId, undefined, { admin: true });
    expect(ok).toBe(true);

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT status FROM permission_requests WHERE id='${reqId}'`);
    expect(rows[0]?.status).toBe('approved');
  });
});

describe('PermissionManager.deny cross-tenant', () => {
  test('alice cannot deny bob’s pending request', async () => {
    const { getPermissionManager } = await import('@/security/permissions');
    const pm = getPermissionManager();

    const reqId = await createPendingRequest(bobId);
    const ok = await pm.deny(reqId, aliceId, 'pwned');
    expect(ok).toBe(false);

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT status FROM permission_requests WHERE id='${reqId}'`);
    expect(rows[0]?.status).toBe('pending');
  });

  test('admin override lets a non-owner deny', async () => {
    const { getPermissionManager } = await import('@/security/permissions');
    const pm = getPermissionManager();

    const reqId = await createPendingRequest(bobId);
    const ok = await pm.deny(reqId, aliceId, 'override', { admin: true });
    expect(ok).toBe(true);
  });
});

describe('PermissionManager.getPendingRequests', () => {
  test('returns only the principal’s pending rows', async () => {
    await createPendingRequest(aliceId);
    await createPendingRequest(bobId);
    const { getPermissionManager } = await import('@/security/permissions');
    const pm = getPermissionManager();

    const aliceRows = await pm.getPendingRequests(aliceId);
    expect(aliceRows.every((r) => r.userId === aliceId)).toBe(true);
    expect(aliceRows.length).toBeGreaterThan(0);

    const bobRows = await pm.getPendingRequests(bobId);
    expect(bobRows.every((r) => r.userId === bobId)).toBe(true);
    expect(bobRows.find((r) => r.userId === aliceId)).toBeUndefined();
  });
});

describe('multiuser.enforcePermissions flag', () => {
  test('default is true (multi-user isolation enforced; legacy single-user opts out via MULTIUSER=false)', async () => {
    // Local single-user installs commonly set MULTIUSER_ENFORCE_PERMISSIONS=false
    // in their .env so the legacy permissive bypass stays on. Clear it for
    // this test so the assertion exercises the actual default, not the
    // developer's local override.
    const previous = process.env.MULTIUSER_ENFORCE_PERMISSIONS;
    delete process.env.MULTIUSER_ENFORCE_PERMISSIONS;
    try {
      const { getConfig, resetConfig } = await import('@/config');
      resetConfig();
      expect(getConfig().multiuser.enforcePermissions).toBe(true);
    } finally {
      if (previous !== undefined) process.env.MULTIUSER_ENFORCE_PERMISSIONS = previous;
      const { resetConfig } = await import('@/config');
      resetConfig();
    }
  });
});

// Use the real manager and database so aliases cannot accidentally lose user,
// action, expiration, or condition filtering at the lookup boundary.
describe('CLI native permission identity compatibility', () => {
  beforeEach(async () => {
    const { getDb } = await import('@/db/postgres');
    const { toolPermissions } = await import('@/db/schema/permissions');
    await getDb().delete(toolPermissions);
    const { DEFAULT_PERMISSION_RULES, getPermissionRuleEngine } = await import('./permission-rules');
    getPermissionRuleEngine().load(DEFAULT_PERMISSION_RULES);
  });

  test('legacy stored DENY wins over new read defaults and explicit grants', async () => {
    const { getPermissionManager } = await import('./permissions');
    const pm = getPermissionManager();
    const denied = await pm.setPermission(aliceId, 'cli-native', 'Read', 'DENY', {
      expiresAt: new Date(Date.now() - 1),
    });
    await pm.setPermission(aliceId, 'cli-native:Read', 'Read', 'ALLOW');
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read')).toMatchObject({
      allowed: false, level: 'DENY', source: `permission:${denied.id}`,
    });
    expect(await pm.check(bobId, 'cli-native:Read', 'Read')).toMatchObject({ allowed: true });
    expect(await pm.check(aliceId, 'cli-native:Glob', 'Glob')).toMatchObject({ allowed: true });
  });

  test('legacy deny rules still match vendor arguments despite a specific grant', async () => {
    const { getPermissionManager } = await import('./permissions');
    const { getPermissionRuleEngine } = await import('./permission-rules');
    const pm = getPermissionManager();
    getPermissionRuleEngine().load({ allow: ['cli-native:Read(*)'], deny: ['cli-native(/secret:*)'] });
    await pm.setPermission(aliceId, 'cli-native:Read', 'Read', 'ALLOW');
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read', { file_path: '/secret/token' }))
      .toMatchObject({ allowed: false, level: 'DENY', source: 'rule' });
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read', { file_path: '/public/readme' }))
      .toMatchObject({ allowed: true });
  });

  test('legacy ASK policies and rules retain approval over new read defaults', async () => {
    const { getPermissionManager } = await import('./permissions');
    const { getPermissionRuleEngine } = await import('./permission-rules');
    const pm = getPermissionManager();
    await pm.setPermission(aliceId, 'cli-native', 'Read', 'ASK');
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read'))
      .toMatchObject({ allowed: false, level: 'ASK', requiresApproval: true });
    await pm.deletePermission(aliceId, 'cli-native', 'Read');
    getPermissionRuleEngine().load({ allow: ['cli-native:Read(*)'], ask: ['cli-native(*)'] });
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read'))
      .toMatchObject({ allowed: false, level: 'ASK', requiresApproval: true });
  });

  test('legacy scoped grants apply only to their session and path and still expire', async () => {
    const { getPermissionManager } = await import('./permissions');
    const pm = getPermissionManager();
    const conditions = [
      { type: 'session' as const, value: 'session-one' },
      { type: 'path_pattern' as const, value: '^/workspace/' },
    ];
    await pm.setPermission(aliceId, 'cli-native', 'Read', 'ALLOW', { conditions });
    const scope = { sessionId: 'session-one', workspaceId: null };
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read', { file_path: '/workspace/readme' }, scope))
      .toMatchObject({ allowed: true });
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read', { file_path: '/secret' }, scope))
      .toMatchObject({ allowed: false, requiresApproval: true });
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read', { file_path: '/workspace/readme' }, { ...scope, sessionId: 'another' }))
      .toMatchObject({ allowed: false, requiresApproval: true });
    await pm.setPermission(aliceId, 'cli-native', 'Read', 'ALLOW', { conditions, expiresAt: new Date(Date.now() - 1) });
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read', { file_path: '/workspace/readme' }, scope))
      .toMatchObject({ allowed: false, reason: 'Permission expired' });
  });

  test('specific policies override non-denying legacy policies, while specific denials remain final', async () => {
    const { getPermissionManager } = await import('./permissions');
    const pm = getPermissionManager();
    await pm.setPermission(aliceId, 'cli-native', 'Read', 'ASK');
    const specific = await pm.setPermission(aliceId, 'cli-native:Read', 'Read', 'ALLOW');
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read'))
      .toMatchObject({ allowed: true, source: `permission:${specific.id}` });
    await pm.setPermission(aliceId, 'cli-native', 'Read', 'ALLOW');
    await pm.setPermission(aliceId, 'cli-native:Read', 'Read', 'DENY');
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read')).toMatchObject({ allowed: false, level: 'DENY' });
  });

  test('legacy rate-limit accounting keeps its original identity during fallback and revalidation', async () => {
    const { getPermissionManager } = await import('./permissions');
    const { getRateLimiter } = await import('./rate-limiter');
    const pm = getPermissionManager();
    const limiter = vi.spyOn(getRateLimiter(), 'check').mockResolvedValue({ allowed: true, remaining: 1 });
    try {
      await pm.setPermission(aliceId, 'cli-native', 'Read', 'ALLOW', {
        conditions: [{ type: 'rate_limit', value: { maxRequests: 2, windowMs: 60_000 } }],
      });
      expect(await pm.check(aliceId, 'cli-native:Read', 'Read')).toMatchObject({ allowed: true });
      expect(limiter).toHaveBeenCalledWith(`perm:rl:${aliceId}:cli-native:Read`, 2, 60);
      await pm.check(aliceId, 'cli-native:Read', 'Read', {}, undefined, { revalidate: true });
      expect(limiter).toHaveBeenCalledTimes(1);
    } finally { limiter.mockRestore(); }
  });

  test('compatibility does not alias unrelated tools', async () => {
    const { getPermissionManager } = await import('./permissions');
    const pm = getPermissionManager();
    await pm.setPermission(aliceId, 'cli-native', 'Read', 'DENY');
    expect(await pm.check(aliceId, 'other:Read', 'Read')).toMatchObject({ level: 'ASK' });
  });
});
