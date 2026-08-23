/**
 * PasskeyAuth (WebAuthn) — unit tests for the orchestration around
 * @simplewebauthn/server: challenge lifecycle, credential exclusion/storage,
 * signature-counter updates, audit logging, and the error branches.
 * `src/security/auth/passkey.ts` was at ~5% coverage.
 *
 * The WebAuthn primitives are mocked (real attestations can't be produced in a
 * unit test) via controllable verdicts; storage runs on the real in-memory
 * provider so the Redis-backed challenge cache round-trips; the Postgres-backed
 * user/audit repositories are mocked.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;

interface StoredCredential {
  id: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  deviceName?: string;
  createdAt?: string;
}
interface StoredUser { id: string; username: string; isAdmin: boolean; passkeyCredentials: StoredCredential[] }
const users = new Map<string, StoredUser>();
const auditCalls: { fn: string; args: unknown[] }[] = [];

// ── Controllable WebAuthn verdicts (reset per test) ─────────────────────────
let registrationVerified = true;
let registrationCredentialId = 'cred-new';
let registrationCounter = 0;
let authenticationVerified = true;
let authenticationNewCounter = 1;

// Snapshot real modules into plain objects before mocking (see totp.test.ts).

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
    updateLastLogin: async () => { auditCalls.push({ fn: 'updateLastLogin', args: [] }); },
  },
}));
vi.mock('@/db/repositories/audit-repository', async () => ({
  ...(await vi.importActual<typeof import('@/db/repositories/audit-repository')>('@/db/repositories/audit-repository')),
  auditRepository: {
    logLogin: async (...args: unknown[]) => { auditCalls.push({ fn: 'logLogin', args }); },
    logLoginFailed: async (...args: unknown[]) => { auditCalls.push({ fn: 'logLoginFailed', args }); },
    logLogout: async () => {},
  },
}));
vi.mock('@simplewebauthn/server', async () => ({
  ...(await vi.importActual<typeof import('@simplewebauthn/server')>('@simplewebauthn/server')),
  generateRegistrationOptions: async () => ({ challenge: `reg-${randomUUID()}` }),
  generateAuthenticationOptions: async () => ({ challenge: `auth-${randomUUID()}` }),
  verifyRegistrationResponse: async () => ({
    verified: registrationVerified,
    registrationInfo: registrationVerified
      ? { credential: { id: registrationCredentialId, publicKey: new Uint8Array([1, 2, 3, 4]), counter: registrationCounter } }
      : undefined,
  }),
  verifyAuthenticationResponse: async () => ({
    verified: authenticationVerified,
    authenticationInfo: { newCounter: authenticationNewCounter },
  }),
}));

const { initializeStorage, closeStorage } = await import('@/db/storage');
const { PasskeyAuth } = await import('./passkey');

initializeStorage({ mode: 'embedded' });

afterAll(async () => {
  await closeStorage();
});

function seedUser(creds: StoredCredential[] = []): string {
  const id = randomUUID();
  users.set(id, { id, username: `user-${id}`, isAdmin: false, passkeyCredentials: creds });
  return id;
}
function b64(bytes: number[]): string {
  return Buffer.from(bytes).toString('base64');
}

beforeEach(() => {
  users.clear();
  auditCalls.length = 0;
  registrationVerified = true;
  registrationCredentialId = 'cred-new';
  registrationCounter = 0;
  authenticationVerified = true;
  authenticationNewCounter = 1;
});

describe('generateRegistrationOptions', () => {
  test('throws for an unknown user', async () => {
    const pk = new PasskeyAuth();
    await expect(pk.generateRegistrationOptions('ghost', 'ghost')).rejects.toThrow('User not found');
  });

  test('returns options + challenge and persists the challenge for later verification', async () => {
    const pk = new PasskeyAuth();
    const id = seedUser();
    const { options, challenge } = await pk.generateRegistrationOptions(id, 'alice');
    expect(options.challenge).toBe(challenge);
    expect(challenge).toMatch(/^reg-/);
  });
});

describe('verifyRegistration', () => {
  test('throws when there is no stored challenge', async () => {
    const pk = new PasskeyAuth();
    const id = seedUser();
    await expect(
      pk.verifyRegistration(id, { id: 'x', response: {} } as never),
    ).rejects.toThrow('Challenge expired or not found');
  });

  test('throws when the authenticator response fails verification', async () => {
    const pk = new PasskeyAuth();
    const id = seedUser();
    await pk.generateRegistrationOptions(id, 'alice');
    registrationVerified = false;
    await expect(
      pk.verifyRegistration(id, { id: 'x', response: {} } as never),
    ).rejects.toThrow('Registration verification failed');
  });

  test('saves the new credential on success and consumes the challenge (single-use)', async () => {
    const pk = new PasskeyAuth();
    const id = seedUser();
    await pk.generateRegistrationOptions(id, 'alice');
    registrationCredentialId = 'cred-1';
    registrationCounter = 0;

    const result = await pk.verifyRegistration(id, { id: 'cred-1', response: { transports: ['internal'] } } as never, 'MacBook');
    expect(result.verified).toBe(true);

    const creds = users.get(id)!.passkeyCredentials;
    expect(creds).toHaveLength(1);
    expect(creds[0].id).toBe('cred-1');
    expect(creds[0].deviceName).toBe('MacBook');
    expect(creds[0].publicKey).toBe(b64([1, 2, 3, 4]));

    // Challenge is single-use: a second verify with the same (now-consumed)
    // challenge must fail.
    await expect(
      pk.verifyRegistration(id, { id: 'cred-1', response: {} } as never),
    ).rejects.toThrow('Challenge expired or not found');
  });
});

describe('verifyAuthentication', () => {
  test('throws when there is no stored challenge', async () => {
    const pk = new PasskeyAuth();
    const id = seedUser([{ id: 'cred-1', publicKey: b64([1, 2, 3, 4]), counter: 0 }]);
    await expect(
      pk.verifyAuthentication(id, { id: 'cred-1', response: {} } as never),
    ).rejects.toThrow('Challenge expired or not found');
  });

  test('audits a failed login and throws when the credential is unknown', async () => {
    const pk = new PasskeyAuth();
    const id = seedUser([{ id: 'cred-1', publicKey: b64([1, 2, 3, 4]), counter: 0 }]);
    await pk.generateAuthenticationOptions(id);
    await expect(
      pk.verifyAuthentication(id, { id: 'cred-UNKNOWN', response: {} } as never, '10.0.0.9'),
    ).rejects.toThrow('Credential not found');
    expect(auditCalls.some((c) => c.fn === 'logLoginFailed')).toBe(true);
  });

  test('audits and throws when signature verification fails', async () => {
    const pk = new PasskeyAuth();
    const id = seedUser([{ id: 'cred-1', publicKey: b64([1, 2, 3, 4]), counter: 0 }]);
    await pk.generateAuthenticationOptions(id);
    authenticationVerified = false;
    await expect(
      pk.verifyAuthentication(id, { id: 'cred-1', response: {} } as never),
    ).rejects.toThrow('Authentication verification failed');
    expect(auditCalls.some((c) => c.fn === 'logLoginFailed')).toBe(true);
  });

  test('bumps the signature counter and audits a successful login', async () => {
    const pk = new PasskeyAuth();
    const id = seedUser([{ id: 'cred-1', publicKey: b64([1, 2, 3, 4]), counter: 5 }]);
    await pk.generateAuthenticationOptions(id);
    authenticationNewCounter = 6;

    const result = await pk.verifyAuthentication(id, { id: 'cred-1', response: {} } as never, '10.0.0.1');
    expect(result.verified).toBe(true);
    expect(users.get(id)!.passkeyCredentials[0].counter).toBe(6);
    expect(auditCalls.some((c) => c.fn === 'logLogin')).toBe(true);
    expect(auditCalls.some((c) => c.fn === 'updateLastLogin')).toBe(true);
  });
});

describe('removeCredential / listCredentials', () => {
  test('removeCredential deletes a matching credential and reports false when absent', async () => {
    const pk = new PasskeyAuth();
    const id = seedUser([
      { id: 'cred-1', publicKey: b64([1]), counter: 0 },
      { id: 'cred-2', publicKey: b64([2]), counter: 0 },
    ]);
    expect(await pk.removeCredential(id, 'cred-1')).toBe(true);
    expect(users.get(id)!.passkeyCredentials.map((c) => c.id)).toEqual(['cred-2']);
    expect(await pk.removeCredential(id, 'cred-does-not-exist')).toBe(false);
  });

  test('listCredentials returns sanitized metadata only (no public key)', async () => {
    const pk = new PasskeyAuth();
    const id = seedUser([
      { id: 'cred-1', publicKey: b64([1]), counter: 0, deviceName: 'Phone', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    const list = await pk.listCredentials(id);
    expect(list).toEqual([{ id: 'cred-1', deviceName: 'Phone', createdAt: '2026-01-01T00:00:00.000Z' }]);
    expect((list[0] as Record<string, unknown>).publicKey).toBeUndefined();
  });

  test('listCredentials returns [] for an unknown user', async () => {
    const pk = new PasskeyAuth();
    expect(await pk.listCredentials('ghost')).toEqual([]);
  });
});
