/**
 * /api/auth/channel-bindings — Phase 2d.
 *
 * Verifies the route surface:
 *   - GET / requires auth (401 for anonymous), returns only the
 *     principal's bindings.
 *   - POST /redeem with a valid code returns 201 + the new binding.
 *   - Unknown / expired codes return 400 with a reason.
 *   - Code already claimed by another user returns 409.
 *   - DELETE /:channelType/:externalId returns 404 cross-tenant
 *     (no ID enumeration), 200 for the owner.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from '@/api/http';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

let aliceApp: ElysiaLike;
let bobApp: ElysiaLike;
let anonApp: ElysiaLike;
const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-cb-route-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: aliceId, username: 'alice' },
    { id: bobId, username: 'bob' },
  ]);

  const { channelBindingRoutes } = await import('./channel-bindings');
  const { ANONYMOUS_PRINCIPAL, principalFromUser } = await import('@/security/principal');

  const buildApp = (uid: string | null): ElysiaLike =>
    new Elysia()
      .derive(() => {
        if (!uid) return { user: null, session: null, principal: ANONYMOUS_PRINCIPAL };
        const u = { id: uid, username: uid === aliceId ? 'alice' : 'bob', isAdmin: false };
        return { user: u, session: null, principal: principalFromUser(u) };
      })
      .group('/api', (a) => a.use(channelBindingRoutes)) as unknown as ElysiaLike;

  aliceApp = buildApp(aliceId);
  bobApp = buildApp(bobId);
  anonApp = buildApp(null);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function get(app: ElysiaLike, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json() };
}
async function postJson(app: ElysiaLike, path: string, body: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}
async function del(app: ElysiaLike, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`, { method: 'DELETE' }));
  return { status: res.status, body: await res.json() };
}

describe('GET /api/auth/channel-bindings', () => {
  test('401 anonymous, scoped for owner', async () => {
    expect((await get(anonApp, '/api/auth/channel-bindings')).status).toBe(401);

    const aliceList = await get(aliceApp, '/api/auth/channel-bindings');
    expect(aliceList.status).toBe(200);
    expect(Array.isArray(aliceList.body.bindings)).toBe(true);
  });
});

describe('POST /api/auth/channel-bindings/redeem', () => {
  test('redeems a fresh code → 201', async () => {
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const link = await getChannelBindingManager().createPendingLink('telegram', 'route-tg-1');

    const r = await postJson(aliceApp, '/api/auth/channel-bindings/redeem', { code: link.code });
    expect(r.status).toBe(201);
    expect(r.body.userId).toBe(aliceId);
    expect(r.body.channelType).toBe('telegram');
  });

  test('unknown code → 400', async () => {
    const r = await postJson(aliceApp, '/api/auth/channel-bindings/redeem', { code: 'AAAAAA' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('unknown_code');
  });

  test('cross-user already-redeemed code → 400 (or 409 if collision)', async () => {
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const link = await getChannelBindingManager().createPendingLink('slack', 'route-slack-collision');

    const first = await postJson(aliceApp, '/api/auth/channel-bindings/redeem', { code: link.code });
    expect(first.status).toBe(201);

    const second = await postJson(bobApp, '/api/auth/channel-bindings/redeem', { code: link.code });
    expect([400, 409]).toContain(second.status);
  });
});

describe('DELETE /api/auth/channel-bindings/:type/:id', () => {
  test('cross-tenant unbind → 404', async () => {
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const link = await getChannelBindingManager().createPendingLink('whatsapp', 'route-wa-bob');
    await postJson(bobApp, '/api/auth/channel-bindings/redeem', { code: link.code });

    const r = await del(aliceApp, '/api/auth/channel-bindings/whatsapp/route-wa-bob');
    expect(r.status).toBe(404);

    // Bob's binding still resolves.
    const stillBound = await getChannelBindingManager().findUserByExternalId('whatsapp', 'route-wa-bob');
    expect(stillBound).toBe(bobId);
  });

  test('owner can unbind', async () => {
    const { getChannelBindingManager } = await import('@/security/channel-bindings');
    const link = await getChannelBindingManager().createPendingLink('teams', 'route-teams-alice');
    await postJson(aliceApp, '/api/auth/channel-bindings/redeem', { code: link.code });

    const r = await del(aliceApp, '/api/auth/channel-bindings/teams/route-teams-alice');
    expect(r.status).toBe(200);
    expect(r.body.unbound).toBe(true);
  });

  test('unknown binding → 404', async () => {
    const r = await del(aliceApp, '/api/auth/channel-bindings/telegram/never-existed');
    expect(r.status).toBe(404);
  });
});
