/**
 * Phase 2a — API tokens.
 *
 * Covers:
 *   - token format (prefix + length + base64url alphabet)
 *   - hash determinism + plaintext is never persisted
 *   - validate: happy path, revoked, expired, unknown, wrong shape
 *   - issue → list → revoke round-trip
 *   - cross-tenant isolation: alice cannot revoke bob's token
 *   - admin override on revoke
 *   - last_used_at advances on a successful validate
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
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-tokens-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: aliceId, username: 'alice' },
    { id: bobId, username: 'bob' },
  ]);

  const { _resetApiTokenManagerForTests } = await import('@/security/api-tokens');
  _resetApiTokenManagerForTests();
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('token format helpers', () => {
  test('generateTokenPlaintext: prefix + base64url alphabet, length ~48', async () => {
    const { generateTokenPlaintext } = await import('@/security/api-tokens');
    const t = generateTokenPlaintext();
    expect(t.startsWith('octi_')).toBe(true);
    expect(t.length).toBeGreaterThanOrEqual(40);
    // base64url tail: only A-Z a-z 0-9 _ -
    expect(/^octi_[A-Za-z0-9_-]+$/.test(t)).toBe(true);
  });

  test('hashToken is deterministic and 64 hex chars', async () => {
    const { hashToken } = await import('@/security/api-tokens');
    const h1 = hashToken('octi_abc');
    const h2 = hashToken('octi_abc');
    expect(h1).toBe(h2);
    expect(/^[0-9a-f]{64}$/.test(h1)).toBe(true);
    // Different input → different hash.
    expect(hashToken('octi_xyz')).not.toBe(h1);
  });

  test('looksLikeApiToken accepts only well-formed tokens', async () => {
    const { looksLikeApiToken } = await import('@/security/api-tokens');
    expect(looksLikeApiToken('octi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
    expect(looksLikeApiToken('octi_short')).toBe(false);
    expect(looksLikeApiToken('not-a-token')).toBe(false);
    expect(looksLikeApiToken('octi_with spaces in it')).toBe(false);
    expect(looksLikeApiToken('')).toBe(false);
  });
});

describe('issue', () => {
  test('returns plaintext exactly once and persists only the hash', async () => {
    const { getApiTokenManager, hashToken } = await import('@/security/api-tokens');
    const mgr = getApiTokenManager();
    const result = await mgr.issue(aliceId, { name: 'CI deploy bot' });

    expect(result.plaintext).toMatch(/^octi_/);
    expect(result.summary.id).toBeDefined();
    expect(result.summary.name).toBe('CI deploy bot');
    expect(result.summary.prefix).toBe(result.plaintext.slice(0, 12));

    // Verify the DB stores only the hash, never the plaintext.
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT token_hash, prefix FROM api_tokens WHERE id='${result.summary.id}'`);
    expect(rows[0].token_hash).toBe(hashToken(result.plaintext));
    expect(rows[0].token_hash).not.toContain('octi_');
    expect(rows[0].prefix).toBe(result.plaintext.slice(0, 12));
  });
});

describe('validate', () => {
  test('happy path: returns the owning userId + tokenId', async () => {
    const { getApiTokenManager } = await import('@/security/api-tokens');
    const mgr = getApiTokenManager();
    const { plaintext, summary } = await mgr.issue(aliceId, { name: 'happy-path' });

    const result = await mgr.validate(plaintext);
    expect(result?.userId).toBe(aliceId);
    expect(result?.tokenId).toBe(summary.id);
  });

  test('updates last_used_at on a successful validate', async () => {
    const { getApiTokenManager } = await import('@/security/api-tokens');
    const mgr = getApiTokenManager();
    const { plaintext, summary } = await mgr.issue(aliceId, { name: 'last-used' });

    const before = (await mgr.listForUser(aliceId)).find((t) => t.id === summary.id);
    expect(before?.lastUsedAt).toBeNull();

    await mgr.validate(plaintext);
    // Background update — give it a tick.
    await new Promise((r) => setTimeout(r, 25));

    const after = (await mgr.listForUser(aliceId)).find((t) => t.id === summary.id);
    expect(after?.lastUsedAt).not.toBeNull();
  });

  test('rejects unknown tokens (well-formed shape, no DB row)', async () => {
    const { getApiTokenManager, generateTokenPlaintext } = await import('@/security/api-tokens');
    const mgr = getApiTokenManager();
    expect(await mgr.validate(generateTokenPlaintext())).toBeNull();
  });

  test('rejects malformed inputs without hitting the DB', async () => {
    const { getApiTokenManager } = await import('@/security/api-tokens');
    const mgr = getApiTokenManager();
    expect(await mgr.validate('not-a-token')).toBeNull();
    expect(await mgr.validate('')).toBeNull();
    expect(await mgr.validate('octi_short')).toBeNull();
  });

  test('rejects revoked tokens', async () => {
    const { getApiTokenManager } = await import('@/security/api-tokens');
    const mgr = getApiTokenManager();
    const { plaintext, summary } = await mgr.issue(aliceId, { name: 'to-revoke' });
    expect(await mgr.validate(plaintext)).not.toBeNull();

    await mgr.revoke(aliceId, summary.id);
    expect(await mgr.validate(plaintext)).toBeNull();
  });

  test('rejects expired tokens', async () => {
    const { getApiTokenManager } = await import('@/security/api-tokens');
    const mgr = getApiTokenManager();
    const past = new Date(Date.now() - 60_000);
    const { plaintext } = await mgr.issue(aliceId, { name: 'expired', expiresAt: past });
    expect(await mgr.validate(plaintext)).toBeNull();
  });
});

describe('listForUser is user-scoped', () => {
  test('returns only the principal’s own tokens', async () => {
    const { getApiTokenManager } = await import('@/security/api-tokens');
    const mgr = getApiTokenManager();
    await mgr.issue(aliceId, { name: 'alice-token-1' });
    await mgr.issue(bobId,   { name: 'bob-token-1' });

    const aliceList = await mgr.listForUser(aliceId);
    expect(aliceList.every((t) => !t.name.startsWith('bob-'))).toBe(true);
    expect(aliceList.some((t) => t.name === 'alice-token-1')).toBe(true);

    const bobList = await mgr.listForUser(bobId);
    expect(bobList.every((t) => !t.name.startsWith('alice-'))).toBe(true);
  });
});

describe('revoke cross-tenant', () => {
  test('alice cannot revoke bob’s token — silent no-op', async () => {
    const { getApiTokenManager } = await import('@/security/api-tokens');
    const mgr = getApiTokenManager();
    const { plaintext, summary } = await mgr.issue(bobId, { name: 'bob-keepalive' });

    const ok = await mgr.revoke(aliceId, summary.id);
    expect(ok).toBe(false);

    // Bob's token still validates.
    expect(await mgr.validate(plaintext)).not.toBeNull();
  });

  test('admin override lets a non-owner revoke', async () => {
    const { getApiTokenManager } = await import('@/security/api-tokens');
    const mgr = getApiTokenManager();
    const { plaintext, summary } = await mgr.issue(bobId, { name: 'admin-revoke-target' });

    const ok = await mgr.revoke(aliceId, summary.id, { admin: true });
    expect(ok).toBe(true);
    expect(await mgr.validate(plaintext)).toBeNull();
  });

  test('revoking an already-revoked token returns false', async () => {
    const { getApiTokenManager } = await import('@/security/api-tokens');
    const mgr = getApiTokenManager();
    const { summary } = await mgr.issue(aliceId, { name: 'double-revoke' });
    expect(await mgr.revoke(aliceId, summary.id)).toBe(true);
    expect(await mgr.revoke(aliceId, summary.id)).toBe(false);
  });
});

describe('countActive', () => {
  test('only counts non-revoked rows', async () => {
    const { getApiTokenManager } = await import('@/security/api-tokens');
    const mgr = getApiTokenManager();
    const fresh = '33333333-3333-3333-3333-333333333333';
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: fresh, username: 'fresh' }]);

    expect(await mgr.countActive(fresh)).toBe(0);
    const a = await mgr.issue(fresh, { name: 'a' });
    await mgr.issue(fresh, { name: 'b' });
    expect(await mgr.countActive(fresh)).toBe(2);

    await mgr.revoke(fresh, a.summary.id);
    expect(await mgr.countActive(fresh)).toBe(1);
  });
});
