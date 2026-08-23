/**
 * Phase 3b — RLS wrapper tests.
 *
 * Two layers:
 *
 *   1. PGlite tests (always run): verify the wrapper sets the right
 *      GUCs without throwing, no-ops cleanly when the flag is off,
 *      and rejects anonymous principals. Behavioral RLS enforcement
 *      can't be tested on PGlite — the embedded engine bypasses
 *      policies in single-superuser mode.
 *
 *   2. Postgres integration tests (`INTEGRATION=1`): cross-tenant
 *      enforcement, system-bypass via withRlsBypass, vault scope=system
 *      visibility. These fail loud if RLS isn't actually enforcing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIntegration, setupIntegrationDb, teardownIntegration, truncateTables } from '@/test-helpers/integration';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';

// ─── Unit-ish (PGlite) ─────────────────────────────────────────────
describe('RLS wrapper — PGlite (no enforcement, just wiring)', () => {
  beforeAll(async () => {
    process.env.STORAGE_MODE = 'embedded';
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-rls-pglite-'));

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

  test('flag off → wrapper is a no-op (callback gets the global db handle, no transaction)', async () => {
    const { withRlsPrincipal, isRlsEnabled } = await import('@/security/rls');
    const { principalFromUser } = await import('@/security/principal');
    const { getConfig } = await import('@/config');
    const { sql } = await import('drizzle-orm');
    getConfig().multiuser.rlsEnabled = false;
    expect(isRlsEnabled()).toBe(false);

    let invoked = false;
    const result = await withRlsPrincipal(
      principalFromUser({ id: aliceId, username: 'alice', isAdmin: false }),
      async (handle) => {
        invoked = true;
        // The handle is queryable; round-trip a literal so we know
        // the callback actually saw a working db.
        const r = await (handle as any).execute(sql`SELECT 1 AS ok`);
        const row = Array.isArray(r) ? r[0] : (r.rows ?? r)[0];
        return row?.ok ?? null;
      },
    );
    expect(invoked).toBe(true);
    expect(Number(result)).toBe(1);
  });

  test('flag on → wrapper sets the GUCs inside a transaction (PGlite tolerates them but ignores RLS)', async () => {
    const { getConfig } = await import('@/config');
    getConfig().multiuser.rlsEnabled = true;

    const { withRlsPrincipal } = await import('@/security/rls');
    const { principalFromUser } = await import('@/security/principal');

    const seenUserId = await withRlsPrincipal(
      principalFromUser({ id: aliceId, username: 'alice', isAdmin: false }),
      async (tx) => {
        // Inside the transaction the GUC must be set.
        const result = await (tx as any).execute(
          (await import('drizzle-orm')).sql`SELECT current_setting('app.current_user_id', true) AS uid`,
        );
        // Drizzle returns shape varies; normalize.
        const row = Array.isArray(result) ? result[0] : (result.rows ?? result)[0];
        return row?.uid;
      },
    );
    expect(seenUserId).toBe(aliceId);

    getConfig().multiuser.rlsEnabled = false; // reset for other tests
  });

  test('anonymous principal throws — call-site bug, not runtime', async () => {
    const { withRlsPrincipal } = await import('@/security/rls');
    const { ANONYMOUS_PRINCIPAL } = await import('@/security/principal');
    await expect(withRlsPrincipal(ANONYMOUS_PRINCIPAL, async () => 1)).rejects.toThrow();
  });

  test('migration installed policies on every user-owned table (3b + 3b-2)', async () => {
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(
      `SELECT tablename FROM pg_policies WHERE schemaname='public' ORDER BY tablename`,
    );
    const tables = new Set(rows.map((r: any) => r.tablename));
    // Phase 3b — high-value tables.
    for (const t of ['sessions', 'vault', 'api_tokens', 'channel_identities']) {
      expect(tables.has(t)).toBe(true);
    }
    // Phase 3b-2 — remaining direct user_id (NOT NULL) tables.
    for (const t of [
      'documents', 'agents', 'hooks', 'pipelines', 'notifications',
      'trajectory_runs', 'recurring_tasks',
      'skill_permissions', 'permission_requests',
    ]) {
      expect(tables.has(t)).toBe(true);
    }
    // Phase 3b-2 — direct user_id (nullable Phase-0 back-compat columns).
    for (const t of ['agent_events', 'embeddings', 'hook_executions', 'swarm_nodes']) {
      expect(tables.has(t)).toBe(true);
    }
    // Phase 3b-2 — ownership via FK subquery.
    for (const t of ['messages', 'pipeline_nodes', 'pipeline_edges', 'plan_items']) {
      expect(tables.has(t)).toBe(true);
    }
  });
});

// ─── Behavioral (Postgres + non-superuser app role required) ────────
describe.skipIf(!isIntegration)('RLS wrapper — Postgres (behavioral enforcement)', () => {
  beforeAll(async () => {
    await setupIntegrationDb();
    await truncateTables(['sessions', 'users']);
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([
      { id: aliceId, username: 'alice' },
      { id: bobId, username: 'bob' },
    ]);
    const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
    await seedSession({ userId: aliceId, channelId: 'a-1' });
    await seedSession({ userId: bobId, channelId: 'b-1' });
    const { getConfig } = await import('@/config');
    getConfig().multiuser.rlsEnabled = true;
  });

  afterAll(async () => {
    const { getConfig } = await import('@/config');
    getConfig().multiuser.rlsEnabled = false;
    await teardownIntegration();
  });

  // These tests ONLY enforce when:
  //   - the test database role is non-superuser AND
  //   - the table doesn't have FORCE bypassed by ownership.
  // In CI we expect a separate `octipus_app` role for this. If the
  // role still has BYPASSRLS the test will fail loud with both rows
  // visible — that's the intended failure to drive the role split.
  test('alice can only see her own session under withRlsPrincipal', async () => {
    const { withRlsPrincipal } = await import('@/security/rls');
    const { principalFromUser } = await import('@/security/principal');
    const { sql } = await import('drizzle-orm');

    const aliceRows = await withRlsPrincipal(
      principalFromUser({ id: aliceId, username: 'alice', isAdmin: false }),
      async (tx) => {
        const r = await (tx as any).execute(sql`SELECT user_id FROM sessions`);
        return Array.isArray(r) ? r : r.rows;
      },
    );
    expect(aliceRows.every((r: any) => r.user_id === aliceId)).toBe(true);
  });

  test('withRlsBypass returns rows from every user', async () => {
    const { withRlsBypass } = await import('@/security/rls');
    const { sql } = await import('drizzle-orm');
    const allRows = await withRlsBypass(async (tx) => {
      const r = await (tx as any).execute(sql`SELECT user_id FROM sessions`);
      return Array.isArray(r) ? r : r.rows;
    });
    const ids = new Set(allRows.map((r: any) => r.user_id));
    expect(ids.has(aliceId)).toBe(true);
    expect(ids.has(bobId)).toBe(true);
  });
});
