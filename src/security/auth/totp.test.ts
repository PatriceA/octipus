/**
 * TOTP 2FA — unit tests for enrollment, verification, backup codes, and the
 * enable/disable lifecycle. `src/security/auth/totp.ts` sat at ~5% coverage
 * despite being a security-critical second factor.
 *
 * The user store is mocked in-memory (no Postgres); crypto (encrypt/decrypt,
 * HKDF key derivation) and otplib run for real, so these exercise the real
 * secret round-trip. Valid codes are produced with otplib's own `generate`.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { generate } from 'otplib';

// getConfig() (reached via `new TOTPAuth()` and the HKDF key derivation)
// validates security secrets ≥32 chars. Seed them if a runner hasn't.
const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;

// ── In-memory user store standing in for the Postgres-backed repository ──────
interface StoredUser {
  id: string;
  username: string;
  isAdmin: boolean;
  totpSecret?: string | null;
  totpEnabled?: boolean;
  [k: string]: unknown;
}
const users = new Map<string, StoredUser>();

// Snapshot the real module into a plain object BEFORE mocking. Restoring from
// the live `import * as` namespace does not work — bun's `mock.module` leaves
// that binding pointing at the stub, so the afterAll restore would re-install
// the stub and leak it into later suites (e.g. the DB repository integration
// tests). A copy taken before mocking restores cleanly.

vi.mock('@/db/repositories/user-repository', async () => ({
  ...(await vi.importActual<typeof import('@/db/repositories/user-repository')>('@/db/repositories/user-repository')),
  userRepository: {
    findById: async (id: string) => users.get(id) ?? null,
    update: async (id: string, patch: Record<string, unknown>) => {
      const u = users.get(id);
      if (!u) return null;
      Object.assign(u, patch);
      return u;
    },
  },
}));

// Import the SUT AFTER the mock so it binds to the fake repository.
const { TOTPAuth } = await import('./totp');

afterAll(() => {
});

function seedUser(id: string): StoredUser {
  const u: StoredUser = { id, username: `user-${id}`, isAdmin: false, totpEnabled: false, totpSecret: null };
  users.set(id, u);
  return u;
}

/** Enroll + enable TOTP for a user, returning the plaintext secret + backup codes. */
async function enroll(totp: InstanceType<typeof TOTPAuth>, id: string) {
  const { secret, backupCodes } = await totp.generateSecret(id);
  const code = await generate({ secret });
  const ok = await totp.enable(id, code);
  expect(ok).toBe(true);
  return { secret, backupCodes };
}

beforeEach(() => {
  users.clear();
});

describe('TOTPAuth.generateSecret', () => {
  test('throws for an unknown user', async () => {
    const totp = new TOTPAuth();
    await expect(totp.generateSecret('nope')).rejects.toThrow('User not found');
  });

  test('returns a secret, otpauth URL, and 10 backup codes; persists encrypted + disabled', async () => {
    const totp = new TOTPAuth();
    const user = seedUser('u1');
    const { secret, qrCodeUrl, backupCodes } = await totp.generateSecret('u1');

    expect(secret).toBeTruthy();
    expect(qrCodeUrl).toContain('otpauth://');
    expect(backupCodes).toHaveLength(10);
    expect(backupCodes.every((c) => /^[A-Z0-9]{8}$/.test(c))).toBe(true);

    // Stored encrypted (iv:authTag:ciphertext), NOT enabled until verified, and
    // the plaintext secret must not appear in the stored value.
    expect(user.totpEnabled).toBe(false);
    expect(typeof user.totpSecret).toBe('string');
    expect((user.totpSecret as string).split(':')).toHaveLength(3);
    expect(user.totpSecret).not.toContain(secret);
  });
});

describe('TOTPAuth.enable', () => {
  test('throws when TOTP was never configured', async () => {
    const totp = new TOTPAuth();
    seedUser('u1');
    await expect(totp.enable('u1', '000000')).rejects.toThrow('TOTP not configured');
  });

  test('rejects a wrong code and leaves TOTP disabled', async () => {
    const totp = new TOTPAuth();
    const user = seedUser('u1');
    await totp.generateSecret('u1');
    const ok = await totp.enable('u1', '000000');
    expect(ok).toBe(false);
    expect(user.totpEnabled).toBe(false);
  });

  test('accepts a valid code and enables TOTP', async () => {
    const totp = new TOTPAuth();
    const user = seedUser('u1');
    await enroll(totp, 'u1');
    expect(user.totpEnabled).toBe(true);
  });
});

describe('TOTPAuth.verify', () => {
  test('throws when TOTP is not enabled', async () => {
    const totp = new TOTPAuth();
    seedUser('u1');
    await totp.generateSecret('u1'); // configured but not enabled
    await expect(totp.verify('u1', '000000')).rejects.toThrow('TOTP not enabled');
  });

  test('accepts a fresh valid code', async () => {
    const totp = new TOTPAuth();
    seedUser('u1');
    const { secret } = await enroll(totp, 'u1');
    const code = await generate({ secret });
    expect(await totp.verify('u1', code)).toBe(true);
  });

  test('rejects a wrong code', async () => {
    const totp = new TOTPAuth();
    seedUser('u1');
    await enroll(totp, 'u1');
    expect(await totp.verify('u1', '000000')).toBe(false);
  });

  test('accepts a backup code once, then not again (single-use)', async () => {
    const totp = new TOTPAuth();
    seedUser('u1');
    const { backupCodes } = await enroll(totp, 'u1');
    const backup = backupCodes[0];

    expect(await totp.getBackupCodesCount('u1')).toBe(10);
    expect(await totp.verify('u1', backup)).toBe(true);
    // consumed
    expect(await totp.verify('u1', backup)).toBe(false);
    expect(await totp.getBackupCodesCount('u1')).toBe(9);
  });

  test('backup codes are case-insensitive', async () => {
    const totp = new TOTPAuth();
    seedUser('u1');
    const { backupCodes } = await enroll(totp, 'u1');
    expect(await totp.verify('u1', backupCodes[0].toLowerCase())).toBe(true);
  });
});

describe('TOTPAuth.disable', () => {
  test('refuses to disable without a valid code and keeps TOTP enabled', async () => {
    const totp = new TOTPAuth();
    const user = seedUser('u1');
    await enroll(totp, 'u1');
    expect(await totp.disable('u1', '000000')).toBe(false);
    expect(user.totpEnabled).toBe(true);
  });

  test('disables and clears the secret with a valid code', async () => {
    const totp = new TOTPAuth();
    const user = seedUser('u1');
    const { secret } = await enroll(totp, 'u1');
    const code = await generate({ secret });
    expect(await totp.disable('u1', code)).toBe(true);
    expect(user.totpEnabled).toBe(false);
    expect(user.totpSecret).toBeNull();
  });
});

describe('TOTPAuth.isEnabled / getBackupCodesCount', () => {
  test('isEnabled reflects state and is false for unknown users', async () => {
    const totp = new TOTPAuth();
    seedUser('u1');
    expect(await totp.isEnabled('u1')).toBe(false);
    await enroll(totp, 'u1');
    expect(await totp.isEnabled('u1')).toBe(true);
    expect(await totp.isEnabled('ghost')).toBe(false);
  });

  test('getBackupCodesCount is 0 when TOTP is not configured', async () => {
    const totp = new TOTPAuth();
    seedUser('u1');
    expect(await totp.getBackupCodesCount('u1')).toBe(0);
  });
});

describe('TOTPAuth.regenerateBackupCodes', () => {
  test('returns null on a wrong code and leaves existing codes intact', async () => {
    const totp = new TOTPAuth();
    seedUser('u1');
    await enroll(totp, 'u1');
    expect(await totp.regenerateBackupCodes('u1', '000000')).toBeNull();
    expect(await totp.getBackupCodesCount('u1')).toBe(10);
  });

  test('issues a fresh set of 10 codes with a valid code; old codes stop working', async () => {
    const totp = new TOTPAuth();
    seedUser('u1');
    const { secret, backupCodes: oldCodes } = await enroll(totp, 'u1');
    const code = await generate({ secret });

    const fresh = await totp.regenerateBackupCodes('u1', code);
    expect(fresh).not.toBeNull();
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toEqual(oldCodes);

    // An old backup code must no longer verify; a new one must.
    expect(await totp.verify('u1', oldCodes[0])).toBe(false);
    expect(await totp.verify('u1', fresh![0])).toBe(true);
  });
});
