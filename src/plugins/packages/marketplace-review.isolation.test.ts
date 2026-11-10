/**
 * Regression tests for the independent review of the marketplace host side
 * (probes P1–P6 and the findings around them). Each states the safe
 * behaviour: marketplace trust stays inside the marketplace, a revoked
 * signer leaves nothing behind, a marketplace package runs only with a
 * marketplace signature, and hostile text never reaches a terminal raw.
 *
 * Ephemeral PGlite, the guarded fetch mocked; every key is generated here.
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
process.env.WORKSPACE_PATH ??= mkdtempSync(join(tmpdir(), 'octipus-mpr-ws-'));

const served = vi.hoisted(() => ({ files: new Map<string, Buffer | string>(), fetched: [] as string[], redirects: new Map<string, string>(), delayMs: 0 }));
vi.mock('@/utils/sanitize', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/sanitize')>(),
  fetchGuarded: async (url: string) => {
    served.fetched.push(url);
    if (served.delayMs > 0) await new Promise((r) => setTimeout(r, served.delayMs));
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
const ACME_URL = 'https://acme.example.com/index.json';
const root = generateSigningKey();
const rootBackup = generateSigningKey();
const keyA = generateSigningKey();
const keyB = generateSigningKey();
type Key = ReturnType<typeof generateSigningKey>;
const ESC = '\u001b';
const BEL = '\u0007';

let clock = Date.parse('2026-11-10T00:00:00Z');
const nextTime = () => new Date((clock += 60_000)).toISOString();

function serveSigned(url: string, body: string, sig: string): void {
  served.files.set(url, body);
  served.files.set(`${url}.sig`, sig);
}

function publishKeys(version: number, signing: Key[], opts: { revoked?: string[]; signer?: Key; expires?: string; generatedAt?: string } = {}): void {
  const body = `${JSON.stringify({
    schema: 1, version, generatedAt: opts.generatedAt ?? nextTime(), ...(opts.expires ? { expires: opts.expires } : {}),
    signingKeys: signing.map((k) => ({ keyId: k.keyId, publicKey: k.publicKeyPem })),
    revokedKeys: (opts.revoked ?? []).map((keyId) => ({ keyId, reason: 'leaked' })),
  }, null, 2)}\n`;
  serveSigned(`${ORIGIN}/keys.json`, body, serializeSignature(signMarketplaceKeys(Buffer.from(body), (opts.signer ?? root).privateKeyPem)));
}

interface Published { version: string; url: string; sha256: string; contentHash: string; permissions: PluginPermissionsSummary }

async function publishPackage(version: string, key: Key | null, mutate?: (manifest: Record<string, unknown>) => void, origin = ORIGIN): Promise<Published> {
  const dir = mkdtempSync(join(tmpdir(), 'octipus-mpr-pkg-'));
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'octipus-plugin.json'), 'utf8'));
  manifest.version = version;
  mutate?.(manifest);
  writeFileSync(join(dir, 'octipus-plugin.json'), JSON.stringify(manifest));
  const parsed = parseManifest(manifest);
  const contentHash = key ? (await signPackage(dir, key.privateKeyPem)).contentHash : await hashPackageContent(dir, parsed, { source: true });
  const tarball = makeTarGz(entriesOfDir(dir, 'package'));
  const url = `${origin}/dl/${NAME}-${version}-${rand(3)}.tar.gz`;
  served.files.set(url, tarball);
  return { version, url, sha256: createHash('sha256').update(tarball).digest('hex'), contentHash, permissions: await packagePermissions(parsed, dir) };
}

function entryOf(p: Published, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: NAME, version: p.version, description: 'Echo', url: p.url, sha256: p.sha256, contentHash: p.contentHash, apiVersion: '1.0.0', minOctipus: null,
    title: 'Echo', summary: 'Echoes things back', category: 'utilities', tags: ['test'], icon: `${ORIGIN}/${NAME}/icon.png`, screenshots: [],
    readme: '# Echo', changelog: '## 1.0.0', publisher: 'Octipus', license: 'MIT', publishedAt: '2026-11-01T00:00:00Z', permissions: p.permissions, deprecated: null,
    ...over,
  };
}

function publishIndex(entries: unknown[], opts: { signer?: Key; revoked?: unknown[]; generatedAt?: string; expires?: string; url?: string } = {}): string {
  const url = opts.url ?? INDEX_URL;
  const body = `${JSON.stringify({ schema: 2, generatedAt: opts.generatedAt ?? nextTime(), ...(opts.expires ? { expires: opts.expires } : {}), publisher: 'Octipus', url, packages: entries, revoked: opts.revoked ?? [] }, null, 2)}\n`;
  serveSigned(url, body, serializeSignature(signRegistryIndex(Buffer.from(body), (opts.signer ?? keyA).privateKeyPem)));
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

async function notifications(type: string): Promise<Array<{ title: string; body: string }>> {
  const { queryRaw } = await import('@/db/postgres');
  const { rows } = await queryRaw(`SELECT title, body FROM notifications WHERE user_id = '${admin}' AND type = '${type}' ORDER BY created_at`);
  return rows as Array<{ title: string; body: string }>;
}

async function install(over: Record<string, unknown> = {}) {
  const { installFromRegistry } = await import('./registry-install');
  return installFromRegistry(admin, { registry: 'marketplace', name: NAME, ...over });
}

async function installDir(key: Key | null, version = '1.0.0') {
  const dir = mkdtempSync(join(tmpdir(), 'octipus-mpr-local-'));
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'octipus-plugin.json'), 'utf8'));
  manifest.version = version;
  writeFileSync(join(dir, 'octipus-plugin.json'), JSON.stringify(manifest));
  if (key) await signPackage(dir, key.privateKeyPem);
  const svc = await import('./service');
  return svc.installFromDirectory(dir, admin);
}

const hasUnsafe = (s: string) => /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/.test(s);

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-mpr-'));
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
  served.delayMs = 0;
  await clearCaches();
  (await import('./revocation-effects'))._resetAppliedRevocations?.();
});

afterEach(async () => {
  const svc = await import('./service');
  for (const p of await svc.listPackages()) await svc.uninstall(p.name, admin);
  const { executeRaw } = await import('@/db/postgres');
  for (const t of ['plugin_revocations', 'plugin_registry_state', 'plugin_marketplace_keys', 'plugin_listing_pins', 'plugin_update_notices', 'notifications']) await executeRaw(`DELETE FROM ${t}`);
  served.files.clear();
  served.redirects.clear();
  served.fetched = [];
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('marketplace trust stays inside the marketplace (P1, P2)', () => {
  test('P1: keys.json cannot revoke a key it never endorsed; a trusted publisher\'s directory install keeps starting', async () => {
    const acme = generateSigningKey();
    const { getConfig } = await import('@/config');
    getConfig().plugins.trustedPublishers = [{ name: 'Acme', publicKey: acme.publicKeyPem }];
    const row = await installDir(acme);
    expect(row.signedBy).toBe('Acme');
    const svc = await import('./service');
    expect(await svc.checkPackageBeforeStart(NAME)).toBeNull();
    publishKeys(1, [keyA], { revoked: [acme.keyId] });
    publishIndex([]);
    const { marketplaceListing } = await import('./marketplace');
    expect((await marketplaceListing()).state).toBe('ready');
    // Never endorsed: the revocation is ignored, and nothing outside the marketplace is touched.
    expect(await (await import('./revocations')).keyRevocation(acme.keyId)).toBeNull();
    expect(await svc.checkPackageBeforeStart(NAME)).toBeNull();
    expect((await svc.packageView(NAME)).revocation).toBeNull();
  });

  test('P1: a revoked marketplace key never reaches trustedPublishers, a directory install or another registry', async () => {
    publishKeys(1, [keyA]);
    publishIndex([]);
    const { marketplaceListing } = await import('./marketplace');
    expect((await marketplaceListing()).state).toBe('ready');
    await clearCaches();
    // keys.json v2 revokes A (endorsed before: accepted for the marketplace).
    publishKeys(2, [keyB], { revoked: [keyA.keyId] });
    publishIndex([], { signer: keyB });
    expect((await marketplaceListing()).state).toBe('ready');
    expect(await (await import('./revocations')).keyRevocation(keyA.keyId)).not.toBeNull();

    // The admin trusts the same key as a publisher of their own: their install and their registry are untouched.
    const { getConfig } = await import('@/config');
    getConfig().plugins.trustedPublishers = [{ name: 'Acme', publicKey: keyA.publicKeyPem }];
    getConfig().plugins.registries = [{ name: 'acme', url: ACME_URL, publisher: 'Acme' }];
    await installDir(keyA);
    const svc = await import('./service');
    expect(await svc.checkPackageBeforeStart(NAME)).toBeNull();
    expect((await svc.packageView(NAME)).signature).toMatchObject({ status: 'valid', keyId: keyA.keyId });
    const listed = await publishPackage('3.0.0', keyA, undefined, 'https://acme.example.com');
    publishIndex([entryOf(listed, { icon: null })], { url: ACME_URL, signer: keyA });
    const listing = await marketplaceListing();
    expect(listing.errors.filter((e) => e.registry === 'acme')).toEqual([]);
    expect(listing.plugins.find((p) => p.registry === 'acme')?.latest).toBe('3.0.0');
  });

  test('P2: an index package revocation never stops or refuses a directory install of the same name and version', async () => {
    const row = await installDir(null);
    expect(row.origin?.source).toBe('directory');
    const svc = await import('./service');
    publishKeys(1, [keyA]);
    publishIndex([], { revoked: [{ name: NAME, version: '1.0.0', reason: 'x' }] });
    const { marketplaceListing } = await import('./marketplace');
    await marketplaceListing();
    expect(await svc.checkPackageBeforeStart(NAME)).toBeNull();
    expect((await svc.packageView(NAME)).revocation).toBeNull();
    // Re-installed from a directory: not refused. From the marketplace: refused.
    await svc.uninstall(NAME, admin);
    await installDir(null);
    await svc.uninstall(NAME, admin);
    await clearCaches();
    const p = await publishPackage('1.0.0', keyA);
    publishIndex([entryOf(p)], { revoked: [{ name: NAME, version: '1.0.0', reason: 'x' }] });
    await expect(install({ version: '1.0.0' })).rejects.toThrow(/revoked/);
  });

  test('P2: another registry\'s card is never marked revoked by the marketplace', async () => {
    const { getConfig } = await import('@/config');
    getConfig().plugins.registries = [{ name: 'acme', url: ACME_URL }];
    publishKeys(1, [keyA]);
    publishIndex([], { revoked: [{ name: NAME, version: '3.0.0', reason: 'x' }] });
    const listed = await publishPackage('3.0.0', null, undefined, 'https://acme.example.com');
    served.files.set(ACME_URL, JSON.stringify({ schema: 2, generatedAt: nextTime(), packages: [entryOf(listed, { icon: null })] }));
    const { marketplaceListing } = await import('./marketplace');
    const card = (await marketplaceListing()).plugins.find((p) => p.registry === 'acme');
    expect(card).toMatchObject({ latest: '3.0.0', revoked: null });
    expect(card?.versions[0].revoked).toBeNull();
  });
});

describe('a revoked signer leaves nothing behind (P3)', () => {
  test('P3: revocations and pins of a key revoked later stop counting; the next legitimate index is listed', async () => {
    publishKeys(1, [keyA, keyB]);
    const evil = await publishPackage('2.0.0', keyB, (m) => { m.description = 'evil'; });
    publishIndex([entryOf(evil)], { signer: keyB, revoked: [{ name: 'some-other', version: '1.0.0', reason: 'by leaked key' }] });
    const { marketplaceListing } = await import('./marketplace');
    expect((await marketplaceListing()).state).toBe('ready');
    const rev = await import('./revocations');
    expect(await rev.packageRevocation('some-other', '1.0.0')).not.toBeNull();

    await clearCaches();
    publishKeys(2, [keyA], { revoked: [keyB.keyId] });
    const good = await publishPackage('2.0.0', keyA);
    publishIndex([entryOf(good)]);
    const l = await marketplaceListing();
    expect(l.state).toBe('ready');
    expect(l.errors).toEqual([]);
    expect(l.plugins[0].versions).toEqual([expect.objectContaining({ version: '2.0.0', contentHash: good.contentHash })]);
    expect((await auditOps('listing_pins_dropped')).at(-1)).toMatchObject({ dropped: [expect.objectContaining({ name: NAME, version: '2.0.0', signedBy: keyB.keyId })] });
    // The leaked key's revocation is flagged, and not enforced.
    expect(await rev.packageRevocation('some-other', '1.0.0')).toBeNull();
    expect((await rev.activeRevocations()).filter((r) => r.kind === 'package')).toEqual([]);
    const listedRevs = await rev.listRevocations();
    expect(listedRevs.find((s) => s.row.name === 'some-other')).toMatchObject({ signerRevoked: true, enforced: false });
    // The legitimate version installs.
    expect((await install({ version: '2.0.0' })).version).toBe('2.0.0');

    // A trusted key re-asserts it: enforced again, under that key.
    await clearCaches();
    publishIndex([entryOf(good)], { revoked: [{ name: 'some-other', version: '1.0.0', reason: 'confirmed' }] });
    await marketplaceListing();
    expect(await rev.packageRevocation('some-other', '1.0.0')).toMatchObject({ signedByKey: keyA.keyId });
    expect((await rev.listRevocations()).find((s) => s.row.name === 'some-other')).toMatchObject({ signerRevoked: false, enforced: true });
  });

  test('one index revoking many versions sends one notification with the count', async () => {
    publishKeys(1, [keyA]);
    const revoked = Array.from({ length: 25 }, (_, i) => ({ name: `pkg-${i}`, version: '1.0.0', reason: 'bulk' }));
    publishIndex([], { revoked });
    const { marketplaceListing } = await import('./marketplace');
    await marketplaceListing();
    const sent = await notifications('plugin_revoked');
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toMatch(/25 revocations/);
    expect(sent[0].body).toMatch(/and 15 more/);
  });

  test('an entry that replaces a pinned version is refused alone; an admin can reset the pin (audited)', async () => {
    publishKeys(1, [keyA]);
    const p = await publishPackage('1.0.0', keyA);
    publishIndex([entryOf(p)]);
    const { marketplaceListing } = await import('./marketplace');
    await marketplaceListing();
    await clearCaches();
    const swapped = await publishPackage('1.0.0', keyA, (m) => { m.description = 'republished'; });
    const other = await publishPackage('1.1.0', keyA);
    publishIndex([entryOf(swapped), entryOf(other)]);
    let l = await marketplaceListing();
    expect(l.state).toBe('ready');
    expect(l.plugins[0].versions.map((v) => v.version)).toEqual(['1.1.0']);
    expect(l.errors[0].error).toMatch(/replaced: refused/);
    expect(await notifications('plugin_listing_replaced')).toHaveLength(1);

    const { resetPin } = await import('./listing-pins');
    expect(await resetPin(INDEX_URL, NAME, '1.0.0', admin, 'republished on purpose')).toMatchObject({ contentHash: p.contentHash, signedBy: keyA.keyId });
    expect((await auditOps('listing_pin_reset')).at(-1)).toMatchObject({ name: NAME, version: '1.0.0', reason: 'republished on purpose' });
    await clearCaches();
    publishIndex([entryOf(swapped), entryOf(other)]);
    l = await marketplaceListing();
    expect(l.errors).toEqual([]);
    expect(l.plugins[0].versions.map((v) => v.version)).toEqual(['1.1.0', '1.0.0']);
  });
});

describe('a marketplace package runs only with a marketplace signature (P6)', () => {
  test('P6: a key dropped from keys.json, or a stored keys.json that no longer verifies, stops it whatever requireSignature says', async () => {
    publishKeys(1, [keyA]);
    const p = await publishPackage('1.0.0', keyA);
    publishIndex([entryOf(p)]);
    await install();
    const svc = await import('./service');
    expect(await svc.checkPackageBeforeStart(NAME)).toBeNull();
    await clearCaches();
    // A is simply no longer listed (not revoked).
    publishKeys(2, [keyB]);
    publishIndex([entryOf(p)], { signer: keyB });
    const { marketplaceListing } = await import('./marketplace');
    expect((await marketplaceListing()).state).toBe('ready');
    await clearCaches();
    expect((await svc.packageView(NAME)).signature).toMatchObject({ status: 'unknown_key' });
    expect(await svc.checkPackageBeforeStart(NAME)).toMatch(/not a signing key the marketplace's keys\.json endorses/);

    await clearCaches();
    publishKeys(3, [keyA]);
    publishIndex([entryOf(p)]);
    await marketplaceListing();
    expect(await svc.checkPackageBeforeStart(NAME)).toBeNull();
    // Other roots: the stored keys.json no longer verifies.
    const { getConfig } = await import('@/config');
    getConfig().plugins.marketplace = { enabled: true, url: INDEX_URL, rootKeys: { root: generateSigningKey().publicKeyPem } };
    await clearCaches();
    expect(await svc.checkPackageBeforeStart(NAME)).toMatch(/does not start|endorses/);
    // Trusting the key as a publisher does not make a marketplace package run.
    getConfig().plugins.trustedPublishers = [{ name: 'Acme', publicKey: keyA.publicKeyPem }];
    expect(await svc.checkPackageBeforeStart(NAME)).toMatch(/endorses/);
  });
});

describe('text is never echoed raw (P4)', () => {
  test('P4: a v1 description and the names in problem labels carry no control, bidi or invisible characters', async () => {
    const { getConfig } = await import('@/config');
    getConfig().plugins.registries = [{ name: 'acme', url: ACME_URL }];
    served.files.set(ACME_URL, JSON.stringify({ packages: [
      { name: 'foo', version: '1.0.0', url: 'https://acme.example.com/foo.tgz', sha256: 'a'.repeat(64), description: `ok${ESC}[2K${ESC}[1A${ESC}]52;c;cHduZWQ=${BEL}‮evil⁠` },
    ] }));
    const { marketplaceListing } = await import('./marketplace');
    const l = await marketplaceListing();
    const foo = l.plugins.find((p) => p.name === 'foo');
    expect(foo?.description).toBe('ok[2K[1A]52;c;cHduZWQ=evil');
    await clearCaches();
    served.files.set(ACME_URL, JSON.stringify({ schema: 2, generatedAt: nextTime(), packages: [{ name: `x${ESC}]0;pwn${BEL}` }, { name: `y\u{E0041}­`, version: 1 }] }));
    const l2 = await marketplaceListing();
    expect(l2.errors.length).toBeGreaterThan(0);
    for (const e of l2.errors) expect(hasUnsafe(e.error) || /[\u{E0000}-\u{E007F}]/u.test(e.error)).toBe(false);
  });

  test('line() refuses the other invisible characters', async () => {
    const { line } = await import('./listing-text');
    for (const ch of ['⁠', '⁡', '⁤', '­', '᠎', 'ㅤ', 'ᅟ', '\u{E0001}', '\u{E0041}', '\u{E007F}']) {
      expect(line(100).safeParse(`a${ch}b`).success).toBe(false);
    }
    expect(line(100).safeParse('plain text, accents: é ü').success).toBe(true);
  });
});

describe('a registry cannot pass for the marketplace (P5)', () => {
  test('P5: a registry named "marketplace" that got past the schema is ignored, never merged into the marketplace cards', async () => {
    const { getConfig } = await import('@/config');
    publishKeys(1, [keyA]);
    const p = await publishPackage('1.0.0', keyA);
    publishIndex([entryOf(p)]);
    getConfig().plugins.registries = [{ name: 'marketplace', url: 'https://evil.example.com/index.json' }];
    served.files.set('https://evil.example.com/index.json', JSON.stringify({ schema: 2, generatedAt: nextTime(), packages: [
      { ...entryOf({ ...p, version: '9.0.0', url: 'https://evil.example.com/x.tgz', permissions: { ...p.permissions, version: '9.0.0' } }), title: 'Echo (official, safe)' },
    ] }));
    const { marketplaceListing } = await import('./marketplace');
    const l = await marketplaceListing();
    expect(l.plugins).toHaveLength(1);
    expect(l.plugins[0]).toMatchObject({ registry: 'marketplace', title: 'Echo', latest: '1.0.0' });
    expect(served.fetched).not.toContain('https://evil.example.com/index.json');
  });
});

describe('every instance applies the revocations in force (finding 6)', () => {
  test('a revocation stored by another instance stops tokens here on the catch-up, once', async () => {
    publishKeys(1, [keyA]);
    const p = await publishPackage('1.0.0', keyA);
    publishIndex([entryOf(p)]);
    await install();
    const effects = await import('./revocation-effects');
    await effects.catchUpRevocations();
    const { mintHostToken, verifyHostToken } = await import('./host-api');
    const { token } = mintHostToken({ plugin: NAME, userId: admin, workspaceId: null, sessionId: null, scopes: ['notes:read'], maxProtection: 2, tool: 'x' }, 60_000);
    expect(verifyHostToken(token, NAME)).not.toBeNull();
    // Another instance stored it: this one never saw it returned by its insert.
    const { recordRevocations } = await import('./revocations');
    await recordRevocations([{ kind: 'package', name: NAME, version: '1.0.0', reason: 'elsewhere' }], { registryUrl: INDEX_URL, signedByKey: keyA.keyId, indexGeneratedAt: new Date() });
    expect(verifyHostToken(token, NAME)).not.toBeNull();
    expect(await effects.catchUpRevocations()).toBe(1);
    expect(verifyHostToken(token, NAME)).toBeNull();
    expect(await effects.catchUpRevocations()).toBe(0);
  });
});

describe('roots, expiry and freshness (findings 9, 10)', () => {
  test('the revocation of a root key cannot be cleared', async () => {
    publishKeys(1, [keyA]);
    publishIndex([]);
    const { marketplaceListing } = await import('./marketplace');
    await marketplaceListing();
    await clearCaches();
    publishKeys(2, [keyA], { signer: rootBackup, revoked: [root.keyId] });
    await marketplaceListing();
    const rev = await import('./revocations');
    const rootRow = (await rev.listRevocations()).find((s) => s.row.keyId === root.keyId)?.row;
    expect(rootRow).toBeDefined();
    await expect(rev.clearRevocation(rootRow?.id as string, admin, 'oops')).rejects.toThrow(/root key/);
    expect(await rev.keyRevocation(root.keyId)).not.toBeNull();
  });

  test('an expired keys.json or index is refused; one not expired yet is accepted', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const { marketplaceListing } = await import('./marketplace');
    publishKeys(1, [keyA], { expires: past });
    publishIndex([]);
    expect(await marketplaceListing()).toMatchObject({ state: 'error', message: expect.stringMatching(/expired/) });
    await clearCaches();
    publishKeys(1, [keyA], { expires: future });
    publishIndex([], { expires: past });
    expect(await marketplaceListing()).toMatchObject({ state: 'error', message: expect.stringMatching(/index expired/) });
    await clearCaches();
    publishIndex([], { expires: future });
    expect((await marketplaceListing()).state).toBe('ready');
  });

  test('an index and keys.json older than 7 days show a banner and notify the admins once', async () => {
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    publishKeys(1, [keyA], { generatedAt: old });
    publishIndex([], { generatedAt: old });
    const { marketplaceListing } = await import('./marketplace');
    const l = await marketplaceListing();
    expect(l.state).toBe('ready');
    expect(l.stale.map((s) => s.file).sort()).toEqual(['index', 'keys.json']);
    expect(l.stale[0].message).toMatch(/10 days ago/);
    await marketplaceListing();
    expect(await notifications('plugin_marketplace_stale')).toHaveLength(2);
  });
});

describe('downloads and the asset proxy (finding 11)', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

  test('a delisted image stops serving, even cached; concurrent misses share one download', async () => {
    publishKeys(1, [keyA]);
    const p = await publishPackage('1.0.0', keyA);
    publishIndex([entryOf(p)]);
    const icon = `${ORIGIN}/${NAME}/icon.png`;
    served.files.set(icon, png);
    const { AssetError, fetchListingAsset } = await import('./marketplace-assets');
    served.delayMs = 20;
    await Promise.all([fetchListingAsset(icon), fetchListingAsset(icon), fetchListingAsset(icon)]);
    served.delayMs = 0;
    expect(served.fetched.filter((u) => u === icon)).toHaveLength(1);
    (await import('./remote')).clearRegistryCache();
    publishIndex([entryOf(p, { icon: null })]);
    const status = await fetchListingAsset(icon).then(() => 200, (e: unknown) => (e instanceof AssetError ? e.status : 500));
    expect(status).toBe(404);
  });

  test('a marketplace tarball that redirects off its origin is not followed', async () => {
    publishKeys(1, [keyA]);
    const p = await publishPackage('1.0.0', keyA);
    publishIndex([entryOf(p)]);
    served.redirects.set(p.url, 'https://evil.example.com/x.tar.gz');
    served.files.set('https://evil.example.com/x.tar.gz', served.files.get(p.url) as Buffer);
    await expect(install()).rejects.toThrow(/redirects off its origin/);
    expect(served.fetched).not.toContain('https://evil.example.com/x.tar.gz');
  });
});
