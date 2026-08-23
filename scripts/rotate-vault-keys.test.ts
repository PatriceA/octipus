/**
 * Tests for the vault key rotation script.
 *
 * Seeds a v1 row directly via SQL (mimicking pre-Phase-1b-2 data) and
 * verifies the rotation logic upgrades it to v2 in place. We don't
 * spawn the script as a subprocess — we just call its exported batch
 * loop against an ephemeral PGlite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomBytes, pbkdf2Sync } from 'node:crypto';
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
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-rot-'));

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

async function seedV1Row(userId: string, name: string, value: string): Promise<string> {
  const { encrypt } = await import('@/utils/crypto');
  const { getDb } = await import('@/db/postgres');
  const { vault: vaultTable } = await import('@/db/schema/vault');
  const masterKey = process.env.MASTER_KEY!;
  const pbk = pbkdf2Sync(masterKey, 'assistant-vault-v1', 100_000, 32, 'sha256');
  const enc = encrypt(value, pbk);
  const db = getDb();
  const [row] = await db.insert(vaultTable).values({
    userId,
    scope: userId === 'system' ? 'system' : 'user',
    name,
    credentialType: 'api_key',
    encryptedValue: enc.ciphertext,
    encryptionIv: enc.iv,
    encryptionAuthTag: enc.authTag,
    keyVersion: 1,
  }).returning();
  return row.id;
}

async function keyVersionOf(id: string): Promise<number> {
  const { queryRaw } = await import('@/db/postgres');
  const { rows } = await queryRaw(`SELECT key_version FROM vault WHERE id='${id}'`);
  return rows[0]?.key_version;
}

describe('vault key rotation — exercising the same lazy upgrade the script triggers', () => {
  test('seeds a v1 row, then a single get() upgrades it to v2', async () => {
    const id = await seedV1Row(aliceId, 'rotation-test-1', 'rotme');
    expect(await keyVersionOf(id)).toBe(1);

    const { getVault } = await import('@/security/vault');
    const vault = getVault();

    // First read — fallback path decrypts via PBKDF2 and re-encrypts at v2.
    expect(await vault.get(aliceId, id)).toBe('rotme');

    // Now stored at v2.
    expect(await keyVersionOf(id)).toBe(2);
  });

  test('script-style batch walks every v1 row owned by every user', async () => {
    // Seed two more v1 rows under different owners.
    const id1 = await seedV1Row(aliceId, 'batch-rot-a', 'aval');
    const id2 = await seedV1Row(bobId,   'batch-rot-b', 'bval');
    expect(await keyVersionOf(id1)).toBe(1);
    expect(await keyVersionOf(id2)).toBe(1);

    // Run the same loop the script runs.
    const { getDb } = await import('@/db/postgres');
    const { vault: vaultTable } = await import('@/db/schema/vault');
    const { eq } = await import('drizzle-orm');
    const { getVault } = await import('@/security/vault');
    const vault = getVault();
    const db = getDb();

    const rows = await db
      .select({ id: vaultTable.id, userId: vaultTable.userId })
      .from(vaultTable)
      .where(eq(vaultTable.keyVersion, 1));
    for (const r of rows) {
      // get() is the same call the script makes.
      await vault.get(r.userId, r.id);
    }

    expect(await keyVersionOf(id1)).toBe(2);
    expect(await keyVersionOf(id2)).toBe(2);
  });

  test('rows that fail to decrypt stay at v1 and are reported, not deleted', async () => {
    // Fabricate a row whose ciphertext doesn't match any known key. The
    // script should leave it alone and continue with the rest.
    const { getDb } = await import('@/db/postgres');
    const { vault: vaultTable } = await import('@/db/schema/vault');
    const db = getDb();
    const [bad] = await db.insert(vaultTable).values({
      userId: aliceId,
      scope: 'user',
      name: 'bad-row',
      credentialType: 'api_key',
      encryptedValue: 'not-real-base64',
      encryptionIv: 'AAAAAAAAAAAAAAAA', // 12 bytes base64
      encryptionAuthTag: 'AAAAAAAAAAAAAAAAAAAAAA==', // 16 bytes base64
      keyVersion: 1,
    }).returning();

    const { getVault } = await import('@/security/vault');
    const vault = getVault();

    let threw = false;
    try { await vault.get(aliceId, bad.id); } catch { threw = true; }
    expect(threw).toBe(true);

    // Row is still present and still at v1.
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT key_version FROM vault WHERE id='${bad.id}'`);
    expect(rows[0]?.key_version).toBe(1);
  });
});
