/**
 * Route-level cross-tenant isolation test for /api/sessions.
 *
 * Spins up the actual Elysia route module against an ephemeral PGlite
 * with two users and verifies that:
 *   - GET /sessions/:id returns "Session not found" when alice asks for
 *     bob's session (collapses 403/404 to prevent ID enumeration).
 *   - GET /sessions returns only the principal's own rows.
 *   - GET /sessions/:id/messages returns "not found" cross-tenant.
 *   - PATCH/DELETE on a foreign session is a no-op.
 *
 * This complements the repository-level isolation tests by exercising
 * the route handler's principal-derivation + scoped-repo wiring.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

let aliceApp: ElysiaLike;
let bobApp: ElysiaLike;
const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';
let aliceSessionId: string;
let bobSessionId: string;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-sess-iso-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  // Seed via raw SQL helpers — go around the repo singletons because
  // bun's mock.module from other test files (notably commands.test.ts)
  // may have replaced them with partial stubs.
  const { seedMessage, seedSession, seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: aliceId, username: 'alice' },
    { id: bobId, username: 'bob' },
  ]);
  aliceSessionId = (await seedSession({ userId: aliceId, channelId: 'a-1', title: 'alice' })).id;
  bobSessionId = (await seedSession({ userId: bobId, channelId: 'b-1', title: 'bob' })).id;
  await seedMessage({ sessionId: bobSessionId, role: 'user', content: 'bob secret' });

  const { sessionRoutes } = await import('./sessions');
  const { principalFromUser } = await import('@/security/principal');

  // Two app instances, each derives a different principal — same trick the
  // real server uses, just hard-coded for the test.
  const buildApp = (uid: string, isAdmin: boolean): ElysiaLike =>
    new Elysia()
      .derive(() => {
        const u = { id: uid, username: uid === aliceId ? 'alice' : 'bob', isAdmin };
        return { user: u, session: null, principal: principalFromUser(u) };
      })
      .group('/api', (a) => a.use(sessionRoutes)) as unknown as ElysiaLike;

  aliceApp = buildApp(aliceId, false);
  bobApp = buildApp(bobId, false);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function get(app: ElysiaLike, path: string): Promise<{ status: number; body: any }> {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json() };
}
async function patch(app: ElysiaLike, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}
async function del(app: ElysiaLike, path: string): Promise<{ status: number; body: any }> {
  const res = await app.handle(new Request(`http://localhost${path}`, { method: 'DELETE' }));
  return { status: res.status, body: await res.json() };
}

describe('GET /api/sessions/:id cross-tenant', () => {
  test('alice cannot read bob’s session — sees the same not-found shape', async () => {
    const own = await get(aliceApp, `/api/sessions/${aliceSessionId}`);
    expect(own.body.id).toBe(aliceSessionId);

    const cross = await get(aliceApp, `/api/sessions/${bobSessionId}`);
    expect(cross.body).toEqual({ error: 'Session not found' });

    const ghost = await get(aliceApp, `/api/sessions/00000000-0000-0000-0000-000000000000`);
    expect(ghost.body).toEqual({ error: 'Session not found' });
  });
});

describe('GET /api/sessions cross-tenant', () => {
  test('list only returns the principal’s own sessions', async () => {
    const r = await get(aliceApp, '/api/sessions');
    expect(Array.isArray(r.body.sessions)).toBe(true);
    expect(r.body.sessions.every((s: any) => s.userId === aliceId)).toBe(true);
    expect(r.body.sessions.find((s: any) => s.id === bobSessionId)).toBeUndefined();
  });
});

describe('GET /api/sessions/:id/messages cross-tenant', () => {
  test('alice cannot read bob’s messages', async () => {
    const r = await get(aliceApp, `/api/sessions/${bobSessionId}/messages`);
    expect(r.body).toEqual({ error: 'Session not found' });
  });

  test('bob can read his own messages', async () => {
    const r = await get(bobApp, `/api/sessions/${bobSessionId}/messages`);
    expect(Array.isArray(r.body.messages)).toBe(true);
    expect(r.body.messages.find((m: any) => m.content === 'bob secret')).toBeDefined();
  });
});

describe('PATCH /api/sessions/:id cross-tenant', () => {
  test('alice cannot mutate bob’s session', async () => {
    const r = await patch(aliceApp, `/api/sessions/${bobSessionId}`, { title: 'pwned' });
    expect(r.body).toEqual({ error: 'Session not found' });

    const verify = await get(bobApp, `/api/sessions/${bobSessionId}`);
    expect(verify.body.title).toBe('bob');
  });
});

describe('DELETE /api/sessions/:id cross-tenant', () => {
  test('alice cannot delete bob’s session', async () => {
    const r = await del(aliceApp, `/api/sessions/${bobSessionId}`);
    expect(r.body).toEqual({ error: 'Session not found' });

    const verify = await get(bobApp, `/api/sessions/${bobSessionId}`);
    expect(verify.body.id).toBe(bobSessionId);
  });
});
