/**
 * Signed plugin packages end to end (docs/PLUGIN-PACKAGES.md#signed-packages):
 * install and upgrade check the signature against `plugins.trustedPublishers`
 * and record who signed; `plugins.requireSignature` refuses unsigned packages
 * and unknown keys at install and at every start; approving modified content
 * clears `signedBy` unless the new content is signed again.
 *
 * Backed by ephemeral PGlite; the fixture package runs as a real MCP server.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { generateSigningKey, signPackage } from './signature';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';
process.env.WORKSPACE_PATH ??= mkdtempSync(join(tmpdir(), 'octipus-signed-ws-'));

const admin = '11111111-1111-4111-8111-111111111111';
const FIXTURE_DIR = join(__dirname, 'fixtures', 'echo-plugin');
const NAME = 'echo-plugin';
const SERVER = 'plugin-echo-plugin';

const acme = generateSigningKey();
const stranger = generateSigningKey();

/** A copy of the fixture package, optionally at another version, signed with `key` when given. */
async function copyOfFixture(key?: string, version?: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'octipus-signed-pkg-'));
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  if (version) {
    const manifest = JSON.parse(readFileSync(join(dir, 'octipus-plugin.json'), 'utf8'));
    manifest.version = version;
    writeFileSync(join(dir, 'octipus-plugin.json'), JSON.stringify(manifest));
  }
  if (key) await signPackage(dir, key);
  return dir;
}

async function policy(change: { requireSignature?: boolean; trusted?: Array<{ name: string; publicKey: string }> }): Promise<void> {
  const { getConfig } = await import('@/config');
  const plugins = getConfig().plugins;
  if (change.requireSignature !== undefined) plugins.requireSignature = change.requireSignature;
  if (change.trusted !== undefined) plugins.trustedPublishers = change.trusted;
}

async function auditOps(op: string): Promise<Array<Record<string, unknown>>> {
  const { queryRaw } = await import('@/db/postgres');
  const { rows } = await queryRaw(
    `SELECT details FROM audit_log WHERE resource_type = 'plugin_package' AND resource_id = '${NAME}' ORDER BY created_at`,
  );
  return rows
    .map((r: { details: unknown }) => (typeof r.details === 'string' ? JSON.parse(r.details) : r.details) as Record<string, unknown>)
    .filter((d: Record<string, unknown>) => d.op === op);
}

/** Install `dir`, configure what the fixture requires, and enable it. */
async function installAndEnable(dir: string): Promise<void> {
  const svc = await import('./service');
  await svc.installFromDirectory(dir, admin);
  await svc.updateSettings(NAME, { region: 'eu' }, admin);
  await svc.setSecret(NAME, 'ECHO_TOKEN', 'tok', admin);
  await svc.setEnabled(NAME, true, admin);
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-signed-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${admin}', 'admin', true) ON CONFLICT DO NOTHING`);
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();
});

afterEach(async () => {
  const svc = await import('./service');
  await policy({ requireSignature: false, trusted: [{ name: 'Acme', publicKey: acme.publicKeyPem }] });
  if ((await svc.listPackages()).length > 0) await svc.uninstall(NAME, admin);
});

afterAll(async () => {
  const { getMCPBridge } = await import('@/mcp/bridge');
  await getMCPBridge().disconnect(SERVER);
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('signed plugin packages', () => {
  test('without requireSignature: signed by a trusted key records the publisher; unsigned or unknown installs as unsigned', async () => {
    const svc = await import('./service');
    await policy({ trusted: [{ name: 'Acme', publicKey: acme.publicKeyPem }] });

    const signed = await svc.installFromDirectory(await copyOfFixture(acme.privateKeyPem), admin);
    expect(signed.signedBy).toBe('Acme');
    expect(signed.warnings).toEqual([]);
    expect((await svc.packageView(NAME)).signedBy).toBe('Acme');
    expect((await auditOps('installed')).at(-1)).toMatchObject({ signedBy: 'Acme', keyId: acme.keyId });

    // An upgrade with no signature is unsigned.
    const unsigned = await svc.installFromDirectory(await copyOfFixture(undefined, '1.0.1'), admin, { upgrade: true });
    expect([unsigned.version, unsigned.signedBy, unsigned.warnings]).toEqual(['1.0.1', null, []]);

    // Signed by a key nobody trusts: installed as unsigned, with a warning.
    const unknown = await svc.installFromDirectory(await copyOfFixture(stranger.privateKeyPem, '1.0.2'), admin, { upgrade: true });
    expect(unknown.signedBy).toBeNull();
    expect(unknown.warnings).toEqual([expect.stringContaining(stranger.keyId)]);
    expect((await svc.packageView(NAME)).signedBy).toBeNull();
  });

  test('an invalid signature is always refused; an upgrade keeps the old files and row', async () => {
    const svc = await import('./service');
    await svc.installFromDirectory(await copyOfFixture(acme.privateKeyPem), admin);
    const before = await svc.packageView(NAME);

    const tampered = await copyOfFixture(acme.privateKeyPem, '1.1.0');
    appendFileSync(join(tampered, 'server.mjs'), '\n// changed after signing\n');
    await expect(svc.installFromDirectory(tampered, admin, { upgrade: true })).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/signature .* is invalid/) });
    const after = await svc.packageView(NAME);
    expect([after.version, after.contentHash, after.signedBy]).toEqual([before.version, before.contentHash, 'Acme']);
    expect(readFileSync(join(svc.packageDir(NAME), 'server.mjs'), 'utf8')).not.toContain('changed after signing');

    // A new install with an invalid signature leaves nothing behind.
    await svc.uninstall(NAME, admin);
    const tamperedNew = await copyOfFixture(acme.privateKeyPem);
    appendFileSync(join(tamperedNew, 'server.mjs'), '\n// changed\n');
    await expect(svc.installFromDirectory(tamperedNew, admin)).rejects.toMatchObject({ code: 'invalid' });
    expect(await svc.listPackages()).toEqual([]);
    expect(existsSync(svc.packageDir(NAME))).toBe(false);
  });

  test('with requireSignature: unsigned and unknown keys are refused; a trusted signature installs and runs', async () => {
    const svc = await import('./service');
    await policy({ requireSignature: true });

    await expect(svc.installFromDirectory(await copyOfFixture(), admin)).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/not signed.*requireSignature/) });
    await expect(svc.installFromDirectory(await copyOfFixture(stranger.privateKeyPem), admin)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining(stranger.keyId) });
    expect(await svc.listPackages()).toEqual([]);
    expect(existsSync(svc.packageDir(NAME))).toBe(false);

    await installAndEnable(await copyOfFixture(acme.privateKeyPem));
    const view = await svc.packageView(NAME);
    expect([view.signedBy, view.connected, view.problem]).toEqual(['Acme', true, null]);
  });

  test('with requireSignature, a start without a valid trusted signature is refused (key rotation by config)', async () => {
    const svc = await import('./service');
    const { getMCPBridge } = await import('@/mcp/bridge');
    const bridge = getMCPBridge();
    // Installed while signatures were optional, and unsigned: it ran.
    await installAndEnable(await copyOfFixture());
    expect((await svc.packageView(NAME)).connected).toBe(true);

    await policy({ requireSignature: true });
    await bridge.disconnect(SERVER);
    await svc.syncPluginServers();
    let view = await svc.packageView(NAME);
    expect(view.connected).toBe(false);
    expect(view.problem).toMatch(/not signed.*requireSignature/);
    await bridge.ensureConnected(SERVER);
    expect(await auditOps('signature_refused')).toHaveLength(1);

    // Signed in place: the content hash is unchanged (the signature file is not part of it), so it starts.
    await signPackage(svc.packageDir(NAME), acme.privateKeyPem);
    await bridge.disconnect(SERVER);
    await svc.syncPluginServers();
    view = await svc.packageView(NAME);
    expect([view.connected, view.problem]).toEqual([true, null]);

    // The publisher's key is dropped from the config (rotated out): the next start is refused.
    await policy({ trusted: [{ name: 'Acme (new key)', publicKey: stranger.publicKeyPem }] });
    await bridge.disconnect(SERVER);
    await svc.syncPluginServers();
    view = await svc.packageView(NAME);
    expect(view.connected).toBe(false);
    expect(view.problem).toMatch(/not in plugins\.trustedPublishers/);

    // Enabling again is refused the same way.
    await svc.setEnabled(NAME, false, admin);
    await expect(svc.setEnabled(NAME, true, admin)).rejects.toMatchObject({ code: 'incomplete' });
  });

  test('approving modified content clears signedBy unless the new content is signed', async () => {
    const svc = await import('./service');
    const { hashPackageContent } = await import('./integrity');
    await installAndEnable(await copyOfFixture(acme.privateKeyPem));
    expect((await svc.packageView(NAME)).signedBy).toBe('Acme');

    appendFileSync(join(svc.packageDir(NAME), 'server.mjs'), '\n// local fix\n');
    const actual = await hashPackageContent(svc.packageDir(NAME), { name: NAME, version: '1.0.0' });
    // Under requireSignature, the admin's approval alone is not enough.
    await policy({ requireSignature: true });
    await expect(svc.approveContent(NAME, actual, admin)).rejects.toMatchObject({ code: 'incomplete', message: expect.stringMatching(/signature .* is invalid/) });
    expect((await svc.packageView(NAME)).signedBy).toBe('Acme');

    // Without it, the approval is recorded and the content is no longer the publisher's.
    await policy({ requireSignature: false });
    await svc.approveContent(NAME, actual, admin);
    let view = await svc.packageView(NAME);
    expect([view.contentHash, view.signedBy]).toEqual([actual, null]);
    expect((await auditOps('content_approved')).at(-1)).toMatchObject({ signedBy: null, previousSignedBy: 'Acme' });

    // The publisher signs the new content: approving it records them again.
    await signPackage(svc.packageDir(NAME), acme.privateKeyPem);
    await svc.approveContent(NAME, actual, admin);
    view = await svc.packageView(NAME);
    expect([view.contentHash, view.signedBy, view.connected]).toEqual([actual, 'Acme', true]);
  });
});
