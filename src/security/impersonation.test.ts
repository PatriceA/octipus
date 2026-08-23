/**
 * Phase 3d — ImpersonationManager tests.
 *
 * Verifies:
 *   - start: rejects non-admin, self-target, missing target.
 *   - start: writes paired audit_log rows under both actor + target.
 *   - findActive: hits the row from a session-token hash; returns
 *     null after expiry.
 *   - stop: closes the row, sets ended_reason='explicit'.
 *   - replace semantics: a new start while another is active closes
 *     the prior one (ended_reason='replaced').
 *   - reapExpired sweeps unfinished rows past expires_at.
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

const adminId = '11111111-1111-1111-1111-111111111111';
const targetId = '22222222-2222-2222-2222-222222222222';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-imp-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: adminId, username: 'root', isAdmin: true },
    { id: targetId, username: 'alice' },
  ]);
  const { _resetImpersonationManagerForTests } = await import('@/security/impersonation');
  _resetImpersonationManagerForTests();
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

const adminIdent = { id: adminId, username: 'root', isAdmin: true };

describe('start', () => {
  test('rejects non-admin actors', async () => {
    const { getImpersonationManager } = await import('@/security/impersonation');
    const r = await getImpersonationManager().start(
      { id: targetId, username: 'alice', isAdmin: false },
      adminId,
      'tok-anything',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_admin');
  });

  test('rejects self-impersonation', async () => {
    const { getImpersonationManager } = await import('@/security/impersonation');
    const r = await getImpersonationManager().start(adminIdent, adminId, 'tok');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('self');
  });

  test('rejects missing target', async () => {
    const { getImpersonationManager } = await import('@/security/impersonation');
    const r = await getImpersonationManager().start(adminIdent, '00000000-0000-0000-0000-000000000000', 'tok');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('target_not_found');
  });

  test('happy path: inserts row + paired audit entries under actor and target', async () => {
    const { getImpersonationManager } = await import('@/security/impersonation');
    const r = await getImpersonationManager().start(
      adminIdent, targetId, 'session-tok-happy', { reason: 'support ticket #42' },
    );
    expect(r.ok).toBe(true);

    const { queryRaw } = await import('@/db/postgres');
    const audit = await queryRaw(
      `SELECT user_id, details FROM audit_log
       WHERE resource_type='impersonation_session' AND action='login'
       ORDER BY created_at DESC LIMIT 2`,
    );
    expect(audit.rows).toHaveLength(2);
    const userIds = audit.rows.map((r: any) => r.user_id).sort();
    expect(userIds).toEqual([adminId, targetId].sort());
  });
});

describe('findActive + stop', () => {
  test('findActive hits the row by session-token hash', async () => {
    const { getImpersonationManager } = await import('@/security/impersonation');
    const mgr = getImpersonationManager();
    const token = 'session-tok-find';
    await mgr.start(adminIdent, targetId, token);

    const found = await mgr.findActive(token);
    expect(found).not.toBeNull();
    expect(found?.actorUserId).toBe(adminId);
    expect(found?.targetUserId).toBe(targetId);

    // Different token → no match.
    expect(await mgr.findActive('different-token')).toBeNull();
  });

  test('stop closes the row and writes paired logout audit entries', async () => {
    const { getImpersonationManager } = await import('@/security/impersonation');
    const mgr = getImpersonationManager();
    const token = 'session-tok-stop';
    await mgr.start(adminIdent, targetId, token);

    const stopped = await mgr.stop(token);
    expect(stopped).not.toBeNull();
    expect(stopped?.endedReason).toBe('explicit');

    expect(await mgr.findActive(token)).toBeNull();

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(
      `SELECT user_id FROM audit_log
       WHERE resource_type='impersonation_session' AND action='logout'
       AND resource_id='${stopped!.id}'`,
    );
    expect(rows).toHaveLength(2);
  });

  test('stop is idempotent — second call returns null', async () => {
    const { getImpersonationManager } = await import('@/security/impersonation');
    const mgr = getImpersonationManager();
    await mgr.start(adminIdent, targetId, 'tok-stop-twice');
    expect(await mgr.stop('tok-stop-twice')).not.toBeNull();
    expect(await mgr.stop('tok-stop-twice')).toBeNull();
  });
});

describe('replace semantics', () => {
  test('starting a new session closes the prior active one', async () => {
    const { getImpersonationManager } = await import('@/security/impersonation');
    const mgr = getImpersonationManager();
    await mgr.start(adminIdent, targetId, 'tok-replace-1');
    await mgr.start(adminIdent, targetId, 'tok-replace-2');

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(
      `SELECT actor_session_hash, ended_reason FROM impersonation_sessions
       WHERE actor_user_id='${adminId}' AND ended_at IS NOT NULL
       ORDER BY started_at DESC LIMIT 1`,
    );
    expect(rows[0]?.ended_reason).toBe('replaced');
  });
});

describe('reapExpired', () => {
  test('sweeps unfinished rows past expires_at', async () => {
    const { getImpersonationManager } = await import('@/security/impersonation');
    const mgr = getImpersonationManager();
    await mgr.start(adminIdent, targetId, 'tok-expire-me', { ttlMs: 60_000 });

    // Force the row's expires_at into the past. Inline the hash
    // because PGlite's executeRaw doesn't accept parameterized SQL.
    const { executeRaw } = await import('@/db/postgres');
    const { hashSessionToken } = await import('@/security/impersonation');
    const hash = hashSessionToken('tok-expire-me');
    await executeRaw(
      `UPDATE impersonation_sessions SET expires_at = now() - interval '1 minute'
       WHERE actor_session_hash = '${hash}' AND ended_at IS NULL`,
    );

    const reaped = await mgr.reapExpired();
    expect(reaped).toBeGreaterThanOrEqual(1);
    expect(await mgr.findActive('tok-expire-me')).toBeNull();
  });
});
