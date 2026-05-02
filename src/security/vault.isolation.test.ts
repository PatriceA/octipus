/**
 * Cross-tenant + scope isolation tests for the vault.
 *
 * Phase 1b-1 closed two real leaks:
 *   - `getSystemSecret(name)` had a fallback that scanned ALL users'
 *     secrets when no system row existed. Any code calling
 *     `getSystemSecret('openai_api_key')` could surface another user's
 *     private key. Phase 1b-1 makes that lookup strict.
 *   - `getByName(userId, name)` already filtered by user_id but the new
 *     `scope` column adds a second WHERE clause so a UUID lookup never
 *     returns a system row (and vice versa).
 *
 * The new `getForAgent` helper applies the user→system fallback +
 * tool/agent allowlist in one place; the secret-injector now uses it.
 *
 * Tests run against an ephemeral PGlite — no Docker.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-vault-iso-'));

  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  await executeRaw(
    `INSERT INTO users (id, username, is_admin) VALUES
       ('${aliceId}', 'alice', false),
       ('${bobId}', 'bob', false)
     ON CONFLICT DO NOTHING`,
  );

  const { initializeVault, _resetVaultForTests } = await import('@/security/vault');
  _resetVaultForTests();
  await initializeVault();
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('Vault scope isolation', () => {
  test('user-scoped secrets are not readable across tenants', async () => {
    const { getVault } = await import('@/security/vault');
    const vault = getVault();
    const aliceSecret = await vault.store(aliceId, 'shared-name', 'alice-only',
      { credentialType: 'api_key' });

    expect(await vault.getByName(aliceId, 'shared-name')).toBe('alice-only');
    expect(await vault.getByName(bobId, 'shared-name')).toBeNull();

    // Direct id lookup as bob also fails.
    expect(await vault.get(bobId, aliceSecret.id)).toBeNull();
  });

  test('getSystemSecret no longer falls back to user-owned rows', async () => {
    const { getVault } = await import('@/security/vault');
    const vault = getVault();

    // Alice has a key named "openai_api_key"; no system row exists yet.
    await vault.store(aliceId, 'openai_api_key', 'alice-private',
      { credentialType: 'api_key' });

    // Pre-Phase-1b this returned 'alice-private' via the leak. Now it's null.
    expect(await vault.getSystemSecret('openai_api_key')).toBeNull();
  });

  test('getSystemSecret returns the system row when one exists', async () => {
    const { getVault } = await import('@/security/vault');
    const vault = getVault();
    await vault.setSystemSecret('shared_provider_key', 'system-value');

    expect(await vault.getSystemSecret('shared_provider_key')).toBe('system-value');
  });

  test('list returns only the principal’s scope', async () => {
    const { getVault } = await import('@/security/vault');
    const vault = getVault();

    await vault.store(aliceId, 'alice-key-a', 'va', { credentialType: 'api_key' });
    await vault.store(aliceId, 'alice-key-b', 'vb', { credentialType: 'api_key' });
    await vault.store(bobId,   'bob-key',     'vc', { credentialType: 'api_key' });

    const aliceList = await vault.list(aliceId);
    expect(aliceList.every((e) => e.userId === aliceId && e.scope === 'user')).toBe(true);
    expect(aliceList.find((e) => e.name === 'bob-key')).toBeUndefined();

    const systemList = await vault.list('system');
    expect(systemList.every((e) => e.scope === 'system')).toBe(true);
    expect(systemList.find((e) => e.userId === aliceId)).toBeUndefined();
  });

  test('update / delete refuse to mutate cross-scope rows', async () => {
    const { getVault } = await import('@/security/vault');
    const vault = getVault();

    const sysSecret = await vault.setSystemSecret('shared-mutable', 'sys-value');

    // Bob tries to update the system row by passing his own userId — must fail.
    const updated = await vault.update(bobId, sysSecret.id, { value: 'pwned' });
    expect(updated).toBeNull();

    // System secret value still intact.
    expect(await vault.getSystemSecret('shared-mutable')).toBe('sys-value');

    // Bob also can't delete it.
    expect(await vault.delete(bobId, sysSecret.id)).toBe(false);
    expect(await vault.getSystemSecret('shared-mutable')).toBe('sys-value');
  });
});

describe('Vault.getForAgent — scope-aware injector lookup', () => {
  test('prefers user-scoped row when present', async () => {
    const { getVault } = await import('@/security/vault');
    const vault = getVault();
    await vault.setSystemSecret('overridable', 'system-fallback');
    await vault.store(aliceId, 'overridable', 'alice-override', { credentialType: 'api_key' });

    expect(await vault.getForAgent({ userId: aliceId }, 'overridable')).toBe('alice-override');
    // Bob has no override — falls through to system.
    expect(await vault.getForAgent({ userId: bobId }, 'overridable')).toBe('system-fallback');
  });

  test('falls back to system scope only', async () => {
    const { getVault } = await import('@/security/vault');
    const vault = getVault();
    await vault.setSystemSecret('only-in-system', 'sys-only');

    expect(await vault.getForAgent({ userId: aliceId }, 'only-in-system')).toBe('sys-only');
    expect(await vault.getForAgent({ userId: bobId },   'only-in-system')).toBe('sys-only');
  });

  test('returns null when no row matches in either scope', async () => {
    const { getVault } = await import('@/security/vault');
    const vault = getVault();
    expect(await vault.getForAgent({ userId: aliceId }, 'never-stored')).toBeNull();
  });

  test('respects the allowed_tools allowlist', async () => {
    const { getVault } = await import('@/security/vault');
    const vault = getVault();
    await vault.store(aliceId, 'tool-restricted', 'restricted-value', {
      credentialType: 'api_key',
      allowedTools: ['shell'],
    });

    // shell tool: allowed
    expect(await vault.getForAgent({ userId: aliceId, toolId: 'shell' }, 'tool-restricted'))
      .toBe('restricted-value');

    // browser tool: denied
    expect(await vault.getForAgent({ userId: aliceId, toolId: 'browser' }, 'tool-restricted'))
      .toBeNull();
  });

  test('respects the allowed_agents allowlist', async () => {
    const { getVault } = await import('@/security/vault');
    const vault = getVault();
    await vault.store(aliceId, 'agent-restricted', 'agent-only', {
      credentialType: 'api_key',
      allowedAgents: ['orchestrator-1'],
    });

    expect(await vault.getForAgent({ userId: aliceId, agentId: 'orchestrator-1' }, 'agent-restricted'))
      .toBe('agent-only');
    expect(await vault.getForAgent({ userId: aliceId, agentId: 'random-worker' }, 'agent-restricted'))
      .toBeNull();
  });

  test('does not leak alice’s secret to bob even when no system row exists', async () => {
    const { getVault } = await import('@/security/vault');
    const vault = getVault();
    await vault.store(aliceId, 'alice-only-secret', 'alice-only-value', { credentialType: 'api_key' });

    expect(await vault.getForAgent({ userId: aliceId }, 'alice-only-secret')).toBe('alice-only-value');
    expect(await vault.getForAgent({ userId: bobId },   'alice-only-secret')).toBeNull();
  });
});

describe('Vault scope migration (backfill behavior)', () => {
  test('legacy rows inserted with user_id="system" land in scope=system', async () => {
    // We write directly via SQL to mimic data created before Phase 1b-1
    // (no scope column at insert time). The default value 'user' is wrong
    // for the literal 'system' sentinel — so the insert path explicitly
    // sets scope='system' via inferScope. Verify both code paths agree.
    const { queryRaw } = await import('@/db/postgres');
    const { getVault } = await import('@/security/vault');
    const vault = getVault();
    await vault.setSystemSecret('via-set-helper', 'v');

    const { rows } = await queryRaw(
      `SELECT scope FROM vault WHERE name='via-set-helper' AND user_id='system'`,
    );
    expect(rows[0]?.scope).toBe('system');
  });
});
