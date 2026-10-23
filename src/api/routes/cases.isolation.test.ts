/**
 * /api/cases and /api/contacts through the routes: a case or contact of
 * another user is a 404 on every endpoint, bad input is a 400, and a case's
 * links and follow-ups come back resolved.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Elysia } from '@/api/http';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '11111111-1111-4111-8111-111111111111';
const bobId = '22222222-2222-4222-8222-222222222222';
let aliceApp: ElysiaLike;
let bobApp: ElysiaLike;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-cases-routes-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${aliceId}', 'alice', false), ('${bobId}', 'bob', false) ON CONFLICT DO NOTHING`);

  const { caseRoutes, contactRoutes } = await import('./cases');
  const { principalFromUser } = await import('@/security/principal');
  const build = (uid: string): ElysiaLike =>
    new Elysia()
      .derive(() => {
        const u = { id: uid, username: 'u', isAdmin: false };
        return { user: u, session: null, principal: principalFromUser(u) };
      })
      .group('/api', (a) => a.use(caseRoutes).use(contactRoutes)) as unknown as ElysiaLike;
  aliceApp = build(aliceId);
  bobApp = build(bobId);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function call(app: ElysiaLike, method: string, path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  }));
  return { status: res.status, body: await res.json() };
}

describe('/api/cases', () => {
  test('create, link, follow up, read back', async () => {
    const created = await call(aliceApp, 'POST', '/api/cases', { title: 'Invoice 4711', kind: 'invoice' });
    expect(created.status).toBe(200);
    const contact = await call(aliceApp, 'POST', '/api/contacts', { name: 'Lieferant AG', kind: 'organization', tags: ['Supplier', 'supplier'] });
    expect(contact.body.tags).toEqual(['supplier']);

    const link = await call(aliceApp, 'POST', `/api/cases/${created.body.id}/links`, { entityType: 'contact', entityId: contact.body.id, role: 'sender' });
    expect(link.status).toBe(200);
    expect(link.body.label).toBe('Lieferant AG');

    const followUp = await call(aliceApp, 'POST', `/api/cases/${created.body.id}/follow-ups`, { title: 'Pay by Friday', remindAt: '2030-01-03T09:00:00Z' });
    expect(followUp.status).toBe(200);
    expect(new Date(followUp.body.task.remindAt).toISOString()).toBe('2030-01-03T09:00:00.000Z');

    const read = await call(aliceApp, 'GET', `/api/cases/${created.body.id}`);
    expect(read.body.links.map((l: { entityType: string; role: string }) => [l.entityType, l.role])).toEqual([['contact', 'sender'], ['task', 'follow_up']]);

    const ofContact = await call(aliceApp, 'GET', `/api/contacts/${contact.body.id}`);
    expect(ofContact.body.cases.map((c: { id: string }) => c.id)).toEqual([created.body.id]);
    const linked = await call(aliceApp, 'GET', `/api/cases/linked?entityType=contact&entityId=${contact.body.id}`);
    expect(linked.body).toHaveLength(1);
  });

  test("another user's case and contact are 404 on every endpoint", async () => {
    const c = (await call(aliceApp, 'POST', '/api/cases', { title: 'private' })).body;
    const k = (await call(aliceApp, 'POST', '/api/contacts', { name: 'private' })).body;
    expect((await call(bobApp, 'GET', `/api/cases/${c.id}`)).status).toBe(404);
    expect((await call(bobApp, 'PATCH', `/api/cases/${c.id}`, { title: 'x' })).status).toBe(404);
    expect((await call(bobApp, 'DELETE', `/api/cases/${c.id}`)).status).toBe(404);
    expect((await call(bobApp, 'POST', `/api/cases/${c.id}/follow-ups`, { title: 'x', remindAt: '2030-01-01T00:00:00Z' })).status).toBe(404);
    expect((await call(bobApp, 'GET', `/api/contacts/${k.id}`)).status).toBe(404);
    expect((await call(bobApp, 'PATCH', `/api/contacts/${k.id}`, { name: 'x' })).status).toBe(404);
    expect((await call(bobApp, 'DELETE', `/api/contacts/${k.id}`)).status).toBe(404);
    const bobCase = (await call(bobApp, 'POST', '/api/cases', { title: 'bob' })).body;
    // Bob cannot link alice's contact into his own case.
    expect((await call(bobApp, 'POST', `/api/cases/${bobCase.id}/links`, { entityType: 'contact', entityId: k.id })).status).toBe(400);
    expect((await call(bobApp, 'GET', '/api/cases')).body.map((r: { id: string }) => r.id)).not.toContain(c.id);
    expect((await call(aliceApp, 'GET', `/api/cases/${c.id}`)).status).toBe(200);
  });

  test('a body the schema refuses is a 422, a refused value a 400', async () => {
    const c = (await call(aliceApp, 'POST', '/api/cases', { title: 'validate' })).body;
    expect((await call(aliceApp, 'POST', '/api/cases', { title: '' })).status).toBe(422);
    expect((await call(aliceApp, 'PATCH', `/api/cases/${c.id}`, { status: 'closed' })).status).toBe(422);
    expect((await call(aliceApp, 'POST', `/api/cases/${c.id}/follow-ups`, { title: 'x', remindAt: 'next week' })).status).toBe(400);
    expect((await call(aliceApp, 'POST', '/api/cases', { title: 'x', assigneeUserId: bobId })).status).toBe(400);
    expect((await call(aliceApp, 'POST', '/api/cases', { title: '   ' })).status).toBe(400);
    expect((await call(aliceApp, 'PATCH', `/api/cases/${c.id}`, { title: ' ' })).status).toBe(400);
    expect((await call(aliceApp, 'POST', '/api/contacts', { name: '  ' })).status).toBe(400);
    expect((await call(aliceApp, 'POST', `/api/cases/${c.id}/follow-ups`, { title: ' ', remindAt: '2030-01-01' })).status).toBe(400);
  });

  test("/linked shows nothing for an entity the caller cannot see", async () => {
    const k = (await call(aliceApp, 'POST', '/api/contacts', { name: 'linked-private' })).body;
    const c = (await call(aliceApp, 'POST', '/api/cases', { title: 'linked-private' })).body;
    await call(aliceApp, 'POST', `/api/cases/${c.id}/links`, { entityType: 'contact', entityId: k.id });
    expect((await call(aliceApp, 'GET', `/api/cases/linked?entityType=contact&entityId=${k.id}`)).body).toHaveLength(1);
    expect((await call(bobApp, 'GET', `/api/cases/linked?entityType=contact&entityId=${k.id}`)).body).toEqual([]);
  });
});
