/**
 * Registration modes (docs/plans/coworking-spec.md §10, S6; docs/SPACES.md →
 * Registration modes), through the real `createServer()`:
 *
 *   - the first account always registers and is the only admin, even when
 *     several race for it and the mode is closed;
 *   - `closed` refuses everyone after it; `GET /api/auth/registration` says so;
 *   - `invite_only` needs a valid invite token, redeemed in the same
 *     transaction as the account: a used-up, revoked or unknown token creates
 *     no account, and two registrations racing for a single-use token get one
 *     account between them;
 *   - a guest invite's scope lands on the new membership;
 *   - a username starting with `~` is refused.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

// Every request of this file comes from one address: the per-IP register
// limit (5 per 5 minutes) is not what is under test.
vi.mock('@/security/rate-limiter', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/security/rate-limiter')>();
  return {
    ...real,
    getRateLimiter: () => new Proxy(real.getRateLimiter(), {
      get(target, key, receiver) {
        if (key === 'check') return async () => ({ allowed: true, remaining: 99 });
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
});

type App = { handle(request: Request): Promise<Response> };
let app: App;
const PASSWORD = 'Passw0rd!';

async function register(username: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return app.handle(new Request('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD, ...extra }),
  }));
}

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql, params)).rows as T[];
}

async function setMode(mode: 'open' | 'invite_only' | 'closed'): Promise<void> {
  const { getConfig } = await import('@/config');
  getConfig().security.registration = mode;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-registration-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { createServer } = await import('@/api/server');
  app = createServer();
}, 120_000);

afterAll(async () => {
  await setMode('open');
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

let ownerId: string;

describe('the first account', () => {
  test('registers whatever the mode, and racing first sign-ups make exactly one admin', async () => {
    expect(await q(`SELECT id FROM users`)).toHaveLength(0);
    await setMode('closed');
    const info = await app.handle(new Request('http://localhost/api/auth/registration'));
    expect(info.status).toBe(200);
    expect(await info.json()).toEqual({ mode: 'closed', firstAccount: true });

    const results = await Promise.all(['first-a', 'first-b', 'first-c'].map((u) => register(u)));
    const ok = results.filter((r) => r.status === 200);
    // Closed: only the first account gets in; the others find it there.
    expect(ok).toHaveLength(1);
    expect(results.filter((r) => r.status === 403)).toHaveLength(2);
    const body = await ok[0].json();
    expect(body.isAdmin).toBe(true);
    ownerId = body.id;
    const admins = await q(`SELECT id FROM users WHERE is_admin`);
    expect(admins).toEqual([{ id: ownerId }]);

    const after = await app.handle(new Request('http://localhost/api/auth/registration'));
    expect(await after.json()).toEqual({ mode: 'closed', firstAccount: false });
  });

  test('open: concurrent registrations all succeed, none becomes admin', async () => {
    await setMode('open');
    const results = await Promise.all(['open-a', 'open-b'].map((u) => register(u)));
    for (const r of results) expect(r.status).toBe(200);
    const rows = await q<{ is_admin: boolean }>(`SELECT is_admin FROM users WHERE username IN ('open-a','open-b')`);
    expect(rows.map((r) => r.is_admin)).toEqual([false, false]);
  });
});

describe('closed', () => {
  test('refuses every registration, with or without an invite', async () => {
    await setMode('closed');
    const res = await register('closed-a');
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('registration_closed');
    expect(await q(`SELECT id FROM users WHERE username = 'closed-a'`)).toHaveLength(0);
  });
});

describe('invite_only', () => {
  let spaceId: string;
  beforeAll(async () => {
    const { createSpace } = await import('@/core/spaces/service');
    spaceId = (await createSpace({ userId: ownerId }, { name: 'Invite only' })).id;
  });

  async function invite(input: { role?: string; maxUses?: number; scope?: unknown } = {}): Promise<string> {
    const { createInvite } = await import('@/core/spaces/invites');
    return (await createInvite({ userId: ownerId }, spaceId, { role: input.role ?? 'editor', maxUses: input.maxUses, scope: input.scope })).token;
  }

  test('without a token: 403 invite_required, no account', async () => {
    await setMode('invite_only');
    const res = await register('no-invite');
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('invite_required');
    expect(await q(`SELECT id FROM users WHERE username = 'no-invite'`)).toHaveLength(0);
    const info = await app.handle(new Request('http://localhost/api/auth/registration'));
    expect(await info.json()).toEqual({ mode: 'invite_only', firstAccount: false });
  });

  test('with a valid token: the account and its membership commit together, and the use is spent', async () => {
    await setMode('invite_only');
    const token = await invite();
    const res = await register('invited-a', { inviteToken: token });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.joinedSpaceId).toBe(spaceId);
    const member = await q(`SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [spaceId, body.id]);
    expect(member).toEqual([{ role: 'editor' }]);
    const [used] = await q<{ use_count: number }>(`SELECT use_count FROM workspace_invites WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`, [spaceId]);
    expect(used.use_count).toBe(1);

    // Used up: the next registration with it creates no account.
    const again = await register('invited-b', { inviteToken: token });
    expect(again.status).toBe(404);
    expect((await again.json()).code).toBe('invite_invalid');
    expect(await q(`SELECT id FROM users WHERE username = 'invited-b'`)).toHaveLength(0);
  });

  test('an unknown or revoked token creates no account, and a failed account spends no use', async () => {
    await setMode('invite_only');
    expect((await register('bogus', { inviteToken: 'f'.repeat(64) })).status).toBe(404);
    expect(await q(`SELECT id FROM users WHERE username = 'bogus'`)).toHaveLength(0);

    const { createInvite, revokeInvite } = await import('@/core/spaces/invites');
    const revoked = await createInvite({ userId: ownerId }, spaceId, { role: 'viewer' });
    await revokeInvite({ userId: ownerId }, spaceId, revoked.id);
    expect((await register('revoked', { inviteToken: revoked.token })).status).toBe(404);
    expect(await q(`SELECT id FROM users WHERE username = 'revoked'`)).toHaveLength(0);

    // A taken username fails the registration before the invite: the use stays.
    const token = await invite();
    expect((await register('invited-a', { inviteToken: token })).status).toBe(409);
    const [row] = await q<{ use_count: number }>(`SELECT use_count FROM workspace_invites WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`, [spaceId]);
    expect(row.use_count).toBe(0);
  });

  test('two registrations racing for a single-use token: one account between them', async () => {
    await setMode('invite_only');
    const token = await invite();
    const results = await Promise.all(['race-a', 'race-b'].map((u) => register(u, { inviteToken: token })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    const created = await q(`SELECT username FROM users WHERE username IN ('race-a','race-b')`);
    expect(created).toHaveLength(1);
    const members = await q(`SELECT m.user_id FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.username IN ('race-a','race-b')`, [spaceId]);
    expect(members).toHaveLength(1);
  });

  test('a guest invite brings its scope to the new membership', async () => {
    await setMode('invite_only');
    const token = await invite({ role: 'guest', scope: { rooms: [], folders: ['/client/'] } });
    const res = await register('guest-reg', { inviteToken: token });
    expect(res.status).toBe(200);
    const { id } = await res.json();
    const [m] = await q<{ role: string; scope: unknown }>(`SELECT role, scope FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [spaceId, id]);
    expect(m).toEqual({ role: 'guest', scope: { rooms: [], folders: ['client'] } });
  });

  test('open mode redeems a given token too, and a bad one fails the registration', async () => {
    await setMode('open');
    const token = await invite({ role: 'viewer' });
    const ok = await register('open-invited', { inviteToken: token });
    expect(ok.status).toBe(200);
    expect((await ok.json()).joinedSpaceId).toBe(spaceId);
    expect((await register('open-bogus', { inviteToken: 'a'.repeat(64) })).status).toBe(404);
    expect(await q(`SELECT id FROM users WHERE username = 'open-bogus'`)).toHaveLength(0);
  });
});

describe('usernames', () => {
  test('a leading ~ is refused (it marks members from other installs)', async () => {
    await setMode('open');
    const res = await register('~mallory');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_username');
    expect(await q(`SELECT id FROM users WHERE username = '~mallory'`)).toHaveLength(0);
  });
});
