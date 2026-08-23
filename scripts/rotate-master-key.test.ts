/**
 * Master-key rotation — Phase 3a tests.
 *
 * Exercises `rotateVaultRowMasterKey` directly against an ephemeral
 * PGlite. Verifies:
 *   - A row encrypted with OLD master decrypts after rotation when
 *     the running vault is initialized with NEW master.
 *   - Bob's row, encrypted with OLD master and a different per-user
 *     DEK, also decrypts after rotation (cross-user isolation
 *     preserved across the rewrite).
 *   - Idempotent: re-running the rotation on the same (OLD, NEW)
 *     pair returns 'skipped' for already-rotated rows.
 *   - A row whose OLD-master decryption fails returns 'failed' and
 *     stays untouched in the DB.
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

const OLD_MASTER = Buffer.from('old-master-key-for-rotation-tests-not-secret-x');
const NEW_MASTER = Buffer.from('new-master-key-for-rotation-tests-not-secret-y');

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-master-rot-'));

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

/** Insert a row encrypted with the OLD master, bypassing the cached
 *  vault singleton — this simulates the pre-rotation state.        */
async function seedRowWithMaster(
  master: Buffer,
  userId: string,
  scope: 'system' | 'user',
  name: string,
  value: string,
): Promise<string> {
  const { deriveDek, encrypt } = await import('@/utils/crypto');
  const dek = deriveDek(master, scope, userId);
  const enc = encrypt(value, dek);
  const { getDb } = await import('@/db/postgres');
  const { vault } = await import('@/db/schema/vault');
  const db = getDb();
  const [row] = await db.insert(vault).values({
    userId,
    scope,
    name,
    credentialType: 'api_key',
    encryptedValue: enc.ciphertext,
    encryptionIv: enc.iv,
    encryptionAuthTag: enc.authTag,
    keyVersion: 2,
  }).returning();
  return row.id;
}

async function readEncryptedShape(rowId: string) {
  const { getDb } = await import('@/db/postgres');
  const { vault } = await import('@/db/schema/vault');
  const { eq } = await import('drizzle-orm');
  const db = getDb();
  const [row] = await db.select().from(vault).where(eq(vault.id, rowId)).limit(1);
  return row ? {
    ciphertext: row.encryptedValue,
    iv: row.encryptionIv,
    authTag: row.encryptionAuthTag,
    keyVersion: row.keyVersion,
  } : null;
}

describe('rotateVaultRowMasterKey', () => {
  test('rewrites a row from OLD master DEK to NEW master DEK', async () => {
    const id = await seedRowWithMaster(OLD_MASTER, aliceId, 'user', 'rotate-test-1', 'plaintext-value');
    const before = await readEncryptedShape(id);
    expect(before).not.toBeNull();

    const { rotateVaultRowMasterKey } = await import('@/security/vault');
    const outcome = await rotateVaultRowMasterKey(id, OLD_MASTER, NEW_MASTER);
    expect(outcome).toBe('rotated');

    // The row's ciphertext must have changed (new DEK = different
    // ciphertext + IV + authTag).
    const after = await readEncryptedShape(id);
    expect(after!.ciphertext).not.toBe(before!.ciphertext);
    expect(after!.iv).not.toBe(before!.iv);
    expect(after!.keyVersion).toBe(2);

    // Decrypt with the NEW master's DEK — must round-trip.
    const { deriveDek, decrypt } = await import('@/utils/crypto');
    const newDek = deriveDek(NEW_MASTER, 'user', aliceId);
    const plaintext = decrypt({
      ciphertext: after!.ciphertext,
      iv: after!.iv,
      authTag: after!.authTag,
    }, newDek);
    expect(plaintext).toBe('plaintext-value');
  });

  test('cross-user: bob’s row uses bob’s per-user DEK both before and after', async () => {
    const id = await seedRowWithMaster(OLD_MASTER, bobId, 'user', 'rotate-test-bob', 'bob-secret');

    const { rotateVaultRowMasterKey } = await import('@/security/vault');
    expect(await rotateVaultRowMasterKey(id, OLD_MASTER, NEW_MASTER)).toBe('rotated');

    const after = await readEncryptedShape(id);
    const { deriveDek, decrypt } = await import('@/utils/crypto');

    // Bob's NEW DEK decrypts.
    const bobNewDek = deriveDek(NEW_MASTER, 'user', bobId);
    expect(decrypt({
      ciphertext: after!.ciphertext, iv: after!.iv, authTag: after!.authTag,
    }, bobNewDek)).toBe('bob-secret');

    // Alice's NEW DEK does NOT decrypt bob's row — cross-user
    // isolation is preserved across rotation.
    const aliceNewDek = deriveDek(NEW_MASTER, 'user', aliceId);
    expect(() => decrypt({
      ciphertext: after!.ciphertext, iv: after!.iv, authTag: after!.authTag,
    }, aliceNewDek)).toThrow();
  });

  test('idempotent: re-rotating the same row returns "skipped"', async () => {
    const id = await seedRowWithMaster(OLD_MASTER, aliceId, 'user', 'rotate-test-idempotent', 'val');

    const { rotateVaultRowMasterKey } = await import('@/security/vault');
    expect(await rotateVaultRowMasterKey(id, OLD_MASTER, NEW_MASTER)).toBe('rotated');
    // Second call: row is now encrypted with NEW; OLD-decrypt fails,
    // NEW-decrypt succeeds → 'skipped'.
    expect(await rotateVaultRowMasterKey(id, OLD_MASTER, NEW_MASTER)).toBe('skipped');
  });

  test('a row encrypted with neither key returns "failed" and is left untouched', async () => {
    const stranger = Buffer.from('totally-different-key-not-old-or-new-key-xx');
    const id = await seedRowWithMaster(stranger, aliceId, 'user', 'rotate-test-stranger', 'val');
    const before = await readEncryptedShape(id);

    const { rotateVaultRowMasterKey } = await import('@/security/vault');
    expect(await rotateVaultRowMasterKey(id, OLD_MASTER, NEW_MASTER)).toBe('failed');

    // Untouched.
    const after = await readEncryptedShape(id);
    expect(after!.ciphertext).toBe(before!.ciphertext);
    expect(after!.iv).toBe(before!.iv);
  });

  test('system-scoped row uses scope=system DEK, not user DEK', async () => {
    const id = await seedRowWithMaster(OLD_MASTER, 'system', 'system', 'rotate-test-sys', 'sys-val');

    const { rotateVaultRowMasterKey } = await import('@/security/vault');
    expect(await rotateVaultRowMasterKey(id, OLD_MASTER, NEW_MASTER)).toBe('rotated');

    const after = await readEncryptedShape(id);
    const { deriveDek, decrypt } = await import('@/utils/crypto');
    const sysNewDek = deriveDek(NEW_MASTER, 'system', 'system');
    expect(decrypt({
      ciphertext: after!.ciphertext, iv: after!.iv, authTag: after!.authTag,
    }, sysNewDek)).toBe('sys-val');
  });
});
