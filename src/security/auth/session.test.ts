/**
 * SessionManager — unit tests for the create/validate/revoke lifecycle,
 * per-user session tracking, expiry, refresh, and the max-sessions cap.
 * `src/security/auth/session.ts` was effectively untested despite guarding
 * every authenticated request.
 *
 * Storage runs on the real in-memory provider (embedded mode) so RedisCache
 * round-trips for real; the Postgres-backed user/audit repositories are mocked.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;

// ── In-memory user store ────────────────────────────────────────────────────
interface StoredUser { id: string; username: string; isAdmin: boolean }
const users = new Map<string, StoredUser>();
const auditCalls: string[] = [];

// Snapshot real modules into plain objects before mocking (see totp.test.ts for
// why restoring from the live `import * as` namespace leaks the stub forward).
import * as realUserRepoNs from '@/db/repositories/user-repository';
import * as realAuditRepoNs from '@/db/repositories/audit-repository';
const realUserRepo = { ...realUserRepoNs };
const realAuditRepo = { ...realAuditRepoNs };

mock.module('@/db/repositories/user-repository', () => ({
  ...realUserRepo,
  userRepository: { findById: async (id: string) => users.get(id) ?? null },
}));
mock.module('@/db/repositories/audit-repository', () => ({
  ...realAuditRepo,
  auditRepository: {
    logLogout: async () => { auditCalls.push('logout'); },
    logLogin: async () => { auditCalls.push('login'); },
    logLoginFailed: async () => { auditCalls.push('loginFailed'); },
  },
}));

const { initializeStorage, closeStorage } = await import('@/db/storage');
const { SessionManager } = await import('./session');

initializeStorage({ mode: 'embedded' });

afterAll(async () => {
  await closeStorage();
  mock.module('@/db/repositories/user-repository', () => realUserRepo);
  mock.module('@/db/repositories/audit-repository', () => realAuditRepo);
});

// Fresh id per user. The embedded cache persists across tests within the file,
// so unique ids keep each test's sessions (keyed by user id) isolated without
// needing to flush shared storage.
function seedUser(isAdmin = false): string {
  const id = randomUUID();
  users.set(id, { id, username: `user-${id}`, isAdmin });
  return id;
}

beforeEach(() => {
  users.clear();
  auditCalls.length = 0;
});

describe('SessionManager.create', () => {
  test('throws for an unknown user', async () => {
    const mgr = new SessionManager();
    await expect(mgr.create('ghost')).rejects.toThrow('User not found');
  });

  test('returns an opaque token + hydrated session and tracks it for the user', async () => {
    const mgr = new SessionManager();
    const id = seedUser(true);
    const { token, session } = await mgr.create(id, { channelType: 'web', ipAddress: '10.0.0.1' });

    expect(token).toBeTruthy();
    expect(session.userId).toBe(id);
    expect(session.username).toBe(`user-${id}`);
    expect(session.isAdmin).toBe(true);
    expect(session.channelType).toBe('web');
    expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(Date.now());

    expect(await mgr.countForUser(id)).toBe(1);
  });

  test('honors a custom ttlMs (short-lived tickets)', async () => {
    const mgr = new SessionManager();
    const id = seedUser();
    const { session } = await mgr.create(id, { ttlMs: 60_000 });
    const lifetime = new Date(session.expiresAt).getTime() - new Date(session.createdAt).getTime();
    expect(lifetime).toBeLessThanOrEqual(60_000);
    expect(lifetime).toBeGreaterThan(0);
  });
});

describe('SessionManager.validate / get', () => {
  test('validate returns null for an unknown token', async () => {
    const mgr = new SessionManager();
    expect(await mgr.validate('not-a-real-token')).toBeNull();
  });

  test('validate returns the session for a live token and bumps lastActivityAt', async () => {
    const mgr = new SessionManager();
    const id = seedUser();
    const { token } = await mgr.create(id);
    const before = (await mgr.get(token))!.lastActivityAt;
    await new Promise((r) => setTimeout(r, 5));
    const session = await mgr.validate(token);
    expect(session).not.toBeNull();
    expect(new Date(session!.lastActivityAt).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  test('validate returns null for an expired session', async () => {
    const mgr = new SessionManager();
    const id = seedUser();
    const { token } = await mgr.create(id, { ttlMs: 60 });
    await new Promise((r) => setTimeout(r, 90));
    expect(await mgr.validate(token)).toBeNull();
  });
});

describe('SessionManager.revoke', () => {
  test('revoke removes the session and audits a logout; missing token → false', async () => {
    const mgr = new SessionManager();
    const id = seedUser();
    const { token } = await mgr.create(id);
    expect(await mgr.revoke(token)).toBe(true);
    expect(await mgr.validate(token)).toBeNull();
    expect(auditCalls).toContain('logout');
    expect(await mgr.revoke('already-gone')).toBe(false);
  });

  test('revokeByHash refuses a hash owned by another user', async () => {
    const mgr = new SessionManager();
    const u1 = seedUser();
    const u2 = seedUser();
    await mgr.create(u1);
    const [own] = await mgr.listForUserWithHashes(u1);
    // u2 must not be able to revoke u1's session by its hash.
    expect(await mgr.revokeByHash(u2, own.id)).toBe(false);
    // The rightful owner can.
    expect(await mgr.revokeByHash(u1, own.id)).toBe(true);
    expect(await mgr.countForUser(u1)).toBe(0);
  });

  test('the session cap evicts the oldest, and never signs the user out entirely', async () => {
    const mgr = new SessionManager();
    const id = seedUser();

    // 20 is the cap; the 21st must not cost the user the other 20.
    const tokens: string[] = [];
    for (let i = 0; i < 20; i++) {
      tokens.push((await mgr.create(id)).token);
    }
    const fresh = await mgr.create(id);

    // What the old fallback did — revoke everything — showed up in ordinary
    // use, because every WebSocket handshake mints a ticket session: a user
    // opening a few pages hit the cap and had their browser cookie killed
    // mid-click, with a 401 storm on /auth/me as the symptom.
    expect(await mgr.validate(fresh.token)).not.toBeNull();
    expect(await mgr.countForUser(id)).toBe(20);
    // The oldest went, the newest stayed.
    expect(await mgr.validate(tokens[0])).toBeNull();
    expect(await mgr.validate(tokens[19])).not.toBeNull();
  });

  test('a websocket ticket neither fills the cap nor evicts a real session', async () => {
    const mgr = new SessionManager();
    const id = seedUser();
    const login = await mgr.create(id, { channelType: 'web' });

    // One handshake per page, several pages, a couple of reconnects: this is a
    // normal minute of use, not an attack.
    for (let i = 0; i < 40; i++) {
      await mgr.create(id, { channelType: 'web', channelId: 'ws-ticket', ttlMs: 60_000 });
    }

    // The login the user actually made is still valid.
    expect(await mgr.validate(login.token)).not.toBeNull();
  });

  test('a real login behind a pile of tickets evicts nothing', async () => {
    const mgr = new SessionManager();
    const id = seedUser();
    // Two real logins — browser and phone — then a browser tab's worth of
    // handshake tickets, more than the cap on their own.
    const browser = await mgr.create(id, { channelType: 'web' });
    const phone = await mgr.create(id, { channelType: 'mobile' });
    for (let i = 0; i < 25; i++) {
      await mgr.create(id, { channelType: 'web', channelId: 'ws-ticket', ttlMs: 60_000 });
    }

    // A third real login runs the cap block, which counted the tickets and
    // then evicted oldest-first — and the tickets are always the NEWEST
    // entries, so the victims were the two real logins.
    const desktop = await mgr.create(id, { channelType: 'desktop' });

    expect(await mgr.validate(browser.token)).not.toBeNull();
    expect(await mgr.validate(phone.token)).not.toBeNull();
    expect(await mgr.validate(desktop.token)).not.toBeNull();
  });

  test('revokeAllForUser clears every session and returns the count', async () => {
    const mgr = new SessionManager();
    const id = seedUser();
    await mgr.create(id);
    await mgr.create(id);
    expect(await mgr.revokeAllForUser(id)).toBe(2);
    expect(await mgr.countForUser(id)).toBe(0);
  });
});

describe('SessionManager.listForUser', () => {
  test('lists active sessions without leaking the userId, and scopes per user', async () => {
    const mgr = new SessionManager();
    const u1 = seedUser();
    const u2 = seedUser();
    await mgr.create(u1, { channelType: 'web' });
    await mgr.create(u2, { channelType: 'cli' });

    const list = await mgr.listForUser(u1);
    expect(list).toHaveLength(1);
    expect((list[0] as Record<string, unknown>).userId).toBeUndefined();
    expect(list[0].channelType).toBe('web');
  });
});

describe('SessionManager.refresh', () => {
  test('extends expiry for a live token and returns null for an unknown one', async () => {
    const mgr = new SessionManager();
    const id = seedUser();
    const { token, session } = await mgr.create(id, { ttlMs: 1000 });
    await new Promise((r) => setTimeout(r, 5));
    const refreshed = await mgr.refresh(token);
    expect(refreshed).not.toBeNull();
    expect(new Date(refreshed!.expiresAt).getTime()).toBeGreaterThan(new Date(session.expiresAt).getTime());
    expect(await mgr.refresh('unknown')).toBeNull();
  });
});

describe('SessionManager max-session cap', () => {
  test('never lets a single user exceed the 20-session cap', async () => {
    const mgr = new SessionManager();
    const id = seedUser();
    for (let i = 0; i < 25; i++) {
      await mgr.create(id);
      expect(await mgr.countForUser(id)).toBeLessThanOrEqual(20);
    }
  });
});
