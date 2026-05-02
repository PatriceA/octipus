/**
 * Phase 1b-2 — per-user DEK encryption.
 *
 * Verifies:
 *   - deriveDek is deterministic per (masterKey, scope, userId).
 *   - DEKs differ across users and across scopes.
 *   - Vault writes use key_version=2 with the per-user DEK.
 *   - Reads pick the right DEK from key_version, falling back through
 *     legacy schemes if needed and re-encrypting opportunistically.
 *
 * Backed by ephemeral PGlite — no Docker.
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
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-vault-dek-'));

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

describe('deriveDek', () => {
  test('same inputs yield identical keys', async () => {
    const { deriveDek } = await import('@/utils/crypto');
    const mk = Buffer.from('master-key-test');
    const a = deriveDek(mk, 'user', aliceId);
    const b = deriveDek(mk, 'user', aliceId);
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
  });

  test('different users yield different keys', async () => {
    const { deriveDek } = await import('@/utils/crypto');
    const mk = Buffer.from('master-key-test');
    const a = deriveDek(mk, 'user', aliceId);
    const b = deriveDek(mk, 'user', bobId);
    expect(a.equals(b)).toBe(false);
  });

  test('different scopes for same userId yield different keys', async () => {
    const { deriveDek } = await import('@/utils/crypto');
    const mk = Buffer.from('master-key-test');
    const u = deriveDek(mk, 'user', aliceId);
    const s = deriveDek(mk, 'system', aliceId);
    const w = deriveDek(mk, 'workspace', aliceId);
    expect(u.equals(s)).toBe(false);
    expect(u.equals(w)).toBe(false);
    expect(s.equals(w)).toBe(false);
  });

  test('different master keys yield different DEKs for same user/scope', async () => {
    const { deriveDek } = await import('@/utils/crypto');
    const mk1 = Buffer.from('master-key-1');
    const mk2 = Buffer.from('master-key-2');
    const a = deriveDek(mk1, 'user', aliceId);
    const b = deriveDek(mk2, 'user', aliceId);
    expect(a.equals(b)).toBe(false);
  });
});

describe('Vault: new writes use key_version=2 with per-user DEK', () => {
  test('store records key_version=2', async () => {
    const { getVault } = await import('@/security/vault');
    const vault = getVault();
    const stored = await vault.store(aliceId, 'dek-test', 'secret-value', { credentialType: 'api_key' });

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT key_version FROM vault WHERE id='${stored.id}'`);
    expect(rows[0].key_version).toBe(2);
  });

  test('round-trip read decrypts at key_version=2', async () => {
    const { getVault } = await import('@/security/vault');
    const vault = getVault();
    await vault.store(aliceId, 'roundtrip', 'value-xyz', { credentialType: 'api_key' });
    expect(await vault.getByName(aliceId, 'roundtrip')).toBe('value-xyz');
  });

  test('rotate bumps key_version=2 (idempotent at current version)', async () => {
    const { getVault } = await import('@/security/vault');
    const vault = getVault();
    const s = await vault.store(aliceId, 'rotate-test', 'v1', { credentialType: 'api_key' });
    await vault.rotate(aliceId, s.id, 'v2');

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT key_version FROM vault WHERE id='${s.id}'`);
    expect(rows[0].key_version).toBe(2);
    expect(await vault.getByName(aliceId, 'rotate-test')).toBe('v2');
  });
});

describe('Vault: legacy key_version=1 rows still decrypt', () => {
  test('a row written with the legacy PBKDF2 key reads back via fallback and gets re-encrypted', async () => {
    // Re-create the legacy ciphertext directly: PBKDF2(masterKey, salt-v1, 100k, 32, sha256).
    const { pbkdf2Sync } = await import('node:crypto');
    const { encrypt } = await import('@/utils/crypto');
    const { getDb } = await import('@/db/postgres');
    const { vault: vaultTable } = await import('@/db/schema/vault');
    const masterKey = process.env.MASTER_KEY!;
    const pbk = pbkdf2Sync(masterKey, 'assistant-vault-v1', 100_000, 32, 'sha256');
    const enc = encrypt('legacy-value', pbk);

    const db = getDb();
    const [row] = await db.insert(vaultTable).values({
      userId: aliceId,
      scope: 'user',
      name: 'legacy-row',
      credentialType: 'api_key',
      encryptedValue: enc.ciphertext,
      encryptionIv: enc.iv,
      encryptionAuthTag: enc.authTag,
      keyVersion: 1,
    }).returning();

    const { getVault } = await import('@/security/vault');
    const vault = getVault();

    // First read: decrypts with PBKDF2 fallback.
    expect(await vault.getByName(aliceId, 'legacy-row')).toBe('legacy-value');

    // After read: row was opportunistically re-encrypted at v2.
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT key_version FROM vault WHERE id='${row.id}'`);
    expect(rows[0].key_version).toBe(2);

    // Second read: decrypts at v2 directly.
    expect(await vault.getByName(aliceId, 'legacy-row')).toBe('legacy-value');
  });
});

describe('Vault: per-user DEKs prevent cross-user decryption', () => {
  test('alice’s ciphertext cannot be decrypted with bob’s DEK', async () => {
    const { encrypt, decrypt, deriveDek } = await import('@/utils/crypto');
    const masterKey = Buffer.from(process.env.MASTER_KEY!);
    const aliceDek = deriveDek(masterKey, 'user', aliceId);
    const bobDek = deriveDek(masterKey, 'user', bobId);

    const ct = encrypt('alice-secret', aliceDek);

    // Sanity: alice's DEK decrypts fine.
    expect(decrypt(ct, aliceDek)).toBe('alice-secret');

    // Bob's DEK fails.
    expect(() => decrypt(ct, bobDek)).toThrow();
  });
});
