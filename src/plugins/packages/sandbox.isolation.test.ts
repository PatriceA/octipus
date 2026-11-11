/**
 * The plugin sandbox as a boundary (docs/PLUGIN-PACKAGES.md#the-sandbox),
 * against a real database: where `plugins.sandbox` requires a runner (the
 * default, and always for a marketplace package) and none works on the host,
 * a package plugin is not started, cannot be enabled, cannot be agreed to or
 * installed through a consent, and its declarations say why. With the
 * setting off, a local package runs unwrapped and is plainly said to.
 *
 * Backed by ephemeral PGlite. The runner is forced (none, or bwrap).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';
process.env.WORKSPACE_PATH ??= mkdtempSync(join(tmpdir(), 'octipus-sandbox-ws-'));

const admin = '11111111-1111-4111-8111-111111111111';
const FIXTURE_DIR = join(__dirname, 'fixtures', 'echo-plugin');
const NAME = 'echo-plugin';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-sandbox-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${admin}', 'admin', true) ON CONFLICT DO NOTHING`);
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();
});

let setting: 'required' | 'off';
beforeEach(async () => {
  const { getConfig } = await import('@/config');
  setting = getConfig().plugins.sandbox;
  getConfig().plugins.sandbox = 'required';
  const { _forceNoSandboxRunnerForTests } = await import('@/security/shell-sandbox');
  _forceNoSandboxRunnerForTests();
  const svc = await import('./service');
  if (await svc.findRow(NAME)) await svc.uninstall(NAME, admin);
  const row = await svc.installFromDirectory(FIXTURE_DIR, admin);
  await svc.updateSettings(NAME, { region: 'eu' }, admin);
  await svc.setSecret(NAME, 'ECHO_TOKEN', 'tok-1', admin);
  expect(row.enabled).toBe(false);
});

afterEach(async () => {
  const { getConfig } = await import('@/config');
  getConfig().plugins.sandbox = setting;
  const { _resetSandboxDetectionForTests } = await import('@/security/shell-sandbox');
  _resetSandboxDetectionForTests();
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('a sandbox is required and no runner works here', () => {
  test('enabling is refused, naming the missing runner', async () => {
    const svc = await import('./service');
    await expect(svc.setEnabled(NAME, true, admin)).rejects.toThrow(/cannot be enabled\. Not sandboxed on this host.*plugins\.sandbox is required/);
    expect((await svc.findRow(NAME))?.enabled).toBe(false);
  });

  test('the start check refuses it, so a package enabled earlier does not start', async () => {
    const svc = await import('./service');
    expect(await svc.checkPackageBeforeStart(NAME)).toMatch(/^Not sandboxed on this host, so it does not run/);
  });

  test('a consent is refused', async () => {
    const consent = await import('./consent');
    const view = await consent.consentView(NAME);
    const runtime = view.declarations.find((i) => i.id === 'runtime');
    expect(runtime?.label).toBe('NOT sandboxed on this host, so it does not run here');
    await expect(consent.consentToInstalled(NAME, { contentHash: view.contentHash, accepted: view.declarations.map((i) => i.id), enable: true }, admin))
      .rejects.toThrow(/cannot be installed or agreed to here\. Not sandboxed on this host/);
  });

  test('the view says so: network refused, declarations not sandboxed', async () => {
    const svc = await import('./service');
    const view = await svc.packageView(NAME);
    expect(view.network.state).toBe('refused');
    expect(view.declarations.find((i) => i.id === 'runtime')?.guidance).toMatch(/no sandbox runner found/);
  });

  test('the server it would run as requires the sandbox', async () => {
    const svc = await import('./service');
    const row = await svc.findRow(NAME);
    expect((await svc.serverFor(row!)).sandbox?.mode).toBe('required');
  });
});

describe('plugins.sandbox off', () => {
  test('a local package is enabled and runs unwrapped, and is said to', async () => {
    const { getConfig } = await import('@/config');
    getConfig().plugins.sandbox = 'off';
    const svc = await import('./service');
    const row = await svc.findRow(NAME);
    expect((await svc.serverFor(row!)).sandbox?.mode).toBe('off');
    expect(await svc.checkPackageBeforeStart(NAME)).toBeNull();
    const view = await svc.packageView(NAME);
    expect(view.declarations.find((i) => i.id === 'runtime')?.label).toBe('NOT sandboxed on this host');
    expect(view.network.state).toBe('not_enforced');
  });

  test('a marketplace package still requires the sandbox', async () => {
    const { getConfig } = await import('@/config');
    getConfig().plugins.sandbox = 'off';
    const svc = await import('./service');
    const row = await svc.findRow(NAME);
    const marketplace = { ...row!, origin: { source: 'marketplace' as const } };
    expect((await svc.serverFor(marketplace)).sandbox?.mode).toBe('required');
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw(`UPDATE plugin_packages SET origin = '{"source":"marketplace"}'::jsonb WHERE name = '${NAME}'`);
    expect(await svc.checkPackageBeforeStart(NAME)).toMatch(/a plugin from the marketplace always runs in a sandbox/);
    await expect(svc.setEnabled(NAME, true, admin)).rejects.toThrow(/cannot be enabled/);
  });
});
