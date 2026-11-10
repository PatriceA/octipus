/**
 * The plugin package routes are admin-only, path, URL and bundled installs
 * alike, and the registry and bundled listings too; a POST names exactly one
 * source.
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
vi.mock('@/plugins/packages/bundled', () => ({
  installBundled: async (...args: unknown[]) => { fixture.calls.push({ fn: 'installBundled', args }); return row; },
  listBundled: async () => { fixture.calls.push({ fn: 'listBundled', args: [] }); return [{ name: 'reader', installed: null }]; },
}));
vi.mock('@/plugins/packages/remote', () => ({
  installFromUrl: async (...args: unknown[]) => { fixture.calls.push({ fn: 'installFromUrl', args }); return row; },
  listRegistry: async () => { fixture.calls.push({ fn: 'listRegistry', args: [] }); return { packages: [], errors: [] }; },
  configuredRegistries: () => [{ name: 'acme', url: 'https://acme.example.com/index.json' }],
  clearRegistryCache: () => {},
}));
vi.mock('@/plugins/packages/listing-pins', () => ({
  resetPin: async (...args: unknown[]) => { fixture.calls.push({ fn: 'resetPin', args }); return args[2] === '1.0.0' ? { contentHash: `sha256:${'c'.repeat(64)}`, signedBy: null } : null; },
}));

vi.mock('@/plugins/packages/marketplace', () => ({
  marketplaceListing: async (...args: unknown[]) => { fixture.calls.push({ fn: 'marketplaceListing', args }); return { state: 'ready', plugins: [] }; },
}));
vi.mock('@/plugins/packages/marketplace-updates', () => ({
  listUpdates: async () => { fixture.calls.push({ fn: 'listUpdates', args: [] }); return []; },
}));
vi.mock('@/plugins/packages/marketplace-assets', () => {
  class AssetError extends Error { constructor(readonly status: number, message: string) { super(message); } }
  return {
    AssetError,
    fetchListingAsset: async (url: string) => {
      fixture.calls.push({ fn: 'fetchListingAsset', args: [url] });
      if (url.endsWith('.svg')) throw new AssetError(415, 'Not a PNG, JPEG, WebP or GIF image');
      return { type: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
    },
  };
});
vi.mock('@/plugins/packages/revocations', () => {
  class RevocationClearError extends Error {}
  return {
    RevocationClearError,
    listRevocations: async () => { fixture.calls.push({ fn: 'listRevocations', args: [] }); return []; },
    clearRevocation: async (...args: unknown[]) => {
      fixture.calls.push({ fn: 'clearRevocation', args });
      if (args[0] === '33333333-3333-4333-8333-333333333333') throw new RevocationClearError('a root key; its revocation cannot be cleared');
      return null;
    },
  };
});
vi.mock('@/plugins/packages/registry-install', () => ({
  installFromRegistry: async (...args: unknown[]) => { fixture.calls.push({ fn: 'installFromRegistry', args }); return { ...row, guidance: [], origin: { source: 'marketplace' } }; },
}));
vi.mock('@/db/repositories/plugin-usage-repository', () => ({
  pluginUsageRepository: {
    usage: async (...args: unknown[]) => { fixture.calls.push({ fn: 'usage', args }); return { modelCalls: 1, runs: 0, inputTokens: 1, outputTokens: 1, cost: 0, byUser: [{ userId: 'u' }] }; },
  },
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
  ['GET', '/bundled'],
  ['POST', '/', { path: '/opt/plugins/demo' }],
  ['POST', '/', { bundled: 'reader' }],
  ['POST', '/', { url: 'https://plugins.example.com/demo.tar.gz', sha256: SHA }],
  ['PATCH', '/demo', { approveContent: SHA }],
  ['PUT', '/demo/secrets/TOKEN', { value: 'x' }],
  ['DELETE', '/demo'],
  ['GET', '/marketplace'],
  ['GET', '/marketplace/asset?url=https%3A%2F%2Fmp.example.com%2Fdemo%2Ficon.png'],
  ['GET', '/updates'],
  ['GET', '/revocations'],
  ['DELETE', '/revocations/11111111-1111-4111-8111-111111111111', { reason: 'mistake' }],
  ['DELETE', '/pins', { registry: 'acme', name: 'demo', version: '1.0.0', reason: 'republished' }],
  ['GET', '/demo/usage'],
  ['POST', '/', { registry: 'marketplace', name: 'demo' }],
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
    const res = await call('POST', '/', { url: 'https://plugins.example.com/demo.tar.gz', sha256: SHA, name: 'demo', version: '1.0.0', allowSignerChange: true });
    expect([res.status, res.body.signedBy]).toEqual([200, 'Acme']);
    expect((await call('GET', '/registry')).body).toEqual({ packages: [], errors: [] });
    expect(fixture.calls).toEqual([
      { fn: 'installFromDirectory', args: ['/opt/plugins/demo', ADMIN.id, { upgrade: true, expect: { name: undefined, version: undefined } }] },
      { fn: 'installFromUrl', args: ['https://plugins.example.com/demo.tar.gz', ADMIN.id, { upgrade: false, allowSignerChange: true, sha256: SHA, name: 'demo', version: '1.0.0' }] },
      { fn: 'listRegistry', args: [] },
    ]);
  });

  test('an admin lists and installs the bundled plugins', async () => {
    fixture.user = ADMIN;
    expect((await call('GET', '/bundled')).body).toEqual([{ name: 'reader', installed: null }]);
    expect((await call('POST', '/', { bundled: 'reader' })).status).toBe(200);
    expect((await call('POST', '/', { bundled: 'reader', upgrade: true })).status).toBe(200);
    expect((await call('POST', '/', { bundled: '../etc' })).status).toBe(422);
    expect((await call('POST', '/', { bundled: 'reader', path: '/opt/x' })).status).toBe(400);
    expect(fixture.calls).toEqual([
      { fn: 'listBundled', args: [] },
      { fn: 'installBundled', args: ['reader', ADMIN.id, { upgrade: false }] },
      { fn: 'installBundled', args: ['reader', ADMIN.id, { upgrade: true }] },
    ]);
  });

  test('a PATCH hands the host API scopes the admin approves to the service', async () => {
    fixture.user = ADMIN;
    expect((await call('PATCH', '/demo', { enabled: true, approveHostScopes: ['web:read', 'tasks:write'] })).status).toBe(200);
    expect(fixture.calls).toEqual([{ fn: 'configure', args: ['demo', {
      settings: undefined, enabled: true, approveContent: undefined, approveInProcess: undefined, approveHostScopes: ['web:read', 'tasks:write'],
    }, ADMIN.id] }]);
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

  test('the marketplace takes q and category; a registry install names the package', async () => {
    fixture.user = ADMIN;
    expect((await call('GET', '/marketplace?q=caf%C3%A9&category=productivity')).status).toBe(200);
    expect((await call('POST', '/', { registry: 'marketplace' })).status).toBe(400);
    const res = await call('POST', '/', { registry: 'marketplace', name: 'demo', allowSourceChange: true });
    expect([res.status, res.body.guidance, res.body.origin]).toEqual([200, [], { source: 'marketplace' }]);
    expect(fixture.calls).toEqual([
      { fn: 'marketplaceListing', args: [{ q: 'café', category: 'productivity' }] },
      { fn: 'installFromRegistry', args: [ADMIN.id, { registry: 'marketplace', name: 'demo', version: undefined, upgrade: false, allowSignerChange: false, allowDowngrade: false, allowSourceChange: true, allowIncompatible: false }] },
    ]);
  });

  test('an image is served with its sniffed type, nosniff, a CSP that runs nothing and inline disposition; a refusal keeps its status', async () => {
    fixture.user = ADMIN;
    const res = await app.handle(new Request('http://localhost/api/plugin-packages/marketplace/asset?url=https%3A%2F%2Fmp.example.com%2Fdemo%2Ficon.png'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect((await call('GET', '/marketplace/asset?url=https%3A%2F%2Fmp.example.com%2Fdemo%2Fx.svg')).status).toBe(415);
    expect((await call('GET', '/marketplace/asset?url=http%3A%2F%2Fmp.example.com%2Fx.png')).status).toBe(422);
  });

  test('a pin is reset with a reason, by registry name; the revocation of a root key is never cleared', async () => {
    fixture.user = ADMIN;
    expect((await call('DELETE', '/pins', { registry: 'acme', name: 'demo', version: '1.0.0' })).status).toBe(422);
    const res = await call('DELETE', '/pins', { registry: 'acme', name: 'demo', version: '1.0.0', reason: 'republished on purpose' });
    expect([res.status, res.body.reset]).toEqual([200, true]);
    expect((await call('DELETE', '/pins', { registry: 'acme', name: 'demo', version: '2.0.0', reason: 'republished' })).status).toBe(404);
    expect((await call('DELETE', '/pins', { registry: 'nope', name: 'demo', version: '1.0.0', reason: 'republished' })).status).toBe(404);
    expect(fixture.calls.filter((c) => c.fn === 'resetPin')).toEqual([
      { fn: 'resetPin', args: ['https://acme.example.com/index.json', 'demo', '1.0.0', ADMIN.id, 'republished on purpose'] },
      { fn: 'resetPin', args: ['https://acme.example.com/index.json', 'demo', '2.0.0', ADMIN.id, 'republished'] },
    ]);
    const refused = await call('DELETE', '/revocations/33333333-3333-4333-8333-333333333333', { reason: 'oops' });
    expect([refused.status, refused.body.error]).toEqual([409, expect.stringMatching(/root key/)]);
  });

  test('usage: the admin view covers every user; a member gets only their own', async () => {
    fixture.user = ADMIN;
    const all = await call('GET', '/demo/usage?days=7');
    expect([all.status, all.body.scope, all.body.byUser]).toEqual([200, 'all', [{ userId: 'u' }]]);
    fixture.user = MEMBER;
    expect((await call('GET', '/demo/usage')).status).toBe(403);
    const mine = await call('GET', '/demo/usage/me');
    expect([mine.status, mine.body.scope, mine.body.byUser]).toEqual([200, 'me', undefined]);
    fixture.user = null;
    expect((await call('GET', '/demo/usage/me')).status).toBe(401);
    expect(fixture.calls.map((c) => [c.fn, c.args[0], c.args[2]])).toEqual([['usage', 'demo', undefined], ['usage', 'demo', MEMBER.id]]);
  });
});
