/**
 * The distil offer's routes over Elysia against embedded PGlite: only the
 * session's owner, in person, with chat scope, may read and decide an offer,
 * and turning the offers off is audited. No model is called: every request
 * here is refused or dismisses.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Elysia } from '@/api/http';
import type { Principal } from '@/security/principal';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = 'aaaaaaaa-5555-4555-8555-555555555555';
const bobId = 'bbbbbbbb-6666-4666-8666-666666666666';
const adminId = 'cccccccc-7777-4777-8777-777777777777';
const sessionId = randomUUID();
let answerId = '';

async function app(principalOf: () => Principal, user: { id: string; username: string; isAdmin: boolean }): Promise<ElysiaLike> {
  const { distillNudgeRoutes } = await import('./distill-nudge');
  return new Elysia()
    .derive(() => ({ user, session: null, principal: principalOf() }))
    .group('/api', (a) => a.use(distillNudgeRoutes)) as unknown as ElysiaLike;
}

async function as(principal: Partial<Principal>, user = { id: aliceId, username: 'alice', isAdmin: false }) {
  const { principalFromUser } = await import('@/security/principal');
  return app(() => ({ ...principalFromUser(user), ...principal }), user);
}

const post = (a: ElysiaLike, path: string, body: unknown, method = 'POST') =>
  a.handle(new Request(`http://localhost/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const get = (a: ElysiaLike, path: string) => a.handle(new Request(`http://localhost/api${path}`));

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-distill-nudge-routes-'));
  const { initializeDb, executeRaw, getDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: aliceId, username: 'alice' }, { id: bobId, username: 'bob' }, { id: adminId, username: 'root', isAdmin: true }]);
  await executeRaw(`INSERT INTO sessions (id, user_id, channel_type, channel_id) VALUES ('${sessionId}', '${aliceId}', 'webchat', 'nudge-routes')`);
  const { messages } = await import('@/db/schema/messages');
  const [answer] = await getDb().insert(messages).values({ sessionId, role: 'assistant', content: 'Released.', metadata: {
    skillNudge: { state: 'offered', runId: 'run_x', userId: aliceId, startedAt: new Date().toISOString(), offeredAt: new Date().toISOString() },
  } }).returning();
  answerId = answer.id;
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('the distil offer routes', () => {
  test('the owner sees the open offer', async () => {
    const res = await get(await as({}), `/sessions/${sessionId}/distill-nudge`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ nudge: { messageId: answerId } });
  });

  test('another user\'s session is not found, and an admin reading it sees no offer', async () => {
    const bob = await as({}, { id: bobId, username: 'bob', isAdmin: false });
    expect((await get(bob, `/sessions/${sessionId}/distill-nudge`)).status).toBe(404);
    expect((await post(bob, `/sessions/${sessionId}/distill-nudge/${answerId}`, { decision: 'dismiss' })).status).toBe(404);
    const admin = await as({}, { id: adminId, username: 'root', isAdmin: true });
    // An admin may read the chat, but the offer is the owner's.
    const read = await get(admin, `/sessions/${sessionId}/distill-nudge`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ nudge: null });
    expect((await post(admin, `/sessions/${sessionId}/distill-nudge/${answerId}`, { decision: 'dismiss' })).status).toBe(404);
  });

  test('nothing is decided while an admin acts as the user', async () => {
    const acting = await as({ actorUserId: adminId });
    expect(await (await get(acting, `/sessions/${sessionId}/distill-nudge`)).json()).toEqual({ nudge: null });
    expect((await post(acting, `/sessions/${sessionId}/distill-nudge/${answerId}`, { decision: 'accept' })).status).toBe(403);
    expect((await post(acting, '/auth/distill-nudge', { enabled: false }, 'PUT')).status).toBe(403);
  });

  test('a token without chat scope cannot decide', async () => {
    const scoped = await as({ scopes: ['api:read'] });
    expect((await post(scoped, `/sessions/${sessionId}/distill-nudge/${answerId}`, { decision: 'accept' })).status).toBe(403);
  });

  test('turning the offers off is stored and audited', async () => {
    const res = await post(await as({}), '/auth/distill-nudge', { enabled: false }, 'PUT');
    expect(await res.json()).toEqual({ distillNudge: false });
    const { getDb } = await import('@/db/postgres');
    const { auditLog } = await import('@/db/schema/audit');
    const { and, eq } = await import('drizzle-orm');
    const rows = await getDb().select({ details: auditLog.details }).from(auditLog)
      .where(and(eq(auditLog.userId, aliceId), eq(auditLog.action, 'settings_changed')));
    expect(rows.map((row) => row.details)).toContainEqual(expect.objectContaining({ setting: 'preferences.distillNudge', enabled: false }));
  });

  test('the owner dismisses; a second decision conflicts', async () => {
    const alice = await as({});
    const res = await post(alice, `/sessions/${sessionId}/distill-nudge/${answerId}`, { decision: 'dismiss' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'dismissed' });
    const again = await post(alice, `/sessions/${sessionId}/distill-nudge/${answerId}`, { decision: 'dismiss' });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'decided' });
  });
});
