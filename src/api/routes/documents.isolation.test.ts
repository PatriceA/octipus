/**
 * Route-level cross-tenant isolation test for /api/documents.
 *
 * Boots two app instances (alice + bob) against an ephemeral PGlite,
 * seeds a document for each, and asserts no read/list/delete crosses
 * tenants. Cross-tenant reads now surface as 404 (was 403 before
 * Phase 1a) — collapses the two states to prevent ID enumeration.
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
const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';
let aliceDocId: string;
let bobDocId: string;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-doc-iso-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedDocument, seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: aliceId, username: 'alice' },
    { id: bobId, username: 'bob' },
  ]);
  aliceDocId = (await seedDocument({ userId: aliceId, originalName: 'alice.pdf' })).id;
  bobDocId = (await seedDocument({ userId: bobId, originalName: 'bob.pdf' })).id;

  const { documentRoutes } = await import('./documents');
  const { principalFromUser } = await import('@/security/principal');

  const buildApp = (uid: string): ElysiaLike =>
    new Elysia()
      .derive(() => {
        const u = { id: uid, username: uid === aliceId ? 'alice' : 'bob', isAdmin: false };
        return { user: u, session: null, principal: principalFromUser(u) };
      })
      .group('/api', (a) => a.use(documentRoutes)) as unknown as ElysiaLike;

  aliceApp = buildApp(aliceId);
  bobApp = buildApp(bobId);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function get(app: ElysiaLike, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json() };
}
async function del(app: ElysiaLike, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`, { method: 'DELETE' }));
  return { status: res.status, body: await res.json() };
}

describe('GET /api/documents/:id cross-tenant', () => {
  test('alice cannot read bob’s document — 404 not 403', async () => {
    const own = await get(aliceApp, `/api/documents/${aliceDocId}`);
    expect(own.status).toBe(200);
    expect(own.body.id).toBe(aliceDocId);

    const cross = await get(aliceApp, `/api/documents/${bobDocId}`);
    expect(cross.status).toBe(404);
    expect(cross.body.error).toBe('Document not found');
  });
});

describe('GET /api/documents cross-tenant', () => {
  test('list only returns the principal’s own documents', async () => {
    const r = await get(aliceApp, '/api/documents');
    expect(r.body.documents.every((d: any) => d.id !== bobDocId)).toBe(true);
    expect(r.body.documents.find((d: any) => d.id === aliceDocId)).toBeDefined();
  });
});

describe('DELETE /api/documents/:id cross-tenant', () => {
  test('alice cannot delete bob’s document; row stays', async () => {
    const r = await del(aliceApp, `/api/documents/${bobDocId}`);
    expect(r.status).toBe(404);
    const verify = await get(bobApp, `/api/documents/${bobDocId}`);
    expect(verify.status).toBe(200);
    expect(verify.body.id).toBe(bobDocId);
  });
});

describe('POST /api/documents/:id/cancel cross-tenant', () => {
  test('alice cannot cancel bob’s queued document', async () => {
    const res = await aliceApp.handle(new Request(
      `http://localhost/api/documents/${bobDocId}/cancel`,
      { method: 'POST' },
    ));
    expect(res.status).toBe(404);
    const verify = await get(bobApp, `/api/documents/${bobDocId}`);
    expect(verify.body.status).toBe('queued');
  });
});
