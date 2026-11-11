/**
 * The marketplace end to end (docs/PLUGIN-PACKAGES.md#marketplace), against
 * ephemeral PGlite with the guarded fetch mocked: root keys sign keys.json,
 * which endorses signing keys; an index and packages signed by an endorsed
 * key list and install; everything else is refused.
 *
 * Every key is generated here, in the test, and never written anywhere.
 */
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { entriesOfDir, makeTarGz } from '@/test-helpers/tar';
import type { PluginPermissionsSummary } from '@/shared/plugin-package';
import { hashPackageContent } from './integrity';
import { parseManifest } from './manifest';
import { packagePermissions } from './permissions';
import { generateSigningKey, serializeSignature, signMarketplaceKeys, signPackage, signRegistryIndex } from './signature';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';
process.env.WORKSPACE_PATH ??= mkdtempSync(join(tmpdir(), 'octipus-mp-ws-'));

const served = vi.hoisted(() => ({ files: new Map<string, Buffer | string>(), fetched: [] as string[], redirects: new Map<string, string>() }));
vi.mock('@/utils/sanitize', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/sanitize')>(),
  fetchGuarded: async (url: string) => {
    served.fetched.push(url);
    const to = served.redirects.get(url);
    if (to) return new Response(null, { status: 302, headers: { location: to } });
    const body = served.files.get(url);
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(typeof body === 'string' ? body : new Uint8Array(body));
  },
}));

const admin = '11111111-1111-4111-8111-111111111111';
const FIXTURE_DIR = join(__dirname, 'fixtures', 'echo-plugin');
const NAME = 'echo-plugin';
const ORIGIN = 'https://mp.example.com';
const INDEX_URL = `${ORIGIN}/index.json`;
const root = generateSigningKey();
const rootBackup = generateSigningKey();
const keyA = generateSigningKey();
const keyB = generateSigningKey();
type Key = ReturnType<typeof generateSigningKey>;

let clock = Date.parse('2026-11-10T00:00:00Z');
const nextTime = () => new Date((clock += 60_000)).toISOString();
/** 30 days after `generatedAt`: keys.json and the marketplace index must say when they expire (at most 90 and 45 days on). */
const in30Days = (generatedAt: string) => new Date(Date.parse(generatedAt) + 30 * 86_400_000).toISOString();

function serveSigned(url: string, body: string, sig: string): void {
  served.files.set(url, body);
  served.files.set(`${url}.sig`, sig);
}

function publishKeys(version: number, signing: Key[], opts: { revoked?: string[]; signer?: Key; notAfter?: string } = {}): void {
  const generatedAt = nextTime();
  const body = `${JSON.stringify({
    schema: 1, version, generatedAt, expires: in30Days(generatedAt),
    signingKeys: signing.map((k) => ({ keyId: k.keyId, publicKey: k.publicKeyPem, ...(opts.notAfter ? { notAfter: opts.notAfter } : {}) })),
    revokedKeys: (opts.revoked ?? []).map((keyId) => ({ keyId, reason: 'leaked' })),
  }, null, 2)}\n`;
  serveSigned(`${ORIGIN}/keys.json`, body, serializeSignature(signMarketplaceKeys(Buffer.from(body), (opts.signer ?? root).privateKeyPem)));
}

interface Published { version: string; url: string; sha256: string; contentHash: string; permissions: PluginPermissionsSummary }

/** The fixture at `version`, signed by `key` (unless null), served as a tarball on the marketplace origin. */
async function publishPackage(version: string, key: Key | null, mutate?: (manifest: Record<string, unknown>) => void): Promise<Published> {
  const dir = mkdtempSync(join(tmpdir(), 'octipus-mp-pkg-'));
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'octipus-plugin.json'), 'utf8'));
  manifest.version = version;
  mutate?.(manifest);
  writeFileSync(join(dir, 'octipus-plugin.json'), JSON.stringify(manifest));
  const parsed = parseManifest(manifest);
  const contentHash = key ? (await signPackage(dir, key.privateKeyPem)).contentHash : await hashPackageContent(dir, parsed, { source: true });
  const tarball = makeTarGz(entriesOfDir(dir, 'package'));
  const url = `${ORIGIN}/dl/${NAME}-${version}.tar.gz`;
  served.files.set(url, tarball);
  return { version, url, sha256: createHash('sha256').update(tarball).digest('hex'), contentHash, permissions: await packagePermissions(parsed, dir) };
}

function entryOf(p: Published, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: NAME, version: p.version, description: 'Echo', url: p.url, sha256: p.sha256, contentHash: p.contentHash, apiVersion: '1.0.0', minOctipus: null,
    title: 'Echo', summary: 'Echoes things back', category: 'utilities', tags: ['test'], icon: `${ORIGIN}/${NAME}/icon.png`, screenshots: [`${ORIGIN}/${NAME}/shot.svg`, `${ORIGIN}/${NAME}/big.png`, `${ORIGIN}/${NAME}/fake.png`],
    readme: '# Echo', changelog: '## 1.0.0', publisher: 'Octipus', license: 'MIT', publishedAt: '2026-11-01T00:00:00Z', permissions: p.permissions, deprecated: null,
    ...over,
  };
}

function publishIndex(entries: unknown[], opts: { signer?: Key; revoked?: unknown[]; generatedAt?: string } = {}): string {
  const generatedAt = opts.generatedAt ?? nextTime();
  const body = `${JSON.stringify({ schema: 2, generatedAt, expires: in30Days(generatedAt), publisher: 'Octipus', url: INDEX_URL, packages: entries, revoked: opts.revoked ?? [] }, null, 2)}\n`;
  serveSigned(INDEX_URL, body, serializeSignature(signRegistryIndex(Buffer.from(body), (opts.signer ?? keyA).privateKeyPem)));
  return body;
}

async function clearCaches(): Promise<void> {
  (await import('./remote')).clearRegistryCache();
  (await import('./marketplace-keys-file')).clearKeysCache();
  (await import('./marketplace-assets')).clearAssetCache();
}

async function auditOps(op: string): Promise<Array<Record<string, unknown>>> {
  const { queryRaw } = await import('@/db/postgres');
  const { rows } = await queryRaw(`SELECT details FROM audit_log WHERE resource_type = 'plugin_package' ORDER BY created_at`);
  return rows.map((r: { details: unknown }) => (typeof r.details === 'string' ? JSON.parse(r.details) : r.details) as Record<string, unknown>).filter((d: Record<string, unknown>) => d.op === op);
}

async function install(over: Record<string, unknown> = {}) {
  const { installFromRegistry } = await import('./registry-install');
  return installFromRegistry(admin, { registry: 'marketplace', name: NAME, ...over });
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-mp-'));
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

beforeEach(async () => {
  const { getConfig } = await import('@/config');
  const plugins = getConfig().plugins;
  plugins.marketplace = { enabled: true, url: INDEX_URL, rootKeys: { root: root.publicKeyPem, rootBackup: rootBackup.publicKeyPem } };
  plugins.trustedPublishers = [];
  plugins.revokedKeys = [];
  plugins.registries = [];
  plugins.requireSignature = false;
  await clearCaches();
});

afterEach(async () => {
  const svc = await import('./service');
  for (const p of await svc.listPackages()) await svc.uninstall(p.name, admin);
  const { executeRaw } = await import('@/db/postgres');
  for (const t of ['plugin_revocations', 'plugin_registry_state', 'plugin_marketplace_keys', 'plugin_listing_pins', 'plugin_update_notices']) await executeRaw(`DELETE FROM ${t}`);
  served.files.clear();
  served.redirects.clear();
  served.fetched = [];
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('configured or not', () => {
  test('with the built-in placeholder roots the marketplace is not configured, and nothing is fetched', async () => {
    const { getConfig } = await import('@/config');
    getConfig().plugins.marketplace = true;
    const { marketplaceListing } = await import('./marketplace');
    const listing = await marketplaceListing();
    expect(listing).toMatchObject({ state: 'unconfigured', message: 'The Octipus marketplace is not configured in this build', plugins: [] });
    await expect(install()).rejects.toThrow('The Octipus marketplace is not configured in this build');
    expect(served.fetched).toEqual([]);
  });

  test('plugins.marketplace: false turns it off: never fetched, never trusted', async () => {
    const { getConfig } = await import('@/config');
    getConfig().plugins.marketplace = false;
    publishKeys(1, [keyA]);
    const { marketplaceListing } = await import('./marketplace');
    expect(await marketplaceListing()).toMatchObject({ state: 'off', plugins: [] });
    await expect(install()).rejects.toThrow(/turned off/);
    expect(served.fetched).toEqual([]);
  });
});

describe('listing and install', () => {
  test('an index and a package signed by an endorsed key list and install, disabled, with provenance', async () => {
    publishKeys(1, [keyA]);
    const p = await publishPackage('1.0.0', keyA);
    publishIndex([entryOf(p)]);
    const { marketplaceListing } = await import('./marketplace');
    const listing = await marketplaceListing();
    expect(listing.state).toBe('ready');
    expect(listing.plugins[0]).toMatchObject({
      name: NAME, title: 'Echo', latest: '1.0.0', compatibility: { ok: true }, installedVersion: null, downloads: null,
      icon: `/api/plugin-packages/marketplace/asset?url=${encodeURIComponent(`${ORIGIN}/${NAME}/icon.png`)}`, readme: '# Echo',
    });
    expect(listing.plugins[0].askSummary).toContain('Connects to api.example.com');
    expect(listing.plugins[0].declarations.map((d) => d.id)).toContain('tool:send_letter');
    expect((await marketplaceListing({ q: 'ÉCHOES' })).plugins).toHaveLength(1);
    expect((await marketplaceListing({ q: 'nothing-like-it' })).plugins).toHaveLength(0);

    const row = await install();
    expect([row.name, row.version, row.enabled, row.signedBy]).toEqual([NAME, '1.0.0', false, 'Octipus']);
    expect(row.guidance.map((g) => g.code)).toContain('review_before_enabling');
    const svc = await import('./service');
    const view = await svc.packageView(NAME);
    expect(view.origin).toMatchObject({ source: 'marketplace', listingVersion: '1.0.0', url: p.url });
    expect(view.signature).toMatchObject({ status: 'valid', keyId: keyA.keyId });
    expect(view.declarations.find((d) => d.id === 'secrets')).toBeDefined();
    expect((await auditOps('installed')).at(-1)).toMatchObject({ origin: { source: 'marketplace' }, keyId: keyA.keyId });
    expect(await svc.checkPackageBeforeStart(NAME)).toBeNull();
  });

  test('download counts come from stats.json and are ignored when malformed', async () => {
    publishKeys(1, [keyA]);
    publishIndex([entryOf(await publishPackage('1.0.0', keyA))]);
    served.files.set(`${ORIGIN}/stats.json`, JSON.stringify({ generatedAt: '2026-11-10T00:00:00Z', downloads: { [NAME]: 42 } }));
    const { marketplaceListing } = await import('./marketplace');
    expect((await marketplaceListing()).plugins[0].downloads).toBe(42);
    await clearCaches();
    served.files.set(`${ORIGIN}/stats.json`, JSON.stringify({ downloads: { [NAME]: -1 } }));
    expect((await marketplaceListing()).plugins[0].downloads).toBeNull();
  });

  test('an index signed by a key keys.json does not endorse lists nothing', async () => {
    publishKeys(1, [keyA]);
    publishIndex([entryOf(await publishPackage('1.0.0', keyA))], { signer: keyB });
    const { marketplaceListing } = await import('./marketplace');
    const listing = await marketplaceListing();
    expect(listing).toMatchObject({ state: 'error', plugins: [] });
    expect(listing.message).toMatch(/not a key of publisher Octipus/);
    await expect(install()).rejects.toThrow(/cannot be read/);
  });

  test('a keys.json signed by a key that is not a root makes the marketplace unavailable', async () => {
    publishKeys(1, [keyA], { signer: keyA });
    publishIndex([entryOf(await publishPackage('1.0.0', keyA))]);
    const { marketplaceListing } = await import('./marketplace');
    expect(await marketplaceListing()).toMatchObject({ state: 'error', message: expect.stringMatching(/not a root key/) });
  });

  test('a package signed by a trusted publisher but not by a marketplace key is refused', async () => {
    const { getConfig } = await import('@/config');
    getConfig().plugins.trustedPublishers = [{ name: 'Acme', publicKey: keyB.publicKeyPem }];
    publishKeys(1, [keyA]);
    publishIndex([entryOf(await publishPackage('1.0.0', keyB))]);
    await expect(install()).rejects.toThrow(/not in plugins.trustedPublishers|must carry a valid signature/);
    expect((await (await import('./service')).listPackages())).toEqual([]);
  });

  test('a listing that understates the permissions is refused, with an audit row', async () => {
    publishKeys(1, [keyA]);
    const p = await publishPackage('1.0.0', keyA);
    publishIndex([entryOf(p, { permissions: { ...p.permissions, network: [], tools: p.permissions.tools.filter((t) => t.effect !== 'external'), effects: { read: 2, write: 0, external: 0 } } })]);
    await expect(install()).rejects.toThrow(/does not state what the package asks for/);
    expect((await auditOps('listing_mismatch')).at(-1)).toMatchObject({ what: 'permissions', version: '1.0.0' });
    expect((await (await import('./service')).listPackages())).toEqual([]);
  });

  test('a preview from the marketplace verifies exactly as an install does, installs nothing, and installs with consent', async () => {
    publishKeys(1, [keyA]);
    const p = await publishPackage('1.0.0', keyA);
    publishIndex([entryOf(p)]);
    const { previewInstall, installPreview, _resetPreviewsForTesting } = await import('./consent');
    await _resetPreviewsForTesting();
    const preview = await previewInstall({ registry: 'marketplace', name: NAME }, admin);
    expect(preview).toMatchObject({ name: NAME, version: '1.0.0', contentHash: p.contentHash, signedBy: 'Octipus', origin: { source: 'marketplace' }, upgradeFrom: null });
    expect(preview.declarations.map((d) => d.id)).toContain('tool:send_letter');
    const svc = await import('./service');
    expect(await svc.listPackages()).toEqual([]);
    const result = await installPreview(preview.previewId, { contentHash: preview.contentHash, accepted: preview.declarations.map((d) => d.id) }, admin);
    expect(result).toMatchObject({ name: NAME, version: '1.0.0', enabled: false });
    expect((await svc.packageView(NAME)).origin).toMatchObject({ source: 'marketplace', listingVersion: '1.0.0' });
  });

  test('a preview refuses what an install refuses: a listing that understates, another key', async () => {
    publishKeys(1, [keyA]);
    const p = await publishPackage('1.0.0', keyA);
    publishIndex([entryOf(p, { permissions: { ...p.permissions, network: [] } })]);
    const { previewInstall } = await import('./consent');
    await expect(previewInstall({ registry: 'marketplace', name: NAME }, admin)).rejects.toThrow(/does not state what the package asks for/);
    await clearCaches();
    publishIndex([entryOf(await publishPackage('1.0.0', keyB))]);
    await expect(previewInstall({ registry: 'marketplace', name: NAME }, admin)).rejects.toThrow(/must carry a valid signature|not in plugins.trustedPublishers/);
    expect(await (await import('./service')).listPackages()).toEqual([]);
  });

  test('a contentHash the package does not hash to is refused', async () => {
    publishKeys(1, [keyA]);
    const p = await publishPackage('1.0.0', keyA);
    publishIndex([entryOf(p, { contentHash: `sha256:${'0'.repeat(64)}` })]);
    await expect(install()).rejects.toThrow(/not to the sha256:0+ its listing states/);
    expect((await auditOps('listing_mismatch')).at(-1)).toMatchObject({ what: 'contentHash' });
  });

  test('minOctipus shows as incompatible and installs only with the admin\'s consent; another plugin API never', async () => {
    publishKeys(1, [keyA]);
    const p = await publishPackage('1.0.0', keyA);
    publishIndex([entryOf(p, { minOctipus: '99.0.0' })]);
    const { marketplaceListing } = await import('./marketplace');
    const card = (await marketplaceListing()).plugins[0];
    expect(card.latest).toBeNull();
    expect(card.compatibility).toMatchObject({ ok: false, reason: expect.stringMatching(/Needs Octipus 99.0.0/) });
    expect(card.versions[0].compatibility.ok).toBe(false);
    await expect(install({ version: '1.0.0' })).rejects.toThrow(/allowIncompatible/);
    const row = await install({ version: '1.0.0', allowIncompatible: true });
    expect(row.guidance.map((g) => g.code)).toContain('incompatible');
    await (await import('./service')).uninstall(NAME, admin);

    await clearCaches();
    const q = await publishPackage('2.0.0', keyA, (m) => { m.apiVersion = '1.0.0'; });
    publishIndex([entryOf(q, { apiVersion: '9.0.0', permissions: { ...q.permissions, apiVersion: '9.0.0' } })]);
    await expect(install({ version: '2.0.0', allowIncompatible: true })).rejects.toThrow(/not supported/);
  });

  test('a published version whose content changes in a later index is refused (that entry only), and the admins told', async () => {
    publishKeys(1, [keyA]);
    const p = await publishPackage('1.0.0', keyA);
    publishIndex([entryOf(p)]);
    const { marketplaceListing } = await import('./marketplace');
    expect((await marketplaceListing()).state).toBe('ready');
    await clearCaches();
    const swapped = await publishPackage('1.0.0', keyA, (m) => { m.description = 'Different content, same version'; });
    const next = await publishPackage('1.1.0', keyA);
    publishIndex([entryOf(swapped), entryOf(next)]);
    const listing = await marketplaceListing();
    // The rest of the index stays usable; the replaced entry is refused and says so.
    expect(listing.state).toBe('ready');
    expect(listing.plugins[0].versions.map((v) => v.version)).toEqual(['1.1.0']);
    expect(listing.errors).toEqual([{ registry: 'marketplace', error: expect.stringMatching(/^echo-plugin 1\.0\.0: replaced: refused/) }]);
    expect((await auditOps('listing_replaced')).length).toBe(1);
    await expect(install({ version: '1.0.0' })).rejects.toThrow(/does not list echo-plugin 1\.0\.0/);
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT type FROM notifications WHERE user_id = '${admin}' AND type = 'plugin_listing_replaced'`);
    expect(rows.length).toBe(1);
  });

  test('an index older than the last one accepted is refused (rollback)', async () => {
    publishKeys(1, [keyA]);
    const p = await publishPackage('1.0.0', keyA);
    const old = nextTime();
    publishIndex([entryOf(p)], { generatedAt: nextTime() });
    const { marketplaceListing } = await import('./marketplace');
    expect((await marketplaceListing()).state).toBe('ready');
    await clearCaches();
    publishIndex([entryOf(p)], { generatedAt: old });
    expect(await marketplaceListing()).toMatchObject({ state: 'error', message: expect.stringMatching(/rollback/) });
  });

  test('an upgrade from another source needs the admin\'s consent, which is audited', async () => {
    publishKeys(1, [keyA]);
    const dir = mkdtempSync(join(tmpdir(), 'octipus-mp-dir-'));
    cpSync(FIXTURE_DIR, dir, { recursive: true });
    const svc = await import('./service');
    await svc.installFromDirectory(dir, admin);
    publishIndex([entryOf(await publishPackage('1.1.0', keyA))]);
    const refusal = await install({ upgrade: true }).catch((e: unknown) => e as InstanceType<typeof svc.PluginPackageError>);
    expect(refusal).toBeInstanceOf(svc.PluginPackageError);
    expect((refusal as InstanceType<typeof svc.PluginPackageError>).message).toMatch(/Confirm the change of source/);
    expect((refusal as InstanceType<typeof svc.PluginPackageError>).details.sourceChange).toEqual({ from: 'direct', to: 'marketplace' });
    expect((await svc.packageView(NAME)).version).toBe('1.0.0');
    const row = await install({ upgrade: true, allowSourceChange: true });
    expect(row.version).toBe('1.1.0');
    expect((await auditOps('upgraded')).at(-1)).toMatchObject({ sourceChange: { from: { source: 'directory' }, to: { source: 'marketplace' } } });
  });
});

describe('online revocation', () => {
  test('a revoked version is refused at install and at start, the row says why, and the admins are told', async () => {
    publishKeys(1, [keyA]);
    const p = await publishPackage('1.0.0', keyA);
    publishIndex([entryOf(p)]);
    await install();
    const svc = await import('./service');
    expect(await svc.checkPackageBeforeStart(NAME)).toBeNull();

    await clearCaches();
    publishIndex([entryOf(p)], { revoked: [{ name: NAME, version: '1.0.0', reason: 'leaks data' }] });
    const { marketplaceListing } = await import('./marketplace');
    const card = (await marketplaceListing()).plugins[0];
    expect(card).toMatchObject({ revoked: 'leaks data', latest: null });
    expect(await svc.checkPackageBeforeStart(NAME)).toMatch(/revoked by the marketplace \(leaks data\)/);
    expect((await svc.packageView(NAME)).revocation).toMatchObject({ kind: 'package', reason: 'leaks data', source: 'marketplace' });
    await expect(svc.setEnabled(NAME, true, admin)).rejects.toThrow(/revoked/);
    expect((await auditOps('revoked_online')).at(-1)).toMatchObject({ version: '1.0.0', kind: 'package' });
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT type FROM notifications WHERE user_id = '${admin}' AND type = 'plugin_revoked'`);
    expect(rows.length).toBe(1);

    await svc.uninstall(NAME, admin);
    await expect(install({ version: '1.0.0' })).rejects.toThrow(/revoked/);
  });

  test('revocations persist, accumulate, survive an index that drops them, and an admin can clear one (audited)', async () => {
    publishKeys(1, [keyA]);
    const p = await publishPackage('1.0.0', keyA);
    publishIndex([entryOf(p)], { revoked: [{ name: NAME, version: '1.0.0', reason: 'bad' }] });
    const { marketplaceListing } = await import('./marketplace');
    await marketplaceListing();
    await clearCaches();
    publishIndex([entryOf(p)], { revoked: [] });
    await marketplaceListing();
    // Offline now: the stored revocation still holds.
    served.files.clear();
    await clearCaches();
    const rev = await import('./revocations');
    expect((await rev.packageRevocation(NAME, '1.0.0'))?.reason).toBe('bad');
    expect((await marketplaceListing()).state).toBe('error');
    const [{ row }] = await rev.listRevocations();
    await rev.clearRevocation(row.id, admin, 'false alarm');
    expect(await rev.packageRevocation(NAME, '1.0.0')).toBeNull();
    expect((await auditOps('revocation_cleared')).at(-1)).toMatchObject({ reason: 'false alarm', name: NAME });
  });

  test('a revocation from an index that is not verified never counts', async () => {
    publishKeys(1, [keyA]);
    const p = await publishPackage('1.0.0', keyA);
    publishIndex([entryOf(p)], { signer: keyB, revoked: [{ name: NAME, version: '1.0.0', reason: 'forged' }] });
    const { marketplaceListing } = await import('./marketplace');
    await marketplaceListing();
    expect(await (await import('./revocations')).packageRevocation(NAME, '1.0.0')).toBeNull();
  });
});

describe('the key model: roots, keys.json, rotation', () => {
  test('rotation: keys.json v2 revokes A and endorses B; B works, anything signed by A is refused, installed A packages stop', async () => {
    publishKeys(1, [keyA]);
    const a1 = await publishPackage('1.0.0', keyA);
    publishIndex([entryOf(a1)]);
    await install();
    const svc = await import('./service');
    expect(await svc.checkPackageBeforeStart(NAME)).toBeNull();

    await clearCaches();
    publishKeys(2, [keyB], { revoked: [keyA.keyId] });
    const b1 = await publishPackage('1.0.0', keyB);
    publishIndex([entryOf(b1, { contentHash: b1.contentHash })], { signer: keyA });
    const { marketplaceListing } = await import('./marketplace');
    // An index still signed by A is refused.
    expect(await marketplaceListing()).toMatchObject({ state: 'error', message: expect.stringMatching(/revoked/) });
    // The installed package signed by A does not start any more.
    expect(await svc.checkPackageBeforeStart(NAME)).toMatch(/revoked key/);
    expect((await svc.packageView(NAME)).revocation).toMatchObject({ kind: 'key', keyId: keyA.keyId, source: 'marketplace' });

    // The rotation re-signs the live version with B (a new version, since the pinned 1.0.0 content cannot change).
    await clearCaches();
    const b2 = await publishPackage('1.0.1', keyB);
    publishIndex([entryOf(b2)], { signer: keyB });
    expect((await marketplaceListing()).state).toBe('ready');
    const row = await install({ upgrade: true, allowSignerChange: true });
    expect(row.version).toBe('1.0.1');
    expect(await svc.checkPackageBeforeStart(NAME)).toBeNull();
    expect((await svc.packageView(NAME)).signature).toMatchObject({ status: 'valid', keyId: keyB.keyId });

    // A package signed by A is refused at install, even when the index (signed by B) lists it.
    await svc.uninstall(NAME, admin);
    await clearCaches();
    const a2 = await publishPackage('1.0.2', keyA);
    publishIndex([entryOf(a2)], { signer: keyB });
    await expect(install({ version: '1.0.2' })).rejects.toThrow(/revoked key/);
  });

  test('a keys.json version not greater than the last is refused', async () => {
    publishKeys(2, [keyA]);
    publishIndex([entryOf(await publishPackage('1.0.0', keyA))]);
    const { marketplaceListing } = await import('./marketplace');
    expect((await marketplaceListing()).state).toBe('ready');
    await clearCaches();
    publishKeys(1, [keyA, keyB]);
    expect(await marketplaceListing()).toMatchObject({ state: 'error', message: expect.stringMatching(/not newer/) });
    await clearCaches();
    publishKeys(2, [keyA, keyB]);
    expect(await marketplaceListing()).toMatchObject({ state: 'error', message: expect.stringMatching(/other content/) });
  });

  test('the backup root revokes the root; the root is refused afterwards and can never revoke the backup', async () => {
    // The root may not revoke the backup: the whole file is refused.
    publishKeys(1, [keyA], { signer: root, revoked: [rootBackup.keyId] });
    publishIndex([entryOf(await publishPackage('1.0.0', keyA))]);
    const { marketplaceListing } = await import('./marketplace');
    expect(await marketplaceListing()).toMatchObject({ state: 'error', message: expect.stringMatching(/may not revoke the rootBackup/) });
    expect(await (await import('./revocations')).keyRevocation(rootBackup.keyId)).toBeNull();

    // The backup revokes the root (with a version far below a leaked root's inflated one).
    await clearCaches();
    publishKeys(1000, [keyA], { signer: root });
    expect((await marketplaceListing()).state).toBe('ready');
    await clearCaches();
    publishKeys(2, [keyB], { signer: rootBackup, revoked: [root.keyId, keyA.keyId] });
    publishIndex([entryOf(await publishPackage('1.1.0', keyB))], { signer: keyB });
    expect((await marketplaceListing()).state).toBe('ready');

    // Anything the root signs from now on is refused.
    await clearCaches();
    publishKeys(1001, [keyA], { signer: root });
    expect(await marketplaceListing()).toMatchObject({ state: 'error', message: expect.stringMatching(/revoked/) });
  });

  test('offline, installed marketplace packages verify against the stored keys.json, re-verified against the roots', async () => {
    publishKeys(1, [keyA]);
    publishIndex([entryOf(await publishPackage('1.0.0', keyA))]);
    await install();
    served.files.clear();
    await clearCaches();
    const svc = await import('./service');
    expect(await svc.checkPackageBeforeStart(NAME)).toBeNull();
    expect((await svc.packageView(NAME)).signature).toMatchObject({ status: 'valid' });
    // Other roots configured: the stored file no longer verifies, so its keys trust nothing.
    const { getConfig } = await import('@/config');
    getConfig().plugins.marketplace = { enabled: true, url: INDEX_URL, rootKeys: { root: keyB.publicKeyPem } };
    await clearCaches();
    expect((await svc.packageView(NAME)).signature).toMatchObject({ status: 'unknown_key' });
  });
});

describe('updates', () => {
  test('a newer version from the same source is listed with its permissions diff, notified once, never installed', async () => {
    publishKeys(1, [keyA]);
    const v1 = await publishPackage('1.0.0', keyA);
    publishIndex([entryOf(v1)]);
    await install();
    await clearCaches();
    const v2 = await publishPackage('1.1.0', keyA, (m) => { m.host = ['notes:write']; });
    publishIndex([entryOf(v2), entryOf(v1)]);
    const { listUpdates, notifyUpdates } = await import('./marketplace-updates');
    const updates = await listUpdates();
    expect(updates).toEqual([expect.objectContaining({ name: NAME, installed: '1.0.0', latest: '1.1.0', registry: 'marketplace' })]);
    expect(updates[0].diff).toMatchObject({ widened: true, changes: [expect.objectContaining({ kind: 'host', change: 'added', text: 'host API scope notes:write' })] });
    expect(updates[0].warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['widens', 'consent']));
    expect(await notifyUpdates()).toBe(1);
    expect(await notifyUpdates()).toBe(0);
    expect((await (await import('./service')).packageView(NAME)).version).toBe('1.0.0');
  });

  test('a package installed from elsewhere gets no update from the marketplace', async () => {
    publishKeys(1, [keyA]);
    const dir = mkdtempSync(join(tmpdir(), 'octipus-mp-dir-'));
    cpSync(FIXTURE_DIR, dir, { recursive: true });
    await (await import('./service')).installFromDirectory(dir, admin);
    publishIndex([entryOf(await publishPackage('1.1.0', keyA))]);
    expect(await (await import('./marketplace-updates')).listUpdates()).toEqual([]);
  });
});

describe('the asset proxy', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  beforeEach(async () => {
    publishKeys(1, [keyA]);
    publishIndex([entryOf(await publishPackage('1.0.0', keyA))]);
  });

  test('a listed PNG is served with its sniffed type', async () => {
    served.files.set(`${ORIGIN}/${NAME}/icon.png`, png);
    const { fetchListingAsset } = await import('./marketplace-assets');
    expect((await fetchListingAsset(`${ORIGIN}/${NAME}/icon.png`)).type).toBe('image/png');
  });

  test('SVG, wrong magic bytes, oversized files, unlisted and off-origin URLs, and redirects off the origin are refused', async () => {
    const { AssetError, fetchListingAsset, MAX_ASSET_BYTES } = await import('./marketplace-assets');
    served.files.set(`${ORIGIN}/${NAME}/shot.svg`, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    served.files.set(`${ORIGIN}/${NAME}/fake.png`, '<html>not a png</html>');
    served.files.set(`${ORIGIN}/${NAME}/big.png`, Buffer.concat([png, Buffer.alloc(MAX_ASSET_BYTES)]));
    const status = (url: string) => fetchListingAsset(url).then(() => 200, (e: unknown) => (e instanceof AssetError ? e.status : 500));
    expect(await status(`${ORIGIN}/${NAME}/shot.svg`)).toBe(415);
    expect(await status(`${ORIGIN}/${NAME}/fake.png`)).toBe(415);
    expect(await status(`${ORIGIN}/${NAME}/big.png`)).toBe(413);
    expect(await status(`${ORIGIN}/${NAME}/other.png`)).toBe(404);
    expect(await status('https://evil.example.com/echo-plugin/icon.png')).toBe(404);
    served.redirects.set(`${ORIGIN}/${NAME}/icon.png`, 'https://evil.example.com/x.png');
    served.files.set('https://evil.example.com/x.png', png);
    expect(await status(`${ORIGIN}/${NAME}/icon.png`)).toBe(502);
    expect(served.fetched).not.toContain('https://evil.example.com/x.png');
  });
});
