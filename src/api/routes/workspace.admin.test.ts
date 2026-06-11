/**
 * workspace route admin gating.
 *
 * Two of the workspace-config endpoints are operator actions on a shared
 * instance and stay admin-only:
 *  - PUT /workspace               repoints the global workspace root
 *  - POST /workspace/validate     existsSync/statSync on a caller path
 *                                 (host filesystem existence oracle)
 *
 * POST /workspace/repositories is NOT admin-gated: it scaffolds a repo inside
 * the caller's OWN per-user workspace sandbox, so any authenticated user may
 * use it. It is still name- and containment-validated.
 *
 * A non-admin must get 403 on the operator endpoints; an admin must clear the
 * gate. No DB needed — the admin check returns before any persistence/fs work.
 */
import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

async function appFor(isAdmin: boolean): Promise<ElysiaLike> {
  const { workspaceRoutes } = await import('./workspace');
  const { principalFromUser } = await import('@/security/principal');
  const u = { id: 'u-1', username: 'u', isAdmin };
  return new Elysia()
    .derive(() => ({ user: u, session: null, principal: principalFromUser(u) }))
    .group('/api', (a) => a.use(workspaceRoutes)) as unknown as ElysiaLike;
}

async function req(app: ElysiaLike, method: string, path: string, body?: unknown) {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: parsed as { error?: string } };
}

describe('workspace routes — non-admin is forbidden', () => {
  test('PUT /workspace → 403', async () => {
    const r = await req(await appFor(false), 'PUT', '/api/workspace', { rootPath: '/tmp/whatever' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/admin/i);
  });

  test('POST /workspace/validate → 403 (no path existence oracle for non-admins)', async () => {
    const r = await req(await appFor(false), 'POST', '/api/workspace/validate', { path: '/root/.ssh' });
    expect(r.status).toBe(403);
  });

  test('POST /workspace/repositories is NOT admin-gated (per-user sandbox)', async () => {
    // A dot-only name fails *validation* (400) — proving the request cleared
    // the auth gate rather than being rejected as a non-admin (would be 403).
    // Using an invalid name avoids a real mkdir under the user's data root.
    const r = await req(await appFor(false), 'POST', '/api/workspace/repositories', { name: '..' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid repository name/i);
  });
});

describe('workspace routes — admin clears the gate', () => {
  test('POST /workspace/validate as admin is not 403', async () => {
    const r = await req(await appFor(true), 'POST', '/api/workspace/validate', { path: '/tmp' });
    expect(r.status).not.toBe(403);
    // returns the probe result, not an auth error
    expect(r.body.error).toBeUndefined();
  });

  test('POST /workspace/repositories rejects a parentPath outside the workspace', async () => {
    // Admin clears the 403 gate, but an arbitrary parent (e.g. /etc) must be
    // refused with 400 — repos may only land under the root or additional paths.
    const r = await req(await appFor(true), 'POST', '/api/workspace/repositories', {
      name: 'x',
      parentPath: '/etc',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/parent folder/i);
  });

  test('POST /workspace/repositories rejects dot-only names', async () => {
    const r = await req(await appFor(true), 'POST', '/api/workspace/repositories', { name: '..' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid repository name/i);
  });
});
