/**
 * Route-level test for /api/auth/api-tokens (Phase 2a).
 *
 * Boots two app instances (alice + bob) against an ephemeral PGlite
 * and asserts:
 *   - POST returns the plaintext exactly once and a 201 status.
 *   - GET lists only the principal's tokens.
 *   - DELETE returns 404 when alice tries to revoke bob's token; bob's
 *     token still validates afterwards.
 *   - Unauthenticated calls return 401.
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
let anonApp: ElysiaLike;
const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-tok-iso-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: aliceId, username: 'alice' },
    { id: bobId, username: 'bob' },
  ]);

  const { apiTokenRoutes } = await import('./api-tokens');
  const { ANONYMOUS_PRINCIPAL, principalFromUser } = await import('@/security/principal');

  const buildApp = (uid: string | null): ElysiaLike =>
    new Elysia()
      .derive(() => {
        if (!uid) return { user: null, session: null, principal: ANONYMOUS_PRINCIPAL };
        const u = { id: uid, username: uid === aliceId ? 'alice' : 'bob', isAdmin: false };
        return { user: u, session: null, principal: principalFromUser(u) };
      })
      .group('/api', (a) => a.use(apiTokenRoutes)) as unknown as ElysiaLike;

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

describe('POST /api/auth/api-tokens', () => {
  test('issues a token, returns plaintext + 201', async () => {
    const r = await postJson(aliceApp, '/api/auth/api-tokens', { name: 'route-test' });
    expect(r.status).toBe(201);
    expect(r.body.token).toMatch(/^octi_/);
    expect(r.body.id).toBeDefined();
    expect(r.body.prefix).toBe(r.body.token.slice(0, 12));
  });

  test('rejects unauthenticated callers with 401', async () => {
    const r = await postJson(anonApp, '/api/auth/api-tokens', { name: 'denied' });
    expect(r.status).toBe(401);
  });

  test('rejects invalid expiresAt with 400', async () => {
    const r = await postJson(aliceApp, '/api/auth/api-tokens', {
      name: 'bad-date', expiresAt: 'not-a-date',
    });
    expect(r.status).toBe(400);
  });
});

describe('GET /api/auth/api-tokens cross-tenant', () => {
  test('list returns only the principal’s own tokens, no plaintext, no hash', async () => {
    await postJson(aliceApp, '/api/auth/api-tokens', { name: 'alice-list-1' });
    await postJson(bobApp,   '/api/auth/api-tokens', { name: 'bob-list-1' });

    const aliceList = await get(aliceApp, '/api/auth/api-tokens');
    expect(aliceList.status).toBe(200);
    expect(aliceList.body.tokens.find((t: any) => t.name === 'bob-list-1')).toBeUndefined();
    expect(aliceList.body.tokens.find((t: any) => t.name === 'alice-list-1')).toBeDefined();
    // No plaintext, no hash leaked through the GET shape.
    for (const t of aliceList.body.tokens) {
      expect(t.token).toBeUndefined();
      expect(t.tokenHash).toBeUndefined();
    }

    const bobList = await get(bobApp, '/api/auth/api-tokens');
    expect(bobList.body.tokens.every((t: any) => !t.name.startsWith('alice-'))).toBe(true);
  });
});

describe('DELETE /api/auth/api-tokens/:id cross-tenant', () => {
  test('alice cannot revoke bob’s token — 404, token still validates', async () => {
    const issued = await postJson(bobApp, '/api/auth/api-tokens', { name: 'bob-keepalive' });
    const tokenId = issued.body.id;
    const plaintext = issued.body.token;

    const r = await del(aliceApp, `/api/auth/api-tokens/${tokenId}`);
    expect(r.status).toBe(404);

    // Bob's token still validates against the manager.
    const { getApiTokenManager } = await import('@/security/api-tokens');
    expect(await getApiTokenManager().validate(plaintext)).not.toBeNull();
  });

  test('bob can revoke his own token', async () => {
    const issued = await postJson(bobApp, '/api/auth/api-tokens', { name: 'bob-revokable' });
    const tokenId = issued.body.id;
    const plaintext = issued.body.token;

    const r = await del(bobApp, `/api/auth/api-tokens/${tokenId}`);
    expect(r.status).toBe(200);
    expect(r.body.revoked).toBe(true);

    const { getApiTokenManager } = await import('@/security/api-tokens');
    expect(await getApiTokenManager().validate(plaintext)).toBeNull();
  });

  test('revoking an unknown token id returns 404', async () => {
    const r = await del(aliceApp, '/api/auth/api-tokens/00000000-0000-0000-0000-000000000000');
    expect(r.status).toBe(404);
  });
});
