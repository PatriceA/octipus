/**
 * In-process plugins end to end (docs/PLUGIN-PACKAGES.md#runtimes): installed,
 * pinned, signed and approved like packages, plus an explicit approval to run
 * in the server process; loaded into the extension system while enabled and
 * approved, and disposed when disabled, uninstalled or upgraded, without a
 * restart.
 *
 * What must hold: install leaves it unapproved and disabled; enabling is
 * refused until `approveInProcess` names the approved content; once enabled
 * its tool and hook are registered, and disabling removes them; an upgrade
 * clears the approval and unloads it; files changed on disk keep it from
 * loading; a revoked key or `requireSignature` stop it as they stop packages;
 * an install that must be signed (a URL) refuses it unsigned, and a signed
 * one still needs the in-process approval.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { generateSigningKey, signPackage } from './signature';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';
process.env.WORKSPACE_PATH ??= mkdtempSync(join(tmpdir(), 'octipus-inproc-ws-'));

const admin = '11111111-1111-4111-8111-111111111111';
const FIXTURE_DIR = join(__dirname, 'fixtures', 'inproc-plugin');
const NAME = 'inproc';
const TOOL_GROUP = 'ext_inproc';

const acme = generateSigningKey();

declare global {
  var __inprocLog: string[] | undefined;
}

/** A copy of the fixture, optionally at another version with another mark, signed with `key` when given. */
async function copyOfFixture(opts: { version?: string; mark?: string; key?: string } = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'octipus-inproc-pkg-'));
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  if (opts.version) {
    const manifest = JSON.parse(readFileSync(join(dir, 'octipus-plugin.json'), 'utf8'));
    manifest.version = opts.version;
    writeFileSync(join(dir, 'octipus-plugin.json'), JSON.stringify(manifest));
  }
  if (opts.mark) {
    writeFileSync(join(dir, 'index.mjs'), readFileSync(join(dir, 'index.mjs'), 'utf8').replace("const MARK = 'v1'", `const MARK = '${opts.mark}'`));
  }
  if (opts.key) await signPackage(dir, opts.key);
  return dir;
}

async function policy(change: { requireSignature?: boolean; revokedKeys?: string[] }): Promise<void> {
  const { getConfig } = await import('@/config');
  const plugins = getConfig().plugins;
  if (change.requireSignature !== undefined) plugins.requireSignature = change.requireSignature;
  if (change.revokedKeys !== undefined) plugins.revokedKeys = change.revokedKeys;
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

async function toolRegistered(): Promise<boolean> {
  const { getToolRegistry } = await import('@/tools/registry');
  return getToolRegistry().has(TOOL_GROUP);
}

async function hooked(): Promise<boolean> {
  const { getAgentHooks } = await import('@/core/agent/hooks');
  return getAgentHooks().has('tool:before');
}

/** Install `dir`, approve it to run in the server process, and enable it. */
async function installApproveEnable(dir: string): Promise<string> {
  const svc = await import('./service');
  const row = await svc.installFromDirectory(dir, admin);
  await svc.approveInProcess(NAME, row.contentHash as string, admin);
  await svc.setEnabled(NAME, true, admin);
  return row.contentHash as string;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-inproc-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${admin}', 'admin', true) ON CONFLICT DO NOTHING`);
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();
  // The extension system is up: in-process plugins load on its event bus.
  const { GatewayEventBus } = await import('@/core/gateway/event-bus');
  const { getExtensionRegistry } = await import('@/extensions/registry');
  getExtensionRegistry(new GatewayEventBus());
});

afterEach(async () => {
  const svc = await import('./service');
  await policy({ requireSignature: false, revokedKeys: [] });
  const { getConfig } = await import('@/config');
  getConfig().plugins.trustedPublishers = [{ name: 'Acme', publicKey: acme.publicKeyPem }];
  if ((await svc.listPackages()).length > 0) await svc.uninstall(NAME, admin);
  globalThis.__inprocLog = [];
});

afterAll(async () => {
  const { disposeInProcessPlugins } = await import('./in-process');
  await disposeInProcessPlugins();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('in-process plugins', () => {
  test('install leaves it disabled and unapproved; enabling is refused until it is approved to run in the server process', async () => {
    const svc = await import('./service');
    const row = await svc.installFromDirectory(await copyOfFixture(), admin);
    expect([row.enabled, row.inProcessApprovedHash]).toEqual([false, null]);
    const hash = row.contentHash as string;

    let view = await svc.packageView(NAME);
    expect(view.runtime).toBe('in-process');
    expect(view.inProcess).toMatchObject({ approved: false, approvedHash: null, loaded: false });
    expect(view.network.detail).toMatch(/server process/);

    await expect(svc.setEnabled(NAME, true, admin)).rejects.toMatchObject({ code: 'incomplete', message: expect.stringMatching(/approveInProcess/) });
    // Only a hash, only the approved content's hash.
    await expect(svc.configure(NAME, { approveInProcess: true }, admin)).rejects.toMatchObject({ code: 'invalid' });
    await expect(svc.approveInProcess(NAME, `sha256:${'0'.repeat(64)}`, admin)).rejects.toMatchObject({ code: 'conflict' });
    expect(await toolRegistered()).toBe(false);

    await svc.approveInProcess(NAME, hash, admin);
    view = await svc.packageView(NAME);
    expect(view.inProcess).toMatchObject({ approved: true, approvedHash: hash, approvedBy: admin, loaded: false });
    expect(await auditOps('in_process_approved')).toEqual([expect.objectContaining({ hash })]);
    // Approved, not enabled: not loaded.
    expect(await toolRegistered()).toBe(false);
  });

  test('a sandboxed package takes no in-process approval', async () => {
    const svc = await import('./service');
    await svc.installFromDirectory(join(__dirname, 'fixtures', 'echo-plugin'), admin);
    try {
      const hash = (await svc.packageView('echo-plugin')).contentHash as string;
      await expect(svc.approveInProcess('echo-plugin', hash, admin)).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/only for runtime "in-process"/) });
      expect((await svc.packageView('echo-plugin')).runtime).toBe('package');
      expect((await svc.packageView('echo-plugin')).inProcess).toBeNull();
    } finally {
      await svc.uninstall('echo-plugin', admin);
    }
  });

  test('enabled and approved, it is loaded: its tool and hook are registered; disabling removes them, enabling loads it again', async () => {
    const svc = await import('./service');
    expect(await hooked()).toBe(false);
    await installApproveEnable(await copyOfFixture());
    await vi.waitFor(async () => expect(await toolRegistered()).toBe(true));
    expect(await hooked()).toBe(true);
    const view = await svc.packageView(NAME);
    expect([view.connected, view.inProcess?.loaded, view.problem]).toEqual([true, true, null]);
    expect(globalThis.__inprocLog).toEqual(['load v1']);

    await svc.setEnabled(NAME, false, admin);
    expect(await toolRegistered()).toBe(false);
    expect(await hooked()).toBe(false);
    expect(globalThis.__inprocLog).toEqual(['load v1', 'dispose v1']);
    expect((await svc.packageView(NAME)).connected).toBe(false);

    // The approval stays with the content: enabling again loads it.
    await svc.setEnabled(NAME, true, admin);
    await vi.waitFor(async () => expect(await toolRegistered()).toBe(true));
    expect(globalThis.__inprocLog).toEqual(['load v1', 'dispose v1', 'load v1']);

    // Uninstall unloads it too.
    await svc.uninstall(NAME, admin);
    expect(await toolRegistered()).toBe(false);
    expect(globalThis.__inprocLog?.at(-1)).toBe('dispose v1');
  });

  test('an upgrade unloads it and clears the approval; the new content loads once approved', async () => {
    const svc = await import('./service');
    const first = await installApproveEnable(await copyOfFixture());
    await vi.waitFor(async () => expect(await toolRegistered()).toBe(true));

    const upgraded = await svc.installFromDirectory(await copyOfFixture({ version: '1.1.0', mark: 'v2' }), admin, { upgrade: true });
    expect(upgraded.contentHash).not.toBe(first);
    expect([upgraded.enabled, upgraded.inProcessApprovedHash]).toEqual([false, null]);
    expect(await toolRegistered()).toBe(false);
    expect(globalThis.__inprocLog).toEqual(['load v1', 'dispose v1']);

    await expect(svc.setEnabled(NAME, true, admin)).rejects.toMatchObject({ code: 'incomplete' });
    // The old approval does not cover the new bytes.
    await expect(svc.approveInProcess(NAME, first, admin)).rejects.toMatchObject({ code: 'conflict' });
    await svc.approveInProcess(NAME, upgraded.contentHash as string, admin);
    await svc.setEnabled(NAME, true, admin);
    await vi.waitFor(async () => expect(await toolRegistered()).toBe(true));
    // The new code runs, without a restart.
    expect(globalThis.__inprocLog).toEqual(['load v1', 'dispose v1', 'load v2']);
  });

  test('files changed on disk keep it from loading; approving the new content clears the in-process approval', async () => {
    const svc = await import('./service');
    const { syncInProcessPlugins } = await import('./in-process');
    const first = await installApproveEnable(await copyOfFixture());
    await vi.waitFor(async () => expect(await toolRegistered()).toBe(true));
    await svc.setEnabled(NAME, false, admin);

    appendFileSync(join(svc.packageDir(NAME), 'index.mjs'), '\n// changed on disk\n');
    // Enabling checks the files first.
    await expect(svc.setEnabled(NAME, true, admin)).rejects.toMatchObject({ code: 'incomplete', message: expect.stringMatching(/hash mismatch/) });

    // A row enabled behind the service's back (a restart, say) is checked before it loads.
    const { getDb } = await import('@/db/postgres');
    const { pluginPackages } = await import('@/db/schema/plugin-packages');
    const { eq } = await import('drizzle-orm');
    await getDb().update(pluginPackages).set({ enabled: true }).where(eq(pluginPackages.name, NAME));
    await syncInProcessPlugins();
    expect(await toolRegistered()).toBe(false);
    let view = await svc.packageView(NAME);
    expect(view.problem).toMatch(/hash mismatch/);
    expect(view.actualHash).toMatch(/^sha256:/);
    expect(await auditOps('content_mismatch')).toHaveLength(1);

    // Approving the new content clears the in-process approval: still not loaded.
    const actual = view.actualHash as string;
    await svc.approveContent(NAME, actual, admin);
    view = await svc.packageView(NAME);
    expect(view.inProcess).toMatchObject({ approved: false, approvedHash: null });
    expect(view.problem).toMatch(/Not approved to run in the server process/);
    expect(await toolRegistered()).toBe(false);
    expect((await auditOps('content_approved')).at(-1)).toMatchObject({ inProcessApprovalCleared: first });

    // Approved again for the new bytes: it loads (it stayed enabled).
    await svc.approveInProcess(NAME, actual, admin);
    await vi.waitFor(async () => expect(await toolRegistered()).toBe(true));
  });

  test('a revoked key stops it; requireSignature refuses it unsigned', async () => {
    const svc = await import('./service');
    const { syncInProcessPlugins } = await import('./in-process');
    await installApproveEnable(await copyOfFixture({ key: acme.privateKeyPem }));
    await vi.waitFor(async () => expect(await toolRegistered()).toBe(true));
    expect((await svc.packageView(NAME)).signedBy).toBe('Acme');

    // Revoked: unloaded on the next sync (disable/enable), and refused from then on.
    await policy({ revokedKeys: [acme.keyId] });
    await svc.setEnabled(NAME, false, admin);
    await expect(svc.setEnabled(NAME, true, admin)).rejects.toMatchObject({ message: expect.stringMatching(/revoked key/) });
    const { getDb } = await import('@/db/postgres');
    const { pluginPackages } = await import('@/db/schema/plugin-packages');
    const { eq } = await import('drizzle-orm');
    await getDb().update(pluginPackages).set({ enabled: true }).where(eq(pluginPackages.name, NAME));
    await syncInProcessPlugins();
    expect(await toolRegistered()).toBe(false);
    expect((await svc.packageView(NAME)).problem).toMatch(/revoked key/);
    await svc.uninstall(NAME, admin);

    await policy({ revokedKeys: [] });
    const row = await svc.installFromDirectory(await copyOfFixture(), admin);
    await policy({ requireSignature: true });
    await expect(svc.approveInProcess(NAME, row.contentHash as string, admin)).rejects.toMatchObject({ message: expect.stringMatching(/requireSignature/) });
  });

  test('an install that must be signed (a URL) refuses it unsigned; signed, it still needs the in-process approval', async () => {
    const svc = await import('./service');
    await expect(svc.installFromDirectory(await copyOfFixture(), admin, { requireTrustedSignature: true }))
      .rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/not signed/) });
    const row = await svc.installFromDirectory(await copyOfFixture({ key: acme.privateKeyPem }), admin, { requireTrustedSignature: true, source: 'https://plugins.example.com/inproc.tgz' });
    expect(row.signedBy).toBe('Acme');
    await expect(svc.setEnabled(NAME, true, admin)).rejects.toMatchObject({ code: 'incomplete', message: expect.stringMatching(/server process/) });
    expect((await auditOps('installed')).at(-1)).toMatchObject({ runtime: 'in-process', signedBy: 'Acme' });
  });

  test('install refuses an entry that is not a file in the package', async () => {
    const svc = await import('./service');
    const dir = await copyOfFixture();
    const manifest = JSON.parse(readFileSync(join(dir, 'octipus-plugin.json'), 'utf8'));
    writeFileSync(join(dir, 'octipus-plugin.json'), JSON.stringify({ ...manifest, entry: 'missing.mjs' }));
    await expect(svc.installFromDirectory(dir, admin)).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/entry: missing\.mjs is not a file/) });
    expect(await svc.listPackages()).toEqual([]);
  });
});
