/**
 * The per-user plugin store end to end (docs/PLUGIN-PACKAGES.md#store): the
 * host API through a real egress proxy to a real HTTP listener, the page
 * routes as the signed-in user, and the rows.
 *
 * What must hold:
 * - user A can never read, list or overwrite user B's entries, and a
 *   package never sees another package's;
 * - the quota per user holds, also under concurrent writes; compare-and-set;
 * - a read tool's token carries store:read only and cannot write;
 * - reading an entry raises the call's read level to the entry's (so a notes
 *   write after it is refused), an entry above maxProtection is refused, and
 *   what is written carries the call's level;
 * - uninstalling the package, deleting the user and "Delete my data" remove
 *   exactly the rows they should;
 * - the page routes: the user's own entries, the scopes the package was
 *   granted, the API token's scope, the origin check.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { RunningServer } from '@/api/http';
import type { AgentContext } from '@/core/types';
import type { MCPServer } from '@/shared/mcp-server';
import type { PluginHostScope } from '@/shared/plugin-package';
import { generateSigningKey, signPackage } from './signature';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';
process.env.WORKSPACE_PATH ??= mkdtempSync(join(tmpdir(), 'octipus-store-ws-'));

const ALICE = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', isAdmin: false };
const BOB = { id: '22222222-2222-4222-8222-222222222222', username: 'bob', isAdmin: false };
const ADMIN = { id: '33333333-3333-4333-8333-333333333333', username: 'admin', isAdmin: true };

const fixture = vi.hoisted(() => ({
  user: null as null | { id: string; username: string; isAdmin: boolean },
  /** An API token's scopes for the signed-in user (undefined: a browser session, every scope). */
  scopes: undefined as undefined | string[],
  /** The shared space the request is made in (null: the user's personal workspace). */
  space: null as null | string,
}));
vi.mock('@/api/context', async () => {
  const { principalFromUser } = await import('@/security/principal');
  return {
    apiContext: new (await import('@/api/http')).App().derive(() => ({
      user: fixture.user,
      principal: fixture.user ? {
        ...principalFromUser(fixture.user), ...(fixture.scopes ? { scopes: fixture.scopes } : {}),
        ...(fixture.space ? { workspaceId: fixture.space, workspaceKind: 'shared', spaceRole: 'editor' } : {}),
      } : { kind: 'anonymous' },
    })),
  };
});

const PAGES = { pages: [{ path: 'main', title: 'Main', entry: 'index.html' }] };
const TOOLS = { save: { effect: 'write' }, load: { effect: 'read' } };
const manifest = (name: string, over: Record<string, unknown>) => ({
  name, version: '1.0.0', apiVersion: '1.0.0', title: name, description: name, server: { command: 'node', args: ['server.mjs'] }, tools: TOOLS, ...over,
});
/** The packages, as installed rows: [manifest, enabled, approved scopes]. */
const PACKAGES: Record<string, [Record<string, unknown>, boolean, string[]]> = {
  // Pages and a small quota: the page routes and the quota.
  notebook: [manifest('notebook', { host: ['store:read', 'store:write'], store: { quotaBytes: 4096 }, ui: PAGES }), true, ['store:read', 'store:write']],
  other: [manifest('other', { host: ['store:read', 'store:write'], store: {} }), true, ['store:read', 'store:write']],
  // No pages, maxProtection 2, and notes:write: the protection levels.
  vault: [manifest('vault', { host: ['store:read', 'store:write', 'notes:write'], store: {}, maxProtection: 2 }), true, ['store:read', 'store:write', 'notes:write']],
  // A page that may only read its store.
  peek: [manifest('peek', { host: ['store:read'], store: {}, ui: PAGES }), true, ['store:read']],
  // A page without a store.
  plain: [manifest('plain', { ui: PAGES }), true, []],
  // Declares the store, but the admin approved nothing.
  unapproved: [manifest('unapproved', { host: ['store:read', 'store:write'], store: {}, ui: PAGES }), true, []],
  // Pages and a store, signed by a key revoked later: its pages and store stop with it.
  signed: [manifest('signed', { host: ['store:read', 'store:write'], store: {}, ui: PAGES }), true, ['store:read', 'store:write']],
  // maxProtection 3 and web:read declared, not approved yet (disabled): approving it lowers what it may see to 1.
  clamp: [manifest('clamp', { host: ['store:read', 'store:write', 'web:read'], store: {}, maxProtection: 3 }), false, ['store:read', 'store:write']],
};
/** The key `signed` is signed by. */
const SIGNER = generateSigningKey();

let server: RunningServer;
let app: import('@/api/http').App;
const proxies = new Map<string, import('@/security/egress-proxy').EgressProxy>();

function token(plugin: string, userId: string, scopes: PluginHostScope[] = ['store:read', 'store:write'], maxProtection: 1 | 2 | 3 | 4 = 1): string {
  return mintToken({ plugin, userId, workspaceId: null, sessionId: null, scopes, maxProtection, tool: 'save', effect: 'write' });
}
let mintToken: (grant: Parameters<typeof import('./host-api').mintHostToken>[0]) => string;

/** A host API request through `plugin`'s egress proxy, as a package sends it. */
async function host(method: string, path: string, tok: string, plugin: string, body?: unknown): Promise<{ status: number; body: any }> {
  const { startEgressProxy } = await import('@/security/egress-proxy');
  let proxy = proxies.get(plugin);
  if (!proxy) {
    proxy = await startEgressProxy({ label: plugin, allowed: [], hostApi: { host: '127.0.0.1', port: server.port } });
    proxies.set(plugin, proxy);
  }
  const { request } = await import('node:http');
  const port = proxy.port;
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port, path: `http://octipus-host.internal/api/plugin-host${path}`, method,
      headers: { authorization: `Bearer ${tok}`, ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let parsed: unknown = null; try { parsed = JSON.parse(data); } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, body: parsed }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** A request to the app's own routes as the signed-in `fixture.user`. */
async function route(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

/** The store of `pkg` for `userId` (Alice by default) in their personal workspace. */
const scopeOf = (pkg: string, userId = ALICE.id) => ({ pkg, userId, workspaceId: null });

async function rows(where = 'TRUE'): Promise<Array<{ package_name: string; user_id: string; key: string; value: unknown; protection_level: number; version: number }>> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(`SELECT package_name, user_id, key, value, protection_level, version FROM plugin_store WHERE ${where} ORDER BY package_name, user_id, key`)).rows;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-store-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  for (const u of [ALICE, BOB, ADMIN]) {
    await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${u.id}', '${u.username}', ${u.isAdmin}) ON CONFLICT DO NOTHING`);
  }
  const { getDb } = await import('@/db/postgres');
  const { pluginPackages } = await import('@/db/schema/plugin-packages');
  const { getConfig } = await import('@/config');
  getConfig().workspace.rootPath = process.env.WORKSPACE_PATH as string;
  const { packageDir } = await import('./service');
  for (const [name, [m, enabled, approved]] of Object.entries(PACKAGES)) {
    await getDb().insert(pluginPackages).values({ name, version: '1.0.0', manifest: m as never, enabled, approvedHostScopes: approved as never });
    // Real files: a page and its store are served only while the package may start (its content checked).
    const dir = packageDir(name);
    mkdirSync(join(dir, 'ui'), { recursive: true });
    writeFileSync(join(dir, 'octipus-plugin.json'), JSON.stringify(m));
    writeFileSync(join(dir, 'server.mjs'), '// not started in this test\n');
    writeFileSync(join(dir, 'ui', 'index.html'), `<!doctype html><title>${name}</title>`);
    if (name === 'signed') await signPackage(dir, SIGNER.privateKeyPem);
  }
  // Approved as installed: the content hash (and signature) pinned, as the first check before a start does.
  const { checkPackageBeforeStart } = await import('./service');
  for (const name of Object.keys(PACKAGES)) expect(await checkPackageBeforeStart(name)).toBeNull();
  const { App, listen } = await import('@/api/http');
  const { pluginHostRoutes } = await import('@/api/routes/plugin-host');
  const { pluginCallRoutes } = await import('@/api/routes/plugin-ui');
  const { pluginPackageRoutes } = await import('@/api/routes/plugin-packages');
  app = new App({ prefix: '/api' }).use(pluginCallRoutes).use(pluginHostRoutes).use(pluginPackageRoutes);
  server = listen(app, { hostname: '127.0.0.1', port: 0 });
  await new Promise((r) => setTimeout(r, 50));
  const hostApi = await import('./host-api');
  hostApi.setHostApiPort(server.port);
  mintToken = (grant) => hostApi.mintHostToken(grant, 30_000).token;
});

beforeEach(async () => {
  const { _resetRateLimits } = await import('@/core/artifacts/rate-limit');
  _resetRateLimits();
  fixture.user = null;
  fixture.scopes = undefined;
  fixture.space = null;
  (await import('./run-check')).forgetRunChecks();
});

afterAll(async () => {
  for (const proxy of proxies.values()) await proxy.close();
  server?.stop(true);
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('one user\'s entries are theirs alone', () => {
  test('user A can never read, list or overwrite user B\'s entries', async () => {
    const a = token('other', ALICE.id);
    const b = token('other', BOB.id);
    expect(await host('PUT', '/store/prefs/theme', a, 'other', { value: { theme: 'dark' } })).toEqual({ status: 200, body: { version: 1 } });
    expect(await host('GET', '/store/prefs/theme', a, 'other')).toEqual({ status: 200, body: { value: { theme: 'dark' }, version: 1 } });
    // Bob, same package, same key: nothing there for him.
    expect(await host('GET', '/store/prefs/theme', b, 'other')).toMatchObject({ status: 404, body: { code: 'not_found' } });
    expect(await host('GET', '/store', b, 'other')).toEqual({ status: 200, body: { keys: [], truncated: false } });
    expect(await host('DELETE', '/store/prefs/theme', b, 'other')).toMatchObject({ status: 404 });
    // His write makes his own entry; Alice's is untouched.
    expect(await host('PUT', '/store/prefs/theme', b, 'other', { value: 'light', ifVersion: 0 })).toEqual({ status: 200, body: { version: 1 } });
    expect(await host('GET', '/store/prefs/theme', a, 'other')).toEqual({ status: 200, body: { value: { theme: 'dark' }, version: 1 } });
    const listed = await host('GET', '/store?prefix=prefs/', a, 'other');
    expect(listed.body.keys).toEqual([{ key: 'prefs/theme', size: expect.any(Number), version: 1, updatedAt: expect.any(String) }]);
    expect((await rows(`package_name = 'other'`)).map((r) => [r.user_id, r.value])).toEqual([[ALICE.id, { theme: 'dark' }], [BOB.id, 'light']].sort());
  });

  test('there is no way to name another user', async () => {
    const a = token('other', ALICE.id);
    // A user in the body or the query is not a field the store reads: the write is Alice's.
    expect(await host('PUT', '/store/x', a, 'other', { value: 1, userId: BOB.id })).toMatchObject({ status: 200 });
    expect((await rows(`key = 'x'`)).map((r) => r.user_id)).toEqual([ALICE.id]);
    expect(await host('GET', `/store/x?userId=${BOB.id}`, token('other', BOB.id), 'other')).toMatchObject({ status: 404 });
    expect((await rows(`user_id = '${BOB.id}' AND key = 'x'`))).toEqual([]);
  });

  test('package X never sees package Y\'s entries, and Y\'s token is useless through X\'s proxy', async () => {
    const y = token('other', ALICE.id);
    const x = token('vault', ALICE.id, ['store:read', 'store:write'], 2);
    expect(await host('GET', '/store/prefs/theme', x, 'vault')).toMatchObject({ status: 404 });
    expect((await host('GET', '/store', x, 'vault')).body.keys).toEqual([]);
    expect(await host('GET', '/store/prefs/theme', y, 'vault')).toMatchObject({ status: 401, body: { code: 'invalid_token' } });
  });

  test('a token without the scope, or a key that is not a key, is refused', async () => {
    const readOnly = token('other', ALICE.id, ['store:read']);
    expect(await host('PUT', '/store/y', readOnly, 'other', { value: 1 })).toMatchObject({ status: 403, body: { code: 'scope_missing' } });
    expect(await host('DELETE', '/store/prefs/theme', readOnly, 'other')).toMatchObject({ status: 403, body: { code: 'scope_missing' } });
    const none = token('other', ALICE.id, ['notify']);
    expect(await host('GET', '/store/prefs/theme', none, 'other')).toMatchObject({ status: 403, body: { code: 'scope_missing' } });
    const a = token('other', ALICE.id);
    expect(await host('PUT', '/store/a@b', a, 'other', { value: 1 })).toMatchObject({ status: 400, body: { code: 'invalid_key' } });
    expect(await host('PUT', '/store/no%20space', a, 'other', { value: 1 })).toMatchObject({ status: 403 });
    expect(await host('PUT', '/store/z', a, 'other', {})).toMatchObject({ status: 400, body: { code: 'invalid_value' } });
    expect(await host('PUT', '/store/z', a, 'other', { value: 'x'.repeat(70_000) })).toMatchObject({ status: 413, body: { code: 'too_large' } });
  });
});

describe('quota and compare-and-set', () => {
  test('a user\'s entries stay within the quota; shrinking and deleting free room; another user has their own', async () => {
    const a = token('notebook', ALICE.id);
    const big = 'x'.repeat(1500);
    expect((await host('PUT', '/store/q1', a, 'notebook', { value: big })).status).toBe(200);
    expect((await host('PUT', '/store/q2', a, 'notebook', { value: big })).status).toBe(200);
    expect(await host('PUT', '/store/q3', a, 'notebook', { value: big })).toMatchObject({ status: 413, body: { code: 'quota' } });
    // Bob's quota is his own.
    expect((await host('PUT', '/store/q3', token('notebook', BOB.id), 'notebook', { value: big })).status).toBe(200);
    expect((await host('PUT', '/store/q1', a, 'notebook', { value: 'small' })).status).toBe(200);
    expect((await host('PUT', '/store/q3', a, 'notebook', { value: big })).status).toBe(200);
    expect((await host('DELETE', '/store/q2', a, 'notebook')).body).toEqual({ deleted: true });
    expect((await host('DELETE', '/store/q3', a, 'notebook')).status).toBe(200);
    expect((await host('DELETE', '/store/q1', a, 'notebook')).status).toBe(200);
  });

  test('concurrent writes cannot together pass the quota', async () => {
    const { pluginStoreRepository } = await import('@/db/repositories/plugin-store-repository');
    // 128 bytes of overhead, the key and 852 bytes of JSON: four fit in 4096 bytes, five do not.
    const json = JSON.stringify('y'.repeat(850));
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      pluginStoreRepository.put(scopeOf('notebook'), `c${i}`, json, { protectionLevel: 1, maxProtection: 4, quotaBytes: 4096 })));
    expect(results.filter((r) => r.ok)).toHaveLength(4);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === 'quota')).toBe(true);
    const usage = await pluginStoreRepository.usage('notebook', ALICE.id);
    expect(usage.bytes).toBeLessThanOrEqual(4096);
    await pluginStoreRepository.deleteUser('notebook', ALICE.id);
  });

  test('compare-and-set: 0 creates only, a version replaces only that version', async () => {
    const a = token('other', ALICE.id);
    expect(await host('PUT', '/store/cas', a, 'other', { value: 1, ifVersion: 0 })).toEqual({ status: 200, body: { version: 1 } });
    expect(await host('PUT', '/store/cas', a, 'other', { value: 2, ifVersion: 0 })).toMatchObject({ status: 409, body: { code: 'version_conflict', current: 1 } });
    expect(await host('PUT', '/store/cas', a, 'other', { value: 2, ifVersion: 1 })).toEqual({ status: 200, body: { version: 2 } });
    expect(await host('PUT', '/store/cas', a, 'other', { value: 3, ifVersion: 1 })).toMatchObject({ status: 409, body: { current: 2 } });
    expect(await host('PUT', '/store/cas', a, 'other', { value: 3 })).toEqual({ status: 200, body: { version: 3 } });
    expect(await host('GET', '/store/cas', a, 'other')).toEqual({ status: 200, body: { value: 3, version: 3 } });
    expect(await host('PUT', '/store/missing', a, 'other', { value: 1, ifVersion: 4 })).toMatchObject({ status: 409, body: { current: 0 } });
  });
});

describe('effects', () => {
  test('a read tool\'s call carries store:read only and can never write', async () => {
    const { issueHostCallMeta } = await import('./host-api');
    const srv = {
      id: 'plugin-other', name: 'other', command: 'node', isEnabled: true,
      plugin: { package: 'other', version: '1.0.0', tools: { save: 'write', load: 'read' }, descriptions: {}, maxProtection: 1, hostScopes: ['store:read', 'store:write'] },
    } as unknown as MCPServer;
    const context = { id: 'a', userId: ALICE.id, sessionId: 'sess-1', trigger: 'user', metadata: {}, workspaceId: null, space: null } as unknown as AgentContext;
    const read = await issueHostCallMeta(srv, 'load', context);
    const meta = read?.meta['octipus/host'] as { token: string; scopes: string[] };
    expect(meta.scopes).toEqual(['store:read']);
    expect((await host('GET', '/store/cas', meta.token, 'other')).status).toBe(200);
    expect(await host('PUT', '/store/cas', meta.token, 'other', { value: 'from a read tool' })).toMatchObject({ status: 403, body: { code: 'scope_missing' } });
    expect(await host('DELETE', '/store/cas', meta.token, 'other')).toMatchObject({ status: 403, body: { code: 'scope_missing' } });
    read?.release();
    const write = await issueHostCallMeta(srv, 'save', context);
    expect((write?.meta['octipus/host'] as { scopes: string[] }).scopes).toEqual(['store:read', 'store:write']);
    write?.release();
  });
});

describe('protection levels', () => {
  test('reading an entry raises the call to its level, so a notes write after it is refused; above maxProtection it is refused', async () => {
    const { pluginStoreRepository } = await import('@/db/repositories/plugin-store-repository');
    const { readLevelOf, resetReadLevels } = await import('./read-level');
    await resetReadLevels('vault');
    await pluginStoreRepository.put(scopeOf('vault'), 'secret/l2', JSON.stringify('level two'), { protectionLevel: 2, maxProtection: 4, quotaBytes: 1 << 20 });
    await pluginStoreRepository.put(scopeOf('vault'), 'secret/l3', JSON.stringify('level three'), { protectionLevel: 3, maxProtection: 4, quotaBytes: 1 << 20 });
    const scopes: PluginHostScope[] = ['store:read', 'store:write', 'notes:write'];
    // Before reading anything above 1, a note may be written.
    expect((await host('POST', '/notes', token('vault', ALICE.id, scopes, 2), 'vault', { title: 'Before' })).status).toBe(200);
    // Above maxProtection (2): not there for this package, and left out of a list (a key can carry data too).
    expect(await host('GET', '/store/secret/l3', token('vault', ALICE.id, scopes, 2), 'vault')).toMatchObject({ status: 404, body: { code: 'not_found' } });
    const listed = await host('GET', '/store?prefix=secret/', token('vault', ALICE.id, scopes, 2), 'vault');
    expect(listed.body).toEqual({ keys: [expect.objectContaining({ key: 'secret/l2' })], truncated: false });
    expect(await readLevelOf('vault', ALICE.id)).toBe(2);
    await resetReadLevels('vault');
    // Reading the level-2 entry raises what the package has read for Alice...
    expect(await host('GET', '/store/secret/l2', token('vault', ALICE.id, scopes, 2), 'vault')).toEqual({ status: 200, body: { value: 'level two', version: 1 } });
    expect(await readLevelOf('vault', ALICE.id)).toBe(2);
    // ...so a note (no protection level) is refused, in this call or a later one,
    expect(await host('POST', '/notes', token('vault', ALICE.id, scopes, 2), 'vault', { title: 'Laundered' })).toMatchObject({ status: 403, body: { code: 'read_level' } });
    // and what it writes to the store now is kept at level 2.
    expect((await host('PUT', '/store/copy', token('vault', ALICE.id, scopes, 2), 'vault', { value: 'level two' })).status).toBe(200);
    expect((await rows(`package_name = 'vault' AND key = 'copy'`))[0].protection_level).toBe(2);
    // Bob's calls start from his own level.
    expect(await readLevelOf('vault', BOB.id)).toBe(1);
    const { queryRaw } = await import('@/db/postgres');
    const notes = await queryRaw(`SELECT title FROM notes WHERE user_id = '${ALICE.id}'`);
    expect(notes.rows.map((r: { title: string }) => r.title)).toEqual(['Before']);
  });
});

describe('the audit', () => {
  test('store requests are audited in aggregate: one row per kind and minute, with a count', async () => {
    const { _resetStoreAudit } = await import('@/api/routes/plugin-host');
    _resetStoreAudit();
    const { queryRaw } = await import('@/db/postgres');
    const before = (await queryRaw(`SELECT count(*)::int AS n FROM audit_log WHERE resource_type = 'plugin_host' AND details->>'op' = 'store.put'`)).rows[0].n;
    const a = token('other', ALICE.id);
    for (let i = 0; i < 5; i++) expect((await host('PUT', `/store/audit/${i}`, a, 'other', { value: i })).status).toBe(200);
    const { rows: audited } = await queryRaw(`SELECT details FROM audit_log WHERE resource_type = 'plugin_host' AND details->>'op' = 'store.put' ORDER BY created_at`);
    expect(audited.length - before).toBe(1);
    const last = audited.at(-1).details;
    expect(typeof last === 'string' ? JSON.parse(last) : last).toMatchObject({ op: 'store.put', status: 200, aggregated: true, count: 1, scope: 'store:write' });
    expect(JSON.stringify(audited)).not.toContain('audit/');
  });
});

describe('the page routes', () => {
  test('the signed-in user\'s own entries of that package, through the bridge\'s routes', async () => {
    fixture.user = ALICE;
    expect(await route('PUT', '/api/plugins/notebook/store/page/state', { value: { tab: 2 } })).toEqual({ status: 200, body: { version: 1 } });
    expect(await route('GET', '/api/plugins/notebook/store/page/state')).toEqual({ status: 200, body: { value: { tab: 2 }, version: 1 } });
    expect((await route('GET', '/api/plugins/notebook/store?prefix=page/')).body.keys.map((k: { key: string }) => k.key)).toEqual(['page/state']);
    expect(await route('PUT', '/api/plugins/notebook/store/page/state', { value: { tab: 3 }, ifVersion: 0 })).toMatchObject({ status: 409, body: { current: 1 } });
    // The same key is Alice's to the package's own tools too.
    expect(await host('GET', '/store/page/state', token('notebook', ALICE.id), 'notebook')).toEqual({ status: 200, body: { value: { tab: 2 }, version: 1 } });
    fixture.user = BOB;
    expect(await route('GET', '/api/plugins/notebook/store/page/state')).toMatchObject({ status: 404 });
    expect((await route('GET', '/api/plugins/notebook/store?prefix=page/')).body.keys).toEqual([]);
    // Another package's page never reaches it either.
    fixture.user = ALICE;
    expect(await route('GET', '/api/plugins/peek/store/page/state')).toMatchObject({ status: 404 });
    expect(await route('DELETE', '/api/plugins/notebook/store/page/state')).toEqual({ status: 200, body: { deleted: true } });
    // Written at the page's level: 1.
    expect(await route('PUT', '/api/plugins/notebook/store/page/level', { value: 1 })).toMatchObject({ status: 200 });
    expect((await rows(`package_name = 'notebook' AND key = 'page/level'`))[0]).toMatchObject({ user_id: ALICE.id, protection_level: 1 });
  });

  test('only with the scope the package was granted, a signed-in user, an API token\'s scope, and from this site', async () => {
    fixture.user = null;
    expect((await route('GET', '/api/plugins/notebook/store')).status).toBe(401);
    fixture.user = ALICE;
    // Declares store:read only: reads, never writes.
    expect((await route('GET', '/api/plugins/peek/store')).status).toBe(200);
    expect(await route('PUT', '/api/plugins/peek/store/x', { value: 1 })).toMatchObject({ status: 403, body: { code: 'scope_missing' } });
    expect(await route('DELETE', '/api/plugins/peek/store/x')).toMatchObject({ status: 403, body: { code: 'scope_missing' } });
    // No store declared; declared but not approved; no pages; not installed.
    expect(await route('GET', '/api/plugins/plain/store')).toMatchObject({ status: 403, body: { code: 'scope_missing' } });
    expect(await route('PUT', '/api/plugins/unapproved/store/x', { value: 1 })).toMatchObject({ status: 403, body: { code: 'scope_missing' } });
    expect(await route('GET', '/api/plugins/other/store')).toMatchObject({ status: 404 });
    expect(await route('GET', '/api/plugins/nope/store')).toMatchObject({ status: 404 });
    // A cookie-signed write from another site is refused; a same-origin one is not.
    expect((await route('PUT', '/api/plugins/notebook/store/x', { value: 1 }, { origin: 'https://evil.example.com' })).status).toBe(403);
    expect((await route('PUT', '/api/plugins/notebook/store/x', { value: 1 }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await route('PUT', '/api/plugins/notebook/store/x', { value: 1 }, { origin: 'http://localhost' })).status).toBe(200);
    // An API token with api:read reads but does not write.
    fixture.scopes = ['api:read'];
    expect((await route('GET', '/api/plugins/notebook/store/x', undefined, { authorization: 'Bearer t' })).status).toBe(200);
    expect((await route('PUT', '/api/plugins/notebook/store/x', { value: 2 }, { authorization: 'Bearer t' })).status).toBe(403);
    fixture.scopes = ['api:write'];
    expect((await route('PUT', '/api/plugins/notebook/store/x', { value: 2 }, { authorization: 'Bearer t' })).status).toBe(200);
    // The package disabled: no page, no store.
    fixture.scopes = undefined;
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw(`UPDATE plugin_packages SET enabled = false WHERE name = 'notebook'`);
    try {
      expect((await route('GET', '/api/plugins/notebook/store/x')).status).toBe(404);
    } finally {
      await executeRaw(`UPDATE plugin_packages SET enabled = true WHERE name = 'notebook'`);
    }
  });
});

// ── Regression tests of the store's security review (docs/plans/marketplace.md: four hard boundaries) ──

/** Put a row as an earlier write would have left it (any level), bypassing the API. */
async function seed(pkg: string, userId: string, key: string, value: unknown, level: number): Promise<void> {
  const { queryRaw } = await import('@/db/postgres');
  await queryRaw(`INSERT INTO plugin_store (package_name, user_id, key, value, size_bytes, protection_level) VALUES ($1, $2, $3, $4::jsonb, 200, $5)`,
    [pkg, userId, key, JSON.stringify(value), level]);
}

const VAULT_SCOPES: PluginHostScope[] = ['store:read', 'store:write', 'notes:write'];

describe('review: a write follows the calling session\'s level (no laundering)', () => {
  test('a tool in a level-2 session stores at 2; a level-1 session reading it is raised, and its notes write is refused', async () => {
    const { raiseSessionLevel } = await import('@/core/protection/session-level');
    const { readLevelOf, resetReadLevels } = await import('./read-level');
    await resetReadLevels('vault');
    raiseSessionLevel('sess-hot', 2);
    const hot = mintToken({ plugin: 'vault', userId: ALICE.id, workspaceId: null, sessionId: 'sess-hot', scopes: VAULT_SCOPES, maxProtection: 2, tool: 'save', effect: 'write' });
    expect((await host('PUT', '/store/from-hot', hot, 'vault', { value: 'level-2 conversation text' })).status).toBe(200);
    expect((await rows(`key = 'from-hot'`))[0].protection_level).toBe(2);
    // The same session may not write a note either: it holds level-2 content.
    expect(await host('POST', '/notes', hot, 'vault', { title: 'From a level-2 session' })).toMatchObject({ status: 403, body: { code: 'read_level' } });
    await resetReadLevels('vault');
    const cold = mintToken({ plugin: 'vault', userId: ALICE.id, workspaceId: null, sessionId: 'sess-cold', scopes: VAULT_SCOPES, maxProtection: 2, tool: 'save', effect: 'write' });
    expect(await host('GET', '/store/from-hot', cold, 'vault')).toEqual({ status: 200, body: { value: 'level-2 conversation text', version: 1 } });
    expect(await readLevelOf('vault', ALICE.id)).toBe(2);
    expect(await host('POST', '/notes', cold, 'vault', { title: 'level-2 conversation text' })).toMatchObject({ status: 403, body: { code: 'read_level' } });
    const { queryRaw } = await import('@/db/postgres');
    expect((await queryRaw(`SELECT count(*)::int AS n FROM notes WHERE title LIKE '%level-2%'`)).rows[0].n).toBe(0);
    await resetReadLevels('vault');
  });
});

describe('review: nothing about an entry above maxProtection leaks, and what is told raises the caller', () => {
  test('a get, a write, a compare-and-set and a delete of an entry above the cap answer as for a missing key, and leave it as it was', async () => {
    const { resetReadLevels, readLevelOf } = await import('./read-level');
    await resetReadLevels('vault');
    await seed('vault', ALICE.id, 'hidden/l3', 'level three', 3);
    const tok = () => token('vault', ALICE.id, VAULT_SCOPES, 2);
    const missing = { status: 404, body: { error: 'No such key', code: 'not_found' } };
    expect(await host('GET', '/store/hidden/l3', tok(), 'vault')).toEqual(missing);
    expect(await host('GET', '/store/hidden/nothing', tok(), 'vault')).toEqual(missing);
    expect(await host('PUT', '/store/hidden/l3', tok(), 'vault', { value: 'x', ifVersion: 0 })).toEqual(missing);
    expect(await host('PUT', '/store/hidden/l3', tok(), 'vault', { value: 'x', ifVersion: 1 })).toEqual(missing);
    expect(await host('PUT', '/store/hidden/l3', tok(), 'vault', { value: 'overwritten' })).toEqual(missing);
    expect(await host('DELETE', '/store/hidden/l3', tok(), 'vault')).toEqual(missing);
    const listed = await host('GET', '/store?prefix=hidden/', tok(), 'vault');
    expect(listed).toEqual({ status: 200, body: { keys: [], truncated: false } });
    expect((await rows(`package_name = 'vault' AND key = 'hidden/l3'`))[0]).toMatchObject({ value: 'level three', version: 1, protection_level: 3 });
    // Nothing above was handed over: the package's level for Alice is untouched.
    expect(await readLevelOf('vault', ALICE.id)).toBe(1);
  });

  test('an overwrite never lowers an entry\'s level and raises the writer; a conflict and a delete raise the caller too', async () => {
    const { resetReadLevels, readLevelOf } = await import('./read-level');
    await seed('vault', ALICE.id, 'mid/over', 'level two', 2);
    await seed('vault', ALICE.id, 'mid/cas', 'level two', 2);
    await seed('vault', ALICE.id, 'mid/del', 'level two', 2);
    const tok = () => token('vault', ALICE.id, VAULT_SCOPES, 2);
    await resetReadLevels('vault');
    expect(await host('PUT', '/store/mid/over', tok(), 'vault', { value: 'written at level 1' })).toEqual({ status: 200, body: { version: 2 } });
    expect((await rows(`package_name = 'vault' AND key = 'mid/over'`))[0].protection_level).toBe(2);
    expect(await readLevelOf('vault', ALICE.id)).toBe(2);
    expect(await host('POST', '/notes', tok(), 'vault', { title: 'after an overwrite' })).toMatchObject({ status: 403, body: { code: 'read_level' } });
    await resetReadLevels('vault');
    expect(await host('PUT', '/store/mid/cas', tok(), 'vault', { value: 'x', ifVersion: 0 })).toMatchObject({ status: 409, body: { current: 1 } });
    expect(await readLevelOf('vault', ALICE.id)).toBe(2);
    await resetReadLevels('vault');
    expect(await host('DELETE', '/store/mid/del', tok(), 'vault')).toEqual({ status: 200, body: { deleted: true } });
    expect(await readLevelOf('vault', ALICE.id)).toBe(2);
    await resetReadLevels('vault');
  });

  test('a quota refusal says the quota, not what is used', async () => {
    const { pluginStoreRepository } = await import('@/db/repositories/plugin-store-repository');
    await pluginStoreRepository.deleteUser('notebook', BOB.id);
    const a = token('notebook', BOB.id);
    const big = 'x'.repeat(1500);
    expect((await host('PUT', '/store/qq1', a, 'notebook', { value: big })).status).toBe(200);
    expect((await host('PUT', '/store/qq2', a, 'notebook', { value: big })).status).toBe(200);
    const refused = await host('PUT', '/store/qq3', a, 'notebook', { value: big });
    expect(refused).toMatchObject({ status: 413, body: { code: 'quota' } });
    expect(refused.body.error).not.toMatch(/used/);
    for (const k of ['qq1', 'qq2']) await host('DELETE', `/store/${k}`, a, 'notebook');
  });

  test('approving an egress scope lowers maxProtection: the entries above it are deleted with the approval, audited with counts only', async () => {
    // (Nothing enabled while the approval syncs the servers: the rows have no real servers to start.)
    const { executeRaw } = await import('@/db/postgres');
    const enabled = Object.entries(PACKAGES).filter(([, [, on]]) => on).map(([n]) => n);
    await executeRaw('UPDATE plugin_packages SET enabled = false');
    onTestFinished(async () => {
      for (const n of enabled) await executeRaw(`UPDATE plugin_packages SET enabled = true WHERE name = '${n}'`);
    });
    await seed('clamp', ALICE.id, 'k1', 1, 1);
    await seed('clamp', ALICE.id, 'k2', 2, 2);
    await seed('clamp', BOB.id, 'k3', 3, 3);
    const { configure } = await import('./service');
    await configure('clamp', { approveHostScopes: ['store:read', 'store:write', 'web:read'] }, ADMIN.id);
    expect((await rows(`package_name = 'clamp'`)).map((r) => [r.key, r.protection_level])).toEqual([['k1', 1]]);
    const { queryRaw } = await import('@/db/postgres');
    const { rows: audited } = await queryRaw(`SELECT details FROM audit_log WHERE resource_type = 'plugin_package' AND resource_id = 'clamp' AND details->>'op' = 'store_deleted_above_max_protection'`);
    expect(audited).toHaveLength(1);
    const details = typeof audited[0].details === 'string' ? JSON.parse(audited[0].details) : audited[0].details;
    expect(details).toMatchObject({ maxProtection: 1, previous: 3, entries: 2, users: 2 });
    expect(JSON.stringify(details)).not.toMatch(/k2|k3/);
  });
});

describe('review: a revoked or unapproved package serves no page and no store', () => {
  test('content changed since it was approved: no store, no page, not listed', async () => {
    fixture.user = ALICE;
    expect((await route('GET', '/api/plugins/notebook/store')).status).toBe(200);
    const { listEnabledPages, readUiFile } = await import('./ui');
    expect((await listEnabledPages()).map((p) => p.plugin)).toContain('notebook');
    const { packageDir } = await import('./service');
    const file = join(packageDir('notebook'), 'ui', 'index.html');
    const before = readFileSync(file, 'utf8');
    writeFileSync(file, `${before}<!-- changed -->`);
    // The check is cached for 30 seconds; a file changed on disk is seen when it runs again.
    const { forgetRunChecks } = await import('./run-check');
    forgetRunChecks();
    try {
      expect(await route('GET', '/api/plugins/notebook/store')).toMatchObject({ status: 404, body: { error: 'No such plugin page' } });
      expect(await route('PUT', '/api/plugins/notebook/store/x', { value: 1 })).toMatchObject({ status: 404, body: { error: 'No such plugin page' } });
      expect((await readUiFile('notebook', 'index.html')).status).toBe(404);
      expect((await listEnabledPages()).map((p) => p.plugin)).not.toContain('notebook');
    } finally {
      writeFileSync(file, before);
      forgetRunChecks();
    }
    expect((await route('GET', '/api/plugins/notebook/store')).status).toBe(200);
  });

  test('signed by a key revoked since: no store, no page, not listed', async () => {
    fixture.user = ALICE;
    const { listEnabledPages, readUiFile } = await import('./ui');
    expect((await route('GET', '/api/plugins/signed/store')).status).toBe(200);
    expect((await readUiFile('signed', 'index.html')).status).toBe(200);
    expect((await listEnabledPages()).map((p) => p.plugin)).toContain('signed');
    const { getConfig } = await import('@/config');
    const { forgetRunChecks } = await import('./run-check');
    getConfig().plugins.revokedKeys = [SIGNER.keyId];
    forgetRunChecks();
    try {
      expect(await route('GET', '/api/plugins/signed/store')).toMatchObject({ status: 404, body: { error: 'No such plugin page' } });
      expect((await readUiFile('signed', 'index.html')).status).toBe(404);
      expect((await listEnabledPages()).map((p) => p.plugin)).not.toContain('signed');
    } finally {
      getConfig().plugins.revokedKeys = [];
      forgetRunChecks();
    }
  });
});

describe('review: the quota counts what is kept', () => {
  test('each entry costs 128 bytes on top of its key and its value as the database serialises it; the running total follows', async () => {
    const a = token('other', ALICE.id);
    expect((await host('PUT', '/store/tiny', a, 'other', { value: 1 })).status).toBe(200);
    expect((await rows(`package_name = 'other' AND user_id = '${ALICE.id}' AND key = 'tiny'`))).toHaveLength(1);
    const { queryRaw } = await import('@/db/postgres');
    const size = async (key: string) => (await queryRaw(`SELECT size_bytes FROM plugin_store WHERE package_name = 'other' AND user_id = $1 AND key = $2`, [ALICE.id, key])).rows[0].size_bytes;
    expect(await size('tiny')).toBe(128 + 'tiny'.length + 1);
    // 1e300 is "1e+300" in JSON, and 301 digits in the database: that is what counts.
    expect((await host('PUT', '/store/numbers', a, 'other', { value: Array(100).fill(1e300) })).status).toBe(200);
    expect(await size('numbers')).toBeGreaterThan(100 * 301);
    // Past 64 KB as the database keeps it: too large, however short the JSON sent.
    expect(await host('PUT', '/store/numbers2', a, 'other', { value: Array(300).fill(1e300) })).toMatchObject({ status: 413, body: { code: 'too_large' } });
    const totals = (await queryRaw(`SELECT bytes::int AS bytes, entries FROM plugin_store_usage WHERE package_name = 'other' AND user_id = $1 AND workspace_id IS NULL`, [ALICE.id])).rows[0];
    const actual = (await queryRaw(`SELECT sum(size_bytes)::int AS bytes, count(*)::int AS entries FROM plugin_store WHERE package_name = 'other' AND user_id = $1`, [ALICE.id])).rows[0];
    expect(totals).toEqual(actual);
    for (const k of ['tiny', 'numbers']) expect((await host('DELETE', `/store/${k}`, a, 'other')).status).toBe(200);
    const after = (await queryRaw(`SELECT bytes::int AS bytes, entries FROM plugin_store_usage WHERE package_name = 'other' AND user_id = $1 AND workspace_id IS NULL`, [ALICE.id])).rows[0];
    expect(after).toEqual((await queryRaw(`SELECT coalesce(sum(size_bytes), 0)::int AS bytes, count(*)::int AS entries FROM plugin_store WHERE package_name = 'other' AND user_id = $1`, [ALICE.id])).rows[0]);
  });

  test('a user keeps at most 10,000 entries per package: a new key beyond is refused (413 too_many_entries), an overwrite is not', async () => {
    const { pluginStoreRepository } = await import('@/db/repositories/plugin-store-repository');
    await pluginStoreRepository.deleteUser('other', BOB.id);
    const { queryRaw } = await import('@/db/postgres');
    await queryRaw(`INSERT INTO plugin_store (package_name, user_id, key, value, size_bytes) SELECT 'other', $1, 'many/' || i, '1'::jsonb, 140 FROM generate_series(1, 10000) AS i`, [BOB.id]);
    await queryRaw(`INSERT INTO plugin_store_usage (package_name, user_id, workspace_id, bytes, entries) VALUES ('other', $1, NULL, 1400000, 10000)`, [BOB.id]);
    const b = token('other', BOB.id);
    try {
      expect(await host('PUT', '/store/one-more', b, 'other', { value: 1 })).toMatchObject({ status: 413, body: { code: 'too_many_entries' } });
      expect((await host('PUT', '/store/many/1', b, 'other', { value: 2 })).status).toBe(200);
    } finally {
      await queryRaw(`DELETE FROM plugin_store WHERE package_name = 'other' AND user_id = $1 AND key LIKE 'many/%'`, [BOB.id]);
      await queryRaw(`DELETE FROM plugin_store_usage WHERE package_name = 'other' AND user_id = $1`, [BOB.id]);
    }
  });

  test('a value nested too deeply says so', async () => {
    fixture.user = ALICE;
    const raw = `{"value":${'['.repeat(5000)}${']'.repeat(5000)}}`;
    const res = await app.handle(new Request('http://localhost/api/plugins/notebook/store/deep', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: raw }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_value', error: 'The value is too deeply nested' });
  });
});

describe('review: page writes share the store\'s write limit', () => {
  test('after a burst of writes by the package\'s tools, the page\'s write is limited too', async () => {
    const a = token('notebook', ALICE.id);
    // Hold the limiter's clock still: under load the writes below take long
    // enough for the bucket (5 a second) to refill between the tools' last
    // write and the page's, which made this test depend on timing.
    const frozen = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(frozen);
    onTestFinished(() => clock.mockRestore());
    // 30 in a burst, 5 a second after that: write until the tools are limited.
    let status = 200;
    for (let i = 0; i < 100 && status === 200; i++) status = (await host('PUT', '/store/burst', a, 'notebook', { value: i })).status;
    expect(status).toBe(429);
    fixture.user = ALICE;
    expect(await route('PUT', '/api/plugins/notebook/store/burst', { value: 'from the page' })).toMatchObject({ status: 429, body: { code: 'rate_limited' } });
    // Reads are not writes.
    expect((await route('GET', '/api/plugins/notebook/store/burst')).status).toBe(200);
    const { _resetRateLimits } = await import('@/core/artifacts/rate-limit');
    _resetRateLimits();
    expect((await route('DELETE', '/api/plugins/notebook/store/burst')).status).toBe(200);
  });
});

describe('review: the store is per user and per workspace', () => {
  test('what a call keeps in a space is read in that space only; leaving the space deletes it; "Delete my data" can name a workspace', async () => {
    const { createSpace, removeMember } = await import('@/core/spaces/service');
    const space = await createSpace({ userId: ALICE.id }, { name: `Store ${rand(3)}` });
    const { queryRaw } = await import('@/db/postgres');
    await queryRaw(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'editor')`, [space.id, BOB.id]);
    const inSpace = (userId: string) => mintToken({ plugin: 'other', userId, workspaceId: space.id, sessionId: null, scopes: ['store:read', 'store:write'], maxProtection: 1, tool: 'save', effect: 'write' });
    const personal = (userId: string) => token('other', userId);
    expect((await host('PUT', '/store/ws/note', inSpace(ALICE.id), 'other', { value: 'in the space' })).status).toBe(200);
    expect((await host('PUT', '/store/ws/note', personal(ALICE.id), 'other', { value: 'personal' })).status).toBe(200);
    expect(await host('GET', '/store/ws/note', inSpace(ALICE.id), 'other')).toEqual({ status: 200, body: { value: 'in the space', version: 1 } });
    expect(await host('GET', '/store/ws/note', personal(ALICE.id), 'other')).toEqual({ status: 200, body: { value: 'personal', version: 1 } });
    expect((await host('GET', '/store?prefix=ws/', inSpace(ALICE.id), 'other')).body.keys.map((k: { key: string }) => k.key)).toEqual(['ws/note']);
    expect((await rows(`package_name = 'other' AND key = 'ws/note'`))).toHaveLength(2);
    // Another member of the space has their own entries there: never Alice's.
    expect(await host('GET', '/store/ws/note', inSpace(BOB.id), 'other')).toMatchObject({ status: 404 });
    expect((await host('PUT', '/store/ws/bob', inSpace(BOB.id), 'other', { value: 'bob in the space' })).status).toBe(200);
    expect((await host('PUT', '/store/ws/bob', personal(BOB.id), 'other', { value: 'bob personal' })).status).toBe(200);

    // The page, in the space and out of it.
    fixture.user = ALICE;
    fixture.space = space.id;
    expect(await route('PUT', '/api/plugins/notebook/store/ws/page', { value: 'page in the space' })).toEqual({ status: 200, body: { version: 1 } });
    expect(await route('GET', '/api/plugins/notebook/store/ws/page')).toEqual({ status: 200, body: { value: 'page in the space', version: 1 } });
    fixture.space = null;
    expect(await route('GET', '/api/plugins/notebook/store/ws/page')).toMatchObject({ status: 404 });

    // Bob leaves (is removed): his entries of that space go, his personal ones stay.
    await removeMember({ userId: ALICE.id }, space.id, BOB.id);
    const { rows: bobs } = await queryRaw(`SELECT key, workspace_id FROM plugin_store WHERE user_id = $1 AND key = 'ws/bob'`, [BOB.id]);
    expect(bobs).toEqual([{ key: 'ws/bob', workspace_id: null }]);
    const usage = (await queryRaw(`SELECT count(*)::int AS n FROM plugin_store_usage WHERE user_id = $1 AND workspace_id = $2`, [BOB.id, space.id])).rows[0].n;
    expect(usage).toBe(0);

    // "Delete my data" in one workspace only, then everywhere.
    const out = await route('DELETE', '/api/plugin-packages/other/store/me?workspace=personal');
    expect(out).toMatchObject({ status: 200, body: { name: 'other' } });
    expect((await rows(`package_name = 'other' AND user_id = '${ALICE.id}' AND key = 'ws/note'`)).map((r) => r.value)).toEqual(['in the space']);
    expect((await route('DELETE', `/api/plugin-packages/other/store/me?workspace=${space.id}`)).status).toBe(200);
    expect(await rows(`package_name = 'other' AND user_id = '${ALICE.id}' AND key = 'ws/note'`)).toEqual([]);
  });
});

describe('deleting', () => {
  test('"Delete my data" removes the user\'s entries of that package only, and is audited', async () => {
    const { pluginStoreRepository } = await import('@/db/repositories/plugin-store-repository');
    await pluginStoreRepository.put(scopeOf('notebook'), 'd1', '1', { protectionLevel: 1, maxProtection: 4, quotaBytes: 4096 });
    await pluginStoreRepository.put(scopeOf('notebook', BOB.id), 'd1', '1', { protectionLevel: 1, maxProtection: 4, quotaBytes: 4096 });
    await pluginStoreRepository.put(scopeOf('other'), 'd1', '1', { protectionLevel: 1, maxProtection: 4, quotaBytes: 4096 });
    fixture.user = ALICE;
    const usage = await route('GET', '/api/plugin-packages/my-usage');
    const mine = (usage.body as Array<{ name: string; store: { entries: number; bytes: number; quotaBytes: number } | null }>).find((p) => p.name === 'notebook');
    expect(mine?.store).toMatchObject({ entries: expect.any(Number), quotaBytes: 4096 });
    const entries = (await rows(`package_name = 'notebook' AND user_id = '${ALICE.id}'`)).length;
    expect(mine?.store?.entries).toBe(entries);
    const out = await route('DELETE', '/api/plugin-packages/notebook/store/me');
    expect(out).toMatchObject({ status: 200, body: { name: 'notebook', entries } });
    expect(await rows(`package_name = 'notebook' AND user_id = '${ALICE.id}'`)).toEqual([]);
    expect((await rows(`package_name = 'notebook' AND user_id = '${BOB.id}'`)).length).toBeGreaterThan(0);
    expect((await rows(`package_name = 'other' AND user_id = '${ALICE.id}'`)).length).toBeGreaterThan(0);
    const { queryRaw } = await import('@/db/postgres');
    const { rows: audited } = await queryRaw(`SELECT user_id, details FROM audit_log WHERE resource_type = 'plugin_package' AND resource_id = 'notebook' AND details->>'op' = 'store_deleted_by_user'`);
    expect(audited).toHaveLength(1);
    expect(audited[0].user_id).toBe(ALICE.id);
    // From another site, refused.
    expect((await route('DELETE', '/api/plugin-packages/notebook/store/me', undefined, { origin: 'https://evil.example.com' })).status).toBe(403);
    // The admin view sums every user's, by user, sizes only.
    fixture.user = ADMIN;
    const all = await route('GET', '/api/plugin-packages/notebook/usage');
    expect(all.body.store).toMatchObject({ quotaBytes: 4096, byUser: [expect.objectContaining({ userId: BOB.id })] });
    expect(JSON.stringify(all.body.store)).not.toContain('d1');
    fixture.user = BOB;
    expect((await route('GET', '/api/plugin-packages/notebook/usage')).status).toBe(403);
  });

  test('deleting a user deletes their entries; uninstalling a package deletes every user\'s', async () => {
    const { pluginStoreRepository } = await import('@/db/repositories/plugin-store-repository');
    await pluginStoreRepository.put(scopeOf('other', BOB.id), 'gone', '1', { protectionLevel: 1, maxProtection: 4, quotaBytes: 4096 });
    await pluginStoreRepository.put(scopeOf('vault', BOB.id), 'gone', '1', { protectionLevel: 1, maxProtection: 4, quotaBytes: 4096 });
    expect((await rows(`user_id = '${BOB.id}'`)).length).toBeGreaterThan(0);
    const { userRepository } = await import('@/db/repositories/user-repository');
    expect(await userRepository.delete(BOB.id)).toBe(true);
    expect(await rows(`user_id = '${BOB.id}'`)).toEqual([]);
    expect((await rows(`package_name = 'other'`)).length).toBeGreaterThan(0);
    // (Nothing enabled: the rows have no files, so syncing the servers after the uninstall starts none.)
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw('UPDATE plugin_packages SET enabled = false');
    const svc = await import('./service');
    await svc.uninstall('other', ADMIN.id);
    expect(await rows(`package_name = 'other'`)).toEqual([]);
    expect((await rows(`package_name = 'vault'`)).length).toBeGreaterThan(0);
  });
});
