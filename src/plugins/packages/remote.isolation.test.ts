/**
 * Remote install and registries end to end (docs/PLUGIN-PACKAGES.md#remote-install):
 * a tarball downloaded over https (the guarded fetch mocked) is checked
 * against its sha256, unpacked safely and installed only with a valid
 * signature by a trusted publisher, whatever plugins.requireSignature says;
 * revoked and expired keys are refused and shown; registries are merged.
 *
 * Backed by ephemeral PGlite; the fixture package runs as a real MCP server.
 */
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { entriesOfDir, makeTarGz } from '@/test-helpers/tar';
import { generateSigningKey, signPackage } from './signature';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';
process.env.WORKSPACE_PATH ??= mkdtempSync(join(tmpdir(), 'octipus-remote-ws-'));

const served = vi.hoisted(() => ({ files: new Map<string, Buffer | string>(), fetched: [] as string[] }));
vi.mock('@/utils/sanitize', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/sanitize')>(),
  fetchGuarded: async (url: string) => {
    served.fetched.push(url);
    const body = served.files.get(url);
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(typeof body === 'string' ? body : new Uint8Array(body));
  },
}));

const admin = '11111111-1111-4111-8111-111111111111';
const FIXTURE_DIR = join(__dirname, 'fixtures', 'echo-plugin');
const NAME = 'echo-plugin';
const SERVER = 'plugin-echo-plugin';
const acme = generateSigningKey();
const stranger = generateSigningKey();
const ACME = { name: 'Acme', publicKey: acme.publicKeyPem };

/** A tarball of the fixture (under `package/`, as npm pack writes it), signed with `key` when given; served at `url`. */
async function serveFixture(url: string, opts: { key?: string; version?: string } = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'octipus-remote-pkg-'));
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  if (opts.version) {
    const manifest = JSON.parse(readFileSync(join(dir, 'octipus-plugin.json'), 'utf8'));
    manifest.version = opts.version;
    writeFileSync(join(dir, 'octipus-plugin.json'), JSON.stringify(manifest));
  }
  if (opts.key) await signPackage(dir, opts.key);
  const tarball = makeTarGz(entriesOfDir(dir, 'package'));
  served.files.set(url, tarball);
  return `sha256:${createHash('sha256').update(tarball).digest('hex')}`;
}

async function policy(change: { requireSignature?: boolean; trusted?: Array<Record<string, unknown>>; revokedKeys?: string[]; registries?: Array<{ name: string; url: string }> }): Promise<void> {
  const { getConfig } = await import('@/config');
  const plugins = getConfig().plugins;
  if (change.requireSignature !== undefined) plugins.requireSignature = change.requireSignature;
  if (change.trusted !== undefined) plugins.trustedPublishers = change.trusted as typeof plugins.trustedPublishers;
  if (change.revokedKeys !== undefined) plugins.revokedKeys = change.revokedKeys;
  if (change.registries !== undefined) plugins.registries = change.registries;
}

async function auditOps(op: string): Promise<Array<Record<string, unknown>>> {
  const { queryRaw } = await import('@/db/postgres');
  const { rows } = await queryRaw(`SELECT details FROM audit_log WHERE resource_type = 'plugin_package' AND resource_id = '${NAME}' ORDER BY created_at`);
  return rows
    .map((r: { details: unknown }) => (typeof r.details === 'string' ? JSON.parse(r.details) : r.details) as Record<string, unknown>)
    .filter((d: Record<string, unknown>) => d.op === op);
}

/** Nothing of a refused install is left: no row, no files, no unpacked download. */
async function nothingLeft(): Promise<void> {
  const svc = await import('./service');
  expect(await svc.listPackages()).toEqual([]);
  expect(existsSync(svc.packageDir(NAME))).toBe(false);
  const downloads = join(process.env.WORKSPACE_PATH as string, 'plugin-downloads');
  expect(existsSync(downloads) ? readdirSync(downloads) : []).toEqual([]);
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-remote-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${admin}', 'admin', true) ON CONFLICT DO NOTHING`);
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();
  const { getConfig } = await import('@/config');
  getConfig().workspace.rootPath = process.env.WORKSPACE_PATH as string;
});

afterEach(async () => {
  const svc = await import('./service');
  const { clearRegistryCache } = await import('./remote');
  await policy({ requireSignature: false, trusted: [ACME], revokedKeys: [], registries: [] });
  clearRegistryCache();
  served.files.clear();
  served.fetched = [];
  if ((await svc.listPackages()).length > 0) await svc.uninstall(NAME, admin);
});

afterAll(async () => {
  const { getMCPBridge } = await import('@/mcp/bridge');
  await getMCPBridge().disconnect(SERVER);
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('remote install', () => {
  test('a tarball signed by a trusted publisher installs, disabled, with its source audited', async () => {
    const { installFromUrl } = await import('./remote');
    const svc = await import('./service');
    await policy({ trusted: [ACME] });
    const url = 'https://plugins.example.com/echo-1.0.0.tar.gz';
    const sha256 = await serveFixture(url, { key: acme.privateKeyPem });

    const row = await installFromUrl(url, admin, { sha256 });
    expect([row.name, row.enabled, row.signedBy, row.warnings]).toEqual([NAME, false, 'Acme', []]);
    expect(served.fetched).toEqual([url]);
    const view = await svc.packageView(NAME);
    expect(view.signature).toMatchObject({ status: 'valid', publisher: 'Acme', keyId: acme.keyId });
    expect((await auditOps('installed')).at(-1)).toMatchObject({ source: url, signedBy: 'Acme', keyId: acme.keyId });
    const downloads = join(process.env.WORKSPACE_PATH as string, 'plugin-downloads');
    expect(readdirSync(downloads)).toEqual([]);

    // An upgrade from a URL replaces it the same way.
    const next = 'https://plugins.example.com/echo-1.1.0.tar.gz';
    await serveFixture(next, { key: acme.privateKeyPem, version: '1.1.0' });
    expect((await installFromUrl(next, admin, { upgrade: true })).version).toBe('1.1.0');
  });

  test('unsigned or signed by an unknown key: refused even with requireSignature off', async () => {
    const { installFromUrl } = await import('./remote');
    await policy({ requireSignature: false, trusted: [ACME] });
    await serveFixture('https://plugins.example.com/unsigned.tgz');
    await expect(installFromUrl('https://plugins.example.com/unsigned.tgz', admin)).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/not signed.*from a URL/) });
    await nothingLeft();
    await serveFixture('https://plugins.example.com/stranger.tgz', { key: stranger.privateKeyPem });
    await expect(installFromUrl('https://plugins.example.com/stranger.tgz', admin)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining(stranger.keyId) });
    await nothingLeft();
  });

  test('a revoked or expired key is refused', async () => {
    const { installFromUrl } = await import('./remote');
    const url = 'https://plugins.example.com/echo.tgz';
    await serveFixture(url, { key: acme.privateKeyPem });
    await policy({ trusted: [{ ...ACME, revoked: true }] });
    await expect(installFromUrl(url, admin)).rejects.toMatchObject({ message: expect.stringMatching(/revoked key/) });
    await policy({ trusted: [ACME], revokedKeys: [acme.keyId] });
    await expect(installFromUrl(url, admin)).rejects.toMatchObject({ message: expect.stringMatching(/revoked key/) });
    await policy({ trusted: [{ ...ACME, notAfter: '2020-01-01' }], revokedKeys: [] });
    await expect(installFromUrl(url, admin)).rejects.toMatchObject({ message: expect.stringMatching(/expired key/) });
    await nothingLeft();
  });

  test('a sha256 mismatch is refused before anything is unpacked; a failed download is refused', async () => {
    const { installFromUrl } = await import('./remote');
    const url = 'https://plugins.example.com/echo.tgz';
    await serveFixture(url, { key: acme.privateKeyPem });
    await expect(installFromUrl(url, admin, { sha256: `sha256:${'0'.repeat(64)}` })).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/hashes to sha256:[0-9a-f]{64}, not to the expected/) });
    await expect(installFromUrl('https://plugins.example.com/missing.tgz', admin)).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/HTTP 404/) });
    await expect(installFromUrl('http://plugins.example.com/echo.tgz', admin)).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/Only https/) });
    await nothingLeft();
  });

  test('an archive with a link or a path out of the package is refused, and nothing escapes', async () => {
    const { installFromUrl } = await import('./remote');
    const entries = entriesOfDir(FIXTURE_DIR);
    served.files.set('https://plugins.example.com/escape.tgz', makeTarGz([...entries, { name: '../../escaped.txt', data: 'x' }]));
    served.files.set('https://plugins.example.com/link.tgz', makeTarGz([...entries, { name: 'passwd', type: '2', linkname: '/etc/passwd' }]));
    served.files.set('https://plugins.example.com/junk.tgz', 'not a tarball');
    await expect(installFromUrl('https://plugins.example.com/escape.tgz', admin)).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/leaves the package/) });
    await expect(installFromUrl('https://plugins.example.com/link.tgz', admin)).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/symbolic link/) });
    await expect(installFromUrl('https://plugins.example.com/junk.tgz', admin)).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/gzip/) });
    expect(existsSync(join(process.env.WORKSPACE_PATH as string, 'escaped.txt'))).toBe(false);
    await nothingLeft();
  });
});

describe('revoked and expired keys on installed packages', () => {
  test('a directory install by a revoked key is refused; by an expired key it installs as unsigned with a warning', async () => {
    const svc = await import('./service');
    const dir = mkdtempSync(join(tmpdir(), 'octipus-remote-dir-'));
    cpSync(FIXTURE_DIR, dir, { recursive: true });
    await signPackage(dir, acme.privateKeyPem);
    await policy({ trusted: [{ ...ACME, revoked: true }] });
    await expect(svc.installFromDirectory(dir, admin)).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/revoked key/) });
    await policy({ trusted: [{ ...ACME, notAfter: '2020-01-01' }] });
    const row = await svc.installFromDirectory(dir, admin);
    expect(row.signedBy).toBeNull();
    expect(row.warnings).toEqual([expect.stringMatching(/expired key.*installed as unsigned/)]);
  });

  test('revoking the key of an installed package: shown in the view, and with requireSignature it no longer starts', async () => {
    const svc = await import('./service');
    const { getMCPBridge } = await import('@/mcp/bridge');
    const { installFromUrl } = await import('./remote');
    const url = 'https://plugins.example.com/echo.tgz';
    await serveFixture(url, { key: acme.privateKeyPem });
    await installFromUrl(url, admin);
    await svc.updateSettings(NAME, { region: 'eu' }, admin);
    await svc.setSecret(NAME, 'ECHO_TOKEN', 'tok', admin);
    await policy({ requireSignature: true });
    await svc.setEnabled(NAME, true, admin);
    expect((await svc.packageView(NAME)).connected).toBe(true);

    await policy({ revokedKeys: [acme.keyId] });
    let view = await svc.packageView(NAME);
    expect([view.signedBy, view.signature?.status, view.signature?.publisher]).toEqual([null, 'revoked', 'Acme']);
    await getMCPBridge().disconnect(SERVER);
    await svc.syncPluginServers();
    view = await svc.packageView(NAME);
    expect(view.connected).toBe(false);
    expect(view.problem).toMatch(/revoked key.*requireSignature/);
    expect((await auditOps('signature_refused')).at(-1)).toMatchObject({ status: 'revoked' });

    // Expiry by date stops it the same way.
    await policy({ revokedKeys: [], trusted: [{ ...ACME, notAfter: '2020-01-01T00:00:00Z' }] });
    await getMCPBridge().disconnect(SERVER);
    await svc.syncPluginServers();
    view = await svc.packageView(NAME);
    expect([view.connected, view.signature?.status]).toEqual([false, 'expired']);
    expect(view.problem).toMatch(/expired key/);
  });
});

describe('registries', () => {
  test('merges the indexes, marks what is installed, reports a registry that cannot be read, and caches', async () => {
    const { listRegistry } = await import('./remote');
    const { installFromUrl } = await import('./remote');
    const url = 'https://plugins.example.com/echo.tgz';
    const sha256 = await serveFixture(url, { key: acme.privateKeyPem });
    served.files.set('https://acme.example.com/index.json', JSON.stringify({
      packages: [
        { name: NAME, version: '1.0.0', description: 'Echo', url, sha256 },
        { name: 'broken', version: 'x', url, sha256 },
      ],
    }));
    served.files.set('https://other.example.com/index.json', JSON.stringify({ packages: [{ name: 'datev', version: '2.0.0', url: 'https://other.example.com/datev.tgz', sha256: 'cd'.repeat(32) }] }));
    await policy({
      registries: [
        { name: 'Acme', url: 'https://acme.example.com/index.json' },
        { name: 'Other', url: 'https://other.example.com/index.json' },
        { name: 'Down', url: 'https://down.example.com/index.json' },
      ],
    });

    let listing = await listRegistry();
    expect(listing.packages).toEqual([
      { registry: 'Acme', name: NAME, version: '1.0.0', description: 'Echo', url, sha256, installedVersion: null },
      { registry: 'Other', name: 'datev', version: '2.0.0', description: null, url: 'https://other.example.com/datev.tgz', sha256: `sha256:${'cd'.repeat(32)}`, installedVersion: null },
    ]);
    expect(listing.errors).toEqual([{ registry: 'Down', error: expect.stringMatching(/HTTP 404/) }]);

    // Installing what the index offers, with its sha256; the next listing (cached index) shows it installed.
    await installFromUrl(url, admin, { sha256 });
    served.fetched = [];
    listing = await listRegistry();
    expect(listing.packages[0].installedVersion).toBe('1.0.0');
    expect(served.fetched).toEqual([]);
  });
});
