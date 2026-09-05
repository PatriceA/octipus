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
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
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
