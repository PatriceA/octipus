/**
 * The federation identity is created once, on real Postgres
 * (docs/plans/federation-spec.md §4.1).
 *
 * PGlite is one in-process connection: the "concurrent" first calls in
 * `identity.test.ts` run one after another there, so they only pin the SQL.
 * Here every transaction gets its own pooled connection and the advisory lock
 * in `createSystemSecretOnce` is what keeps two first callers from storing
 * two keys.
 *
 * Runs in the integration lane (`npm run test:integration`, INTEGRATION=1).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { isIntegration, setupIntegrationDb, teardownIntegration } from '@/test-helpers/integration';

// biome-ignore lint/suspicious/noExplicitAny: raw rows
async function q(sql: string, params: unknown[] = []): Promise<any[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql, params)).rows;
}

const IDENTITY = 'federation.identity';

describe.skipIf(!isIntegration)('federation identity on Postgres (Integration)', () => {
  beforeAll(async () => {
    await setupIntegrationDb();
    const { initializeVault, _resetVaultForTests } = await import('@/security/vault');
    _resetVaultForTests();
    await initializeVault();
  }, 60_000);

  afterAll(async () => {
    await q(`DELETE FROM vault WHERE name = $1 AND user_id = 'system'`, [IDENTITY]);
    await teardownIntegration();
  });

  test('many concurrent first calls of createSystemSecretOnce store exactly one row', async () => {
    const { getVault } = await import('@/security/vault');
    const vault = getVault();
    const name = `test.lock.${randomUUID()}`;
    try {
      let made = 0;
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => vault.createSystemSecretOnce(name, () => {
        made++;
        return `value-${i}`;
      }, { credentialType: 'api_key', description: 'advisory lock race' })));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(made).toBe(1);
      const rows = await q(`SELECT id FROM vault WHERE name = $1 AND scope = 'system' AND is_active`, [name]);
      expect(rows).toHaveLength(1);
    } finally {
      await q(`DELETE FROM vault WHERE name = $1`, [name]);
    }
  });

  test('concurrent first loads of the identity agree on one key', async () => {
    await q(`DELETE FROM vault WHERE name = $1 AND user_id = 'system'`, [IDENTITY]);
    const { loadInstanceIdentity } = await import('./identity');
    const ids = await Promise.all(Array.from({ length: 8 }, () => loadInstanceIdentity()));
    expect(new Set(ids.map((i) => i.instanceId)).size).toBe(1);
    const rows = await q(`SELECT id FROM vault WHERE name = $1 AND scope = 'system' AND is_active`, [IDENTITY]);
    expect(rows).toHaveLength(1);
  });
});
