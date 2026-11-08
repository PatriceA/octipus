/**
 * Plugin packages end to end (docs/PLUGIN-PACKAGES.md): install the fixture
 * package, configure it, enable it, and call its tools through the bridge —
 * a real child process speaking MCP over stdio.
 *
 * What must hold: the package starts disabled and refuses to start without
 * its required configuration; its server sees its settings and secrets and
 * none of the host's secrets; undeclared tools are hidden and refused; an
 * external tool is never waved through (unattended it is blocked, even with
 * an ALLOW rule); uninstall removes files, row and secrets.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { AgentContext } from '@/core/types';

// The protection module, switched per test; every other module as configured.
let protectionOn = false;
vi.mock('@/core/modules/registry', async (original) => {
  const actual = await original<typeof import('@/core/modules/registry')>();
  return { ...actual, isModuleOn: (id: string) => (id === 'protection' ? protectionOn : actual.isModuleOn(id)) };
});

// Content hashing, failing on demand and noting the directories it hashed.
const hashing = vi.hoisted(() => ({ fail: false, dirs: [] as string[] }));
vi.mock('./integrity', async (original) => {
  const actual = await original<typeof import('./integrity')>();
  return {
    ...actual,
    hashPackageContent: async (dir: string, id: { name: string; version: string }) => {
      hashing.dirs.push(dir);
      if (hashing.fail) throw new Error('hashing failed (test)');
      return actual.hashPackageContent(dir, id);
    },
  };
});

/** The audit ops written for the echo package, oldest first. */
async function auditOps(op?: string): Promise<Array<{ op: string; userId: string; details: Record<string, unknown> }>> {
  const { queryRaw } = await import('@/db/postgres');
  const { rows } = await queryRaw(
    `SELECT user_id, details FROM audit_log WHERE resource_type = 'plugin_package' AND resource_id = 'echo-plugin' ORDER BY created_at`,
  );
  return rows
    .map((r: { user_id: string; details: unknown }) => {
      const details = (typeof r.details === 'string' ? JSON.parse(r.details) : r.details) as Record<string, unknown>;
      return { op: String(details.op), userId: r.user_id, details };
    })
    .filter((r: { op: string }) => op === undefined || r.op === op);
}

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';
process.env.WORKSPACE_PATH ??= mkdtempSync(join(tmpdir(), 'octipus-plugins-ws-'));

const admin = '11111111-1111-4111-8111-111111111111';
const FIXTURE_DIR = join(__dirname, 'fixtures', 'echo-plugin');
const SERVER = 'plugin-echo-plugin';

function agentContext(attended: boolean): AgentContext {
  return { id: `agent-${rand(4)}`, userId: admin, sessionId: undefined, role: 'general', status: 'running', attended } as unknown as AgentContext;
}

/** The text of an MCP tool result. */
function textOf(result: unknown): string {
  return ((result as { content: Array<{ text: string }> }).content[0]).text;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-plugins-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${admin}', 'admin', true) ON CONFLICT DO NOTHING`);
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();
});

afterAll(async () => {
  const { getMCPBridge } = await import('@/mcp/bridge');
  await getMCPBridge().disconnect(SERVER);
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('plugin packages', () => {
  test('install starts disabled; enabling needs the required settings and secrets', async () => {
    const svc = await import('./service');
    const row = await svc.installFromDirectory(FIXTURE_DIR, admin);
    expect([row.name, row.version, row.enabled]).toEqual(['echo-plugin', '1.0.0', false]);
    expect(existsSync(join(svc.packageDir('echo-plugin'), 'server.mjs'))).toBe(true);
    await expect(svc.installFromDirectory(FIXTURE_DIR, admin)).rejects.toMatchObject({ code: 'exists' });

    await expect(svc.setEnabled('echo-plugin', true, admin)).rejects.toMatchObject({ code: 'incomplete' });
    await expect(svc.updateSettings('echo-plugin', { region: 'mars' }, admin)).rejects.toMatchObject({ code: 'invalid' });
    await svc.updateSettings('echo-plugin', { region: 'eu' }, admin);
    await expect(svc.setEnabled('echo-plugin', true, admin)).rejects.toThrow(/Echo token/);
    await expect(svc.setSecret('echo-plugin', 'OTHER', 'x', admin)).rejects.toMatchObject({ code: 'invalid' });
    await svc.setSecret('echo-plugin', 'ECHO_TOKEN', 'tok-123', admin);
    const enabled = await svc.setEnabled('echo-plugin', true, admin);
    expect(enabled.enabled).toBe(true);

    const [view] = await svc.listPackages();
    expect(view.secretsSet).toEqual(['ECHO_TOKEN']);
    expect(view.connected).toBe(true);
    expect(view.problem).toBeNull();
    expect(JSON.stringify(view)).not.toContain('tok-123');
  });

  test('the server sees its settings and secrets, and none of the host secrets', async () => {
    const { getMCPBridge } = await import('@/mcp/bridge');
    const report = JSON.parse(textOf(await getMCPBridge().callTool(SERVER, 'env_report', {}, agentContext(false))));
    expect(report.region).toBe('eu');
    expect(report.token).toBe('tok-123');
    for (const secret of ['MASTER_KEY', 'JWT_SECRET', 'SESSION_SECRET', 'DATABASE_URL', 'DATA_DIR', 'WORKSPACE_PATH', 'STORAGE_MODE']) {
      expect(report.names).not.toContain(secret);
    }
    const { packageDir, pluginDataDir } = await import('./service');
    expect(report.cwd).toBe(packageDir('echo-plugin'));
    // Its runtime state goes to a data directory of its own, outside its
    // (read-only under the sandbox, hash-pinned) files; created at start.
    expect(report.names).toContain('OCTIPUS_PLUGIN_DATA_DIR');
    expect(existsSync(pluginDataDir('echo-plugin'))).toBe(true);
    expect(pluginDataDir('echo-plugin').startsWith(packageDir('echo-plugin'))).toBe(false);
    // It declares api.example.com: with the sandbox off it is pointed at the
    // egress proxy (advisory), and the status says network is not enforced.
    expect(report.names).toEqual(expect.arrayContaining(['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY']));
    const { packageView } = await import('./service');
    expect((await packageView('echo-plugin')).network.state).toBe('not_enforced');
  });

  test('only declared tools are listed; an undeclared one is refused', async () => {
    const { getMCPBridge } = await import('@/mcp/bridge');
    const bridge = getMCPBridge();
    const listed = bridge.getAllTools().filter((t) => t.serverId === SERVER);
    expect(listed.filter((t) => t.exposure !== 'hidden').map((t) => t.name).sort()).toEqual(['echo', 'env_report', 'send_letter']);
    expect(listed.find((t) => t.name === 'undeclared_tool')?.exposure).toBe('hidden');
    await expect(bridge.callTool(SERVER, 'undeclared_tool', {}, agentContext(true))).rejects.toThrow(/hidden/);
    expect(textOf(await bridge.callTool(SERVER, 'echo', { text: 'hallo' }, agentContext(false)))).toBe('hallo');
  });

  test('a conversation holding content above the package\'s maxProtection may not call it', async () => {
    const { getMCPBridge } = await import('@/mcp/bridge');
    const { raiseSessionLevel } = await import('@/core/protection/session-level');
    const bridge = getMCPBridge();
    // The fixture declares maxProtection 2. Synthetic session ids: nothing is stored.
    expect(bridge.pluginMaxProtection(SERVER)).toBe(2);
    const at = (level: number) => {
      const sessionId = `plugin-gate-${level}-${rand(4)}`;
      raiseSessionLevel(sessionId, level);
      return { ...agentContext(false), sessionId } as AgentContext;
    };
    protectionOn = true;
    expect(textOf(await bridge.callTool(SERVER, 'echo', { text: 'intern' }, at(2)))).toBe('intern');
    await expect(bridge.callTool(SERVER, 'echo', { text: 'vertraulich' }, at(3))).rejects.toThrow(/protection level 3.*up to level 2/);
    // The same rule for an artifact data source on the package, written now and refreshed later.
    const { pluginProtectionRefusal } = await import('@/security/mcp-authorization');
    expect(await pluginProtectionRefusal(at(3).sessionId, SERVER)).toMatch(/level 3/);
    expect(await pluginProtectionRefusal(at(2).sessionId, SERVER)).toBeUndefined();
    expect(await pluginProtectionRefusal(at(4).sessionId, 'operator-server')).toBeUndefined();
    // With the module off, levels decide nothing.
    protectionOn = false;
    expect(textOf(await bridge.callTool(SERVER, 'echo', { text: 'aus' }, at(4)))).toBe('aus');
  });

  test('an external tool is never waved through, even with an ALLOW rule', async () => {
    const { getMCPBridge } = await import('@/mcp/bridge');
    const { getPermissionManager } = await import('@/security/permissions');
    const bridge = getMCPBridge();
    await expect(bridge.callTool(SERVER, 'send_letter', {}, agentContext(false))).rejects.toThrow(/send_letter/);
    await getPermissionManager().setPermission(admin, 'mcp', `${SERVER}.send_letter`, 'ALLOW');
    await expect(bridge.callTool(SERVER, 'send_letter', {}, agentContext(false))).rejects.toThrow(/send_letter/);
    // A DENY rule still denies.
    await getPermissionManager().setPermission(admin, 'mcp', `${SERVER}.send_letter`, 'DENY');
    await expect(bridge.callTool(SERVER, 'send_letter', {}, agentContext(false))).rejects.toThrow(/denied/i);
  });

  test('a required secret cannot be removed while enabled; a refused enable saves nothing', async () => {
    const svc = await import('./service');
    await expect(svc.setSecret('echo-plugin', 'ECHO_TOKEN', null, admin)).rejects.toMatchObject({ code: 'incomplete' });
    await svc.setEnabled('echo-plugin', false, admin);
    await svc.setSecret('echo-plugin', 'ECHO_TOKEN', '   ', admin);
    await expect(svc.configure('echo-plugin', { settings: { region: 'us' }, enabled: true }, admin)).rejects.toMatchObject({ code: 'incomplete' });
    expect((await svc.packageView('echo-plugin')).settings).toEqual({ region: 'eu' });
    await svc.setSecret('echo-plugin', 'ECHO_TOKEN', 'tok-123', admin);
    await svc.setEnabled('echo-plugin', true, admin);
  });

  test('an upgrade keeps the settings the new version still accepts and is disabled until enabled', async () => {
    const svc = await import('./service');
    const { cpSync, readFileSync, writeFileSync } = await import('node:fs');
    const v2 = mkdtempSync(join(tmpdir(), 'octipus-plugin-v2-'));
    cpSync(FIXTURE_DIR, v2, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(v2, 'octipus-plugin.json'), 'utf8'));
    manifest.version = '1.1.0';
    manifest.settings.push({ key: 'account', label: 'Account', type: 'text', required: true });
    writeFileSync(join(v2, 'octipus-plugin.json'), JSON.stringify(manifest));
    hashing.dirs.length = 0;
    const row = await svc.installFromDirectory(v2, admin, { upgrade: true });
    expect([row.version, row.enabled, row.settings]).toEqual(['1.1.0', false, { region: 'eu' }]);
    // Hashed in the staging copy before the swap, and the same as the installed files.
    expect(hashing.dirs).toHaveLength(1);
    expect(hashing.dirs[0]).toContain('echo-plugin.installing-');
    const { hashPackageContent } = await import('./integrity');
    expect(row.contentHash).toBe(await hashPackageContent(svc.packageDir('echo-plugin'), { name: 'echo-plugin', version: '1.1.0' }));
    await expect(svc.setEnabled('echo-plugin', true, admin)).rejects.toThrow(/Account/);
    await svc.configure('echo-plugin', { settings: { account: 'A-1' }, enabled: true }, admin);
    expect((await svc.packageView('echo-plugin')).connected).toBe(true);
  });

  test('a package modified since it was approved does not start until its content is approved', async () => {
    const svc = await import('./service');
    const { getMCPBridge } = await import('@/mcp/bridge');
    const { appendFileSync } = await import('node:fs');
    const bridge = getMCPBridge();
    const approved = (await svc.packageView('echo-plugin')).contentHash;
    expect(approved).toMatch(/^sha256:[0-9a-f]{64}$/);

    appendFileSync(join(svc.packageDir('echo-plugin'), 'server.mjs'), '\n// changed after approval\n');
    // A restart: the next start checks the files.
    await bridge.disconnect(SERVER);
    await svc.syncPluginServers();
    let view = await svc.packageView('echo-plugin');
    expect(view.connected).toBe(false);
    expect(view.enabled).toBe(true);
    expect(view.problem).toMatch(/modified since it was approved \(hash mismatch\)/i);
    expect(view.contentHash).toBe(approved);
    // The view shows what the files hash to now, to review and approve.
    const { hashPackageContent } = await import('./integrity');
    const actual = await hashPackageContent(svc.packageDir('echo-plugin'), { name: 'echo-plugin', version: view.version });
    expect(view.actualHash).toBe(actual);
    expect(view.actualHash).not.toBe(approved);
    // An on-demand reconnect is refused the same way, and audited only once.
    await bridge.ensureConnected(SERVER);
    await bridge.ensureConnected(SERVER);
    expect(bridge.isConnected(SERVER)).toBe(false);
    const mismatches = await auditOps('content_mismatch');
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].userId).toBe('system');
    expect(mismatches[0].details).toMatchObject({ recorded: approved, actual });
    // Enabling again does not accept the new content either.
    await svc.setEnabled('echo-plugin', false, admin);
    await expect(svc.setEnabled('echo-plugin', true, admin)).rejects.toThrow(/hash mismatch: recorded sha256:[0-9a-f]{64}, actual sha256:/);

    // Approval takes the reviewed hash, not true, and only while the files still hash to it.
    await expect(svc.configure('echo-plugin', { approveContent: true, enabled: true }, admin)).rejects.toMatchObject({ code: 'invalid' });
    appendFileSync(join(svc.packageDir('echo-plugin'), 'server.mjs'), '\n// changed after review\n');
    await expect(svc.configure('echo-plugin', { approveContent: actual, enabled: true }, admin)).rejects.toMatchObject({ code: 'conflict' });
    expect((await svc.packageView('echo-plugin')).contentHash).toBe(approved);
    expect(await auditOps('content_approved')).toHaveLength(0);

    const reviewed = await hashPackageContent(svc.packageDir('echo-plugin'), { name: 'echo-plugin', version: view.version });
    await svc.configure('echo-plugin', { approveContent: reviewed, enabled: true }, admin);
    view = await svc.packageView('echo-plugin');
    expect(view.connected).toBe(true);
    expect(view.problem).toBeNull();
    expect(view.actualHash).toBeNull();
    expect(view.contentHash).toBe(reviewed);
    expect((await auditOps('content_approved')).map((a) => a.details)).toEqual([expect.objectContaining({ from: approved, to: reviewed })]);
  });

  test('a package installed before pinning records its hash on first start', async () => {
    const svc = await import('./service');
    const { getMCPBridge } = await import('@/mcp/bridge');
    const { executeRaw } = await import('@/db/postgres');
    const { hashPackageContent } = await import('./integrity');
    await executeRaw(`UPDATE plugin_packages SET content_hash = NULL WHERE name = 'echo-plugin'`);
    expect((await svc.packageView('echo-plugin')).contentHash).toBeNull();
    await getMCPBridge().disconnect(SERVER);
    await svc.syncPluginServers();
    const view = await svc.packageView('echo-plugin');
    expect(view.connected).toBe(true);
    expect(view.contentHash).toBe(await hashPackageContent(svc.packageDir('echo-plugin'), { name: 'echo-plugin', version: view.version }));
    const pinned = await auditOps('content_pinned_first_use');
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toMatchObject({ userId: 'system', details: { hash: view.contentHash, version: view.version } });
    // A later start finds the hash recorded: no second row.
    await getMCPBridge().disconnect(SERVER);
    await svc.syncPluginServers();
    expect((await svc.packageView('echo-plugin')).connected).toBe(true);
    expect(await auditOps('content_pinned_first_use')).toHaveLength(1);
  });

  test('an upgrade whose files cannot be hashed leaves the old files and row together', async () => {
    const svc = await import('./service');
    const { cpSync, readdirSync, readFileSync, writeFileSync } = await import('node:fs');
    const before = await svc.packageView('echo-plugin');
    const v3 = mkdtempSync(join(tmpdir(), 'octipus-plugin-v3-'));
    cpSync(svc.packageDir('echo-plugin'), v3, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(v3, 'octipus-plugin.json'), 'utf8'));
    manifest.version = '1.2.0';
    writeFileSync(join(v3, 'octipus-plugin.json'), JSON.stringify(manifest));
    writeFileSync(join(v3, 'server.mjs'), 'process.exit(3)\n');
    hashing.fail = true;
    try {
      await expect(svc.installFromDirectory(v3, admin, { upgrade: true })).rejects.toThrow(/hashing failed/);
    } finally {
      hashing.fail = false;
    }
    const after = await svc.packageView('echo-plugin');
    expect([after.version, after.contentHash, after.enabled]).toEqual([before.version, before.contentHash, before.enabled]);
    expect(JSON.parse(readFileSync(join(svc.packageDir('echo-plugin'), 'octipus-plugin.json'), 'utf8')).version).toBe(before.version);
    expect(readFileSync(join(svc.packageDir('echo-plugin'), 'server.mjs'), 'utf8')).not.toContain('process.exit(3)');
    expect(readdirSync(svc.pluginsRoot())).toEqual(['echo-plugin']);
    // The old row still pins the old files: it enables and starts.
    await svc.setEnabled('echo-plugin', true, admin);
    expect((await svc.packageView('echo-plugin')).connected).toBe(true);
  });

  test('an operator MCP config claiming a plugin id is never used for the package', async () => {
    const { getMCPBridge } = await import('@/mcp/bridge');
    const bridge = getMCPBridge();
    // As if stored by hand in mcp.servers: the bridge refuses to start it, and
    // the package's declarations stay the ones in force.
    await expect(bridge.connect({ id: 'plugin-echo-plugin', name: 'impostor', command: 'node', isEnabled: true })).rejects.toThrow(/belongs to plugin packages/);
    expect(bridge.pluginToolEffect(SERVER, 'send_letter')).toBe('external');
    expect(bridge.pluginToolEffect(SERVER, 'undeclared_tool')).toBe('undeclared');
  });

  test('the bridge keeps plugin servers out of the operator configuration', async () => {
    const { getMCPBridge } = await import('@/mcp/bridge');
    const bridge = getMCPBridge();
    expect(bridge.getServerConfigs().some((s) => s.id === SERVER)).toBe(false);
    await expect(bridge.addServer({ id: 'plugin-fake', name: 'x', command: 'node', isEnabled: true })).rejects.toThrow(/belong to plugin packages/);
  });

  test('disable stops the server; uninstall removes files, data, row and secrets', async () => {
    const svc = await import('./service');
    const { getMCPBridge } = await import('@/mcp/bridge');
    const { getVault } = await import('@/security/vault');
    await svc.setEnabled('echo-plugin', false, admin);
    expect(getMCPBridge().isConnected(SERVER)).toBe(false);
    await svc.uninstall('echo-plugin', admin);
    expect(existsSync(svc.packageDir('echo-plugin'))).toBe(false);
    expect(existsSync(svc.pluginDataDir('echo-plugin'))).toBe(false);
    expect(await svc.listPackages()).toEqual([]);
    expect(await getVault().getSystemSecret(svc.secretName('echo-plugin', 'ECHO_TOKEN'))).toBeNull();
    await expect(svc.uninstall('echo-plugin', admin)).rejects.toMatchObject({ code: 'not_found' });
  });
});
