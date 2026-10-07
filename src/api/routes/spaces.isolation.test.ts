/**
 * Shared spaces — routes (docs/plans/coworking-spec.md §5.7, I3).
 *
 * Driven through the real `createServer()`, so the real auth derive, auth
 * guard, workspace derive and rate limiter run (the org isolation suite mounts
 * the routes without them):
 *
 *   - a user who is not a member gets 404 on every space route, for an
 *     existing space and a made-up id alike;
 *   - a viewer can read but not manage; an editor cannot manage members or
 *     invites; the owner can;
 *   - `GET /api/invites/:token` is public, `POST .../accept` is not.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const ownerId = randomUUID();
const editorId = randomUUID();
const viewerId = randomUUID();
const strangerId = randomUUID();

type App = { handle(request: Request): Promise<Response> };
let app: App;
const tokens: Record<string, string> = {};
let spaceId: string;
let inviteId: string;

async function call(who: string | null, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (who) headers.authorization = `Bearer ${tokens[who]}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.handle(new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-spaces-routes-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: ownerId, username: 'owner' },
    { id: editorId, username: 'editor' },
    { id: viewerId, username: 'viewer' },
    { id: strangerId, username: 'stranger', isAdmin: true },
  ]);
  const { getSessionManager } = await import('@/security/auth/session');
  for (const [name, id] of [['owner', ownerId], ['editor', editorId], ['viewer', viewerId], ['stranger', strangerId]]) {
    tokens[name] = (await getSessionManager().create(id)).token;
  }
  const { createServer } = await import('@/api/server');
  app = createServer();

  const created = await call('owner', 'POST', '/api/spaces', { name: 'Launch' });
  expect(created.status).toBe(201);
  spaceId = (await created.json()).id;
  for (const [who, role] of [['editor', 'editor'], ['viewer', 'viewer']]) {
    const res = await call('owner', 'POST', `/api/spaces/${spaceId}/invites`, { role });
    expect(res.status).toBe(201);
    const { token } = await res.json();
    expect((await call(who, 'POST', `/api/invites/${token}/accept`)).status).toBe(200);
  }
  const pending = await call('owner', 'POST', `/api/spaces/${spaceId}/invites`, { role: 'commenter', expiresInHours: 2 });
  inviteId = (await pending.json()).id;
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

/** Every space route, with a body that would be valid for an authorised caller. */
function routes(id: string): Array<[string, string, unknown?]> {
  return [
    ['GET', `/api/spaces/${id}`],
    ['PATCH', `/api/spaces/${id}`, { name: 'Taken' }],
    ['POST', `/api/spaces/${id}/archive`],
    ['POST', `/api/spaces/${id}/unarchive`],
    ['DELETE', `/api/spaces/${id}`],
    ['GET', `/api/spaces/${id}/members`],
    ['PATCH', `/api/spaces/${id}/members/${editorId}`, { role: 'viewer' }],
    ['DELETE', `/api/spaces/${id}/members/${editorId}`],
    ['GET', `/api/spaces/${id}/invites`],
    ['POST', `/api/spaces/${id}/invites`, { role: 'viewer' }],
    ['DELETE', `/api/spaces/${id}/invites/${inviteId}`],
    ['GET', `/api/spaces/${id}/activity`],
  ];
}

describe('non-members (I3)', () => {
  test('a user who is not a member gets 404 on every space route — even an admin', async () => {
    for (const id of [spaceId, randomUUID(), 'not-a-uuid']) {
      for (const [method, path, body] of routes(id)) {
        const res = await call('stranger', method, path, body);
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
    const list = await (await call('stranger', 'GET', '/api/spaces')).json();
    expect(list.spaces).toEqual([]);
    const mine = await (await call('viewer', 'GET', '/api/spaces')).json();
    expect(mine.spaces).toEqual([expect.objectContaining({ id: spaceId, role: 'viewer', memberCount: 3 })]);
    // Nothing changed.
    const space = await (await call('owner', 'GET', `/api/spaces/${spaceId}`)).json();
    expect(space).toMatchObject({ name: 'Launch', memberCount: 3, archivedAt: null });
  });

  test('anonymous callers get 401 on every space route', async () => {
    for (const [method, path, body] of [...routes(spaceId), ['GET', '/api/spaces'], ['POST', '/api/spaces', { name: 'x' }]] as Array<[string, string, unknown?]>) {
      const res = await call(null, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('roles', () => {
  test('a viewer reads but cannot manage or write', async () => {
    expect((await call('viewer', 'GET', `/api/spaces/${spaceId}`)).status).toBe(200);
    expect((await call('viewer', 'GET', `/api/spaces/${spaceId}/members`)).status).toBe(200);
    expect((await call('viewer', 'GET', `/api/spaces/${spaceId}/activity`)).status).toBe(200);
    for (const [method, path, body] of routes(spaceId)) {
      if (method === 'GET' && !path.endsWith('/invites')) continue;
      // Removing oneself is leaving, which a viewer may; the route here targets the editor.
      const res = await call('viewer', method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  test('an editor cannot manage members or invites', async () => {
    const forbidden: Array<[string, string, unknown?]> = [
      ['PATCH', `/api/spaces/${spaceId}/members/${viewerId}`, { role: 'editor' }],
      ['DELETE', `/api/spaces/${spaceId}/members/${viewerId}`],
      ['GET', `/api/spaces/${spaceId}/invites`],
      ['POST', `/api/spaces/${spaceId}/invites`, { role: 'viewer' }],
      ['DELETE', `/api/spaces/${spaceId}/invites/${inviteId}`],
      ['PATCH', `/api/spaces/${spaceId}`, { name: 'Mine' }],
      ['POST', `/api/spaces/${spaceId}/archive`],
    ];
    for (const [method, path, body] of forbidden) {
      const res = await call('editor', method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await res.json()).code).toBe('forbidden_role');
    }
    const members = await (await call('editor', 'GET', `/api/spaces/${spaceId}/members`)).json();
    expect(members.members.find((m: { userId: string }) => m.userId === viewerId).role).toBe('viewer');
  });

  test('the owner manages; the last owner cannot leave (409); bodies are strict', async () => {
    const listed = await (await call('owner', 'GET', `/api/spaces/${spaceId}/invites`)).json();
    expect(listed.invites.length).toBeGreaterThan(0);
    expect(JSON.stringify(listed)).not.toMatch(/token/i);
    const res = await call('owner', 'DELETE', `/api/spaces/${spaceId}/members/${ownerId}`);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('last_owner');
    expect((await call('owner', 'PATCH', `/api/spaces/${spaceId}`, { name: 'Ok', extra: 1 })).status).toBe(422);
    expect((await call('owner', 'POST', `/api/spaces/${spaceId}/invites`, { role: 'owner' })).status).toBe(422);
    const activity = await (await call('owner', 'GET', `/api/spaces/${spaceId}/activity?limit=2`)).json();
    expect(activity.activity).toHaveLength(2);
    // Purge before archive: 409.
    expect((await call('owner', 'DELETE', `/api/spaces/${spaceId}`)).status).toBe(409);
  });
});

describe('invite links', () => {
  test('the link is on the public URL when one is set, so other devices can open it', async () => {
    const before = process.env.PUBLIC_URL;
    try {
      delete process.env.PUBLIC_URL;
      const plain = await (await call('owner', 'POST', `/api/spaces/${spaceId}/invites`, { role: 'viewer' })).json();
      expect(plain.url).toBeNull();
      process.env.PUBLIC_URL = 'https://octi.example.net/';
      const res = await call('owner', 'POST', `/api/spaces/${spaceId}/invites`, { role: 'viewer' });
      expect(res.status).toBe(201);
      const created = await res.json();
      expect(created.url).toBe(`https://octi.example.net/join/${created.token}`);
    } finally {
      if (before === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = before;
    }
  });

  test('the preview is public; accepting needs a session; a revoked token 404s', async () => {
    const created = await (await call('owner', 'POST', `/api/spaces/${spaceId}/invites`, { role: 'viewer' })).json();
    const preview = await call(null, 'GET', `/api/invites/${created.token}`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ spaceName: 'Launch', inviterName: 'owner', role: 'viewer' });
    // The public entry is GET only and exactly that shape.
    expect((await call(null, 'POST', `/api/invites/${created.token}/accept`)).status).toBe(401);
    expect((await call(null, 'GET', `/api/invites/${created.token}/accept`)).status).toBe(401);
    expect((await call(null, 'GET', `/api/invites/${rand(32)}`)).status).toBe(404);

    expect((await call('owner', 'DELETE', `/api/spaces/${spaceId}/invites/${created.id}`)).status).toBe(200);
    expect((await call(null, 'GET', `/api/invites/${created.token}`)).status).toBe(404);
    expect((await call('stranger', 'POST', `/api/invites/${created.token}/accept`)).status).toBe(404);

    // The request audit records the accept without the token.
    const { queryRaw } = await import('@/db/postgres');
    const seen = async () => (await queryRaw(
      `SELECT details->>'path' AS path FROM audit_log WHERE action = 'api_request' AND details->>'path' LIKE '/api/invites/%'`,
    )).rows.map((r: { path: string }) => r.path);
    for (let i = 0; i < 50 && (await seen()).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const paths = await seen();
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p === '/api/invites/[token]/accept')).toBe(true);
  });

  test('invite routes are rate-limited as credential attempts', async () => {
    const { isCredentialAttempt } = await import('@/api/middleware/rate-limit');
    const { isPublicRoute } = await import('@/api/middleware/auth-guard');
    expect(isCredentialAttempt('/api/invites/abc')).toBe(true);
    expect(isCredentialAttempt('/api/invites/abc/accept')).toBe(true);
    expect(isPublicRoute('GET', '/api/invites/abc')).toBe(true);
    expect(isPublicRoute('POST', '/api/invites/abc')).toBe(false);
    expect(isPublicRoute('GET', '/api/invites/abc/accept')).toBe(false);
  });
});
