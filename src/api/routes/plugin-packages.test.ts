/**
 * The plugin package routes are admin-only, path and URL installs alike, and
 * the registry listing too; a POST names exactly one source.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '@/api/http';
import { principalFromUser } from '@/security/principal';

type TestUser = { id: string; username: string; isAdmin: boolean };
const ADMIN: TestUser = { id: '11111111-1111-4111-8111-111111111111', username: 'owner', isAdmin: true };
const MEMBER: TestUser = { id: '22222222-2222-4222-8222-222222222222', username: 'member', isAdmin: false };

const fixture = vi.hoisted(() => ({
  user: null as TestUser | null,
  calls: [] as Array<{ fn: string; args: unknown[] }>,
}));

vi.mock('@/api/context', async () => ({
  apiContext: new (await import('@/api/http')).App().derive(() => ({
    user: fixture.user,
    principal: fixture.user ? principalFromUser(fixture.user) : { kind: 'anonymous' },
  })),
}));

const row = { name: 'demo', version: '1.0.0', enabled: false, contentHash: `sha256:${'a'.repeat(64)}`, signedBy: 'Acme', warnings: [], manifest: {} };
vi.mock('@/plugins/packages/service', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/plugins/packages/service')>(),
  listPackages: async () => { fixture.calls.push({ fn: 'listPackages', args: [] }); return []; },
  installFromDirectory: async (...args: unknown[]) => { fixture.calls.push({ fn: 'installFromDirectory', args }); return row; },
  configure: async (...args: unknown[]) => { fixture.calls.push({ fn: 'configure', args }); return row; },
  packageView: async () => row,
  setSecret: async () => {},
  uninstall: async () => {},
}));
vi.mock('@/plugins/packages/remote', () => ({
  installFromUrl: async (...args: unknown[]) => { fixture.calls.push({ fn: 'installFromUrl', args }); return row; },
  listRegistry: async () => { fixture.calls.push({ fn: 'listRegistry', args: [] }); return { packages: [], errors: [] }; },
}));

const { pluginPackageRoutes } = await import('./plugin-packages');
const app = new App({ prefix: '/api' }).use(pluginPackageRoutes);

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.handle(new Request(`http://localhost/api/plugin-packages${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

const SHA = `sha256:${'b'.repeat(64)}`;
const ROUTES: Array<[string, string, unknown?]> = [
  ['GET', '/'],
  ['GET', '/registry'],
  ['POST', '/', { path: '/opt/plugins/demo' }],
  ['POST', '/', { url: 'https://plugins.example.com/demo.tar.gz', sha256: SHA }],
  ['PATCH', '/demo', { approveContent: SHA }],
  ['PUT', '/demo/secrets/TOKEN', { value: 'x' }],
  ['DELETE', '/demo'],
];

describe('plugin package routes', () => {
  beforeEach(() => {
    fixture.calls = [];
  });

  test.each(ROUTES)('%s %s: 401 signed out, 403 for a member, and nothing is called', async (method, path, body) => {
    fixture.user = null;
    expect((await call(method, path, body)).status).toBe(401);
    fixture.user = MEMBER;
    expect((await call(method, path, body)).status).toBe(403);
    expect(fixture.calls).toEqual([]);
  });

  test('an admin installs from a path or from a URL with its sha256, and lists the registries', async () => {
    fixture.user = ADMIN;
    expect((await call('POST', '/', { path: '/opt/plugins/demo', upgrade: true })).status).toBe(200);
    const res = await call('POST', '/', { url: 'https://plugins.example.com/demo.tar.gz', sha256: SHA });
    expect([res.status, res.body.signedBy]).toEqual([200, 'Acme']);
    expect((await call('GET', '/registry')).body).toEqual({ packages: [], errors: [] });
    expect(fixture.calls).toEqual([
      { fn: 'installFromDirectory', args: ['/opt/plugins/demo', ADMIN.id, { upgrade: true }] },
      { fn: 'installFromUrl', args: ['https://plugins.example.com/demo.tar.gz', ADMIN.id, { upgrade: false, sha256: SHA }] },
      { fn: 'listRegistry', args: [] },
    ]);
  });

  test('a POST names exactly one source; a URL is https and sha256 goes with it', async () => {
    fixture.user = ADMIN;
    expect((await call('POST', '/', {})).status).toBe(400);
    expect((await call('POST', '/', { path: '/opt/x', url: 'https://plugins.example.com/x.tgz' })).status).toBe(400);
    expect((await call('POST', '/', { url: 'http://plugins.example.com/x.tgz' })).status).toBe(422);
    expect((await call('POST', '/', { path: '/opt/x', sha256: SHA })).status).toBe(400);
    expect((await call('POST', '/', { url: 'https://plugins.example.com/x.tgz', sha256: 'nope' })).status).toBe(422);
    expect(fixture.calls).toEqual([]);
  });
});
