/**
 * Creator mode end to end (docs/PLUGIN-PACKAGES.md#writing-a-plugin-with-an-agent):
 * an agent writes a template into its workspace and installs it with
 * `plugin_install`.
 *
 * What must hold: only a directory inside the agent's own workspace is taken;
 * only an admin's agent installs; runtime "in-process" is refused; the
 * package is installed disabled and nothing of it runs; the audit row and the
 * package view say an agent wrote it (user and session); an agent upgrades
 * only what an agent installed; and once an admin enables it, the template's
 * server (a real child process over stdio) answers its slash command.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { AgentContext } from '@/core/types';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';
process.env.WORKSPACE_PATH ??= mkdtempSync(join(tmpdir(), 'octipus-authoring-ws-'));

const admin = '33333333-3333-4333-8333-333333333333';
const member = '44444444-4444-4444-8444-444444444444';
const session = '55555555-5555-4555-8555-555555555555';

const ctx = (userId: string): AgentContext => ({ id: 'agent-1', userId, sessionId: '', role: 'general', status: 'running' } as unknown as AgentContext);

/** The agent's workspace root, as the filesystem tool resolves it. */
async function workspaceOf(userId: string): Promise<string> {
  const { filesystemTool } = await import('@/tools/filesystem');
  return filesystemTool.resolveForRead('.', ctx(userId)).root;
}

/** Write a template into the user's workspace under `rel`, renamed, its manifest changed by `change`. */
async function writeTemplate(userId: string, template: string, rel: string, change: (m: Record<string, unknown>) => Record<string, unknown> = (m) => m): Promise<string> {
  const { templatesRoot } = await import('./templates');
  const dir = join(await workspaceOf(userId), rel);
  mkdirSync(dir, { recursive: true });
  cpSync(join(templatesRoot(), template), dir, { recursive: true });
  const file = join(dir, 'octipus-plugin.json');
  writeFileSync(file, JSON.stringify(change(JSON.parse(readFileSync(file, 'utf8')))));
  return dir;
}

async function install(userId: string, path: string, upgrade = false) {
  const { workspacePackageDir, adminPluginsPage } = await import('@/tools/plugin-dev');
  const { installAgentPlugin } = await import('./install');
  return installAgentPlugin({ dir: workspacePackageDir(path, ctx(userId)), userId, sessionId: session, agentId: 'agent-1', upgrade, adminPage: adminPluginsPage() });
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-authoring-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${admin}', 'admin', true) ON CONFLICT DO NOTHING`);
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${member}', 'member', false) ON CONFLICT DO NOTHING`);
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();
});

afterAll(async () => {
  const { disposeAllContributions } = await import('../contributions');
  await disposeAllContributions();
  const { getMCPBridge } = await import('@/mcp/bridge');
  for (const name of ['agent-tools', 'agent-cmd', 'person-made']) await getMCPBridge().disconnect(`plugin-${name}`);
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('plugin_install', () => {
  test('only a directory inside the agent\'s own workspace', async () => {
    const { workspacePackageDir } = await import('@/tools/plugin-dev');
    const outside = mkdtempSync(join(tmpdir(), 'octipus-outside-'));
    expect(() => workspacePackageDir(outside, ctx(admin))).toThrow(/outside allowed workspace|not a directory inside your workspace/);
    expect(() => workspacePackageDir('../../..', ctx(admin))).toThrow();
    expect(() => workspacePackageDir('.', ctx(admin))).toThrow(/not a directory inside your workspace/);
    // Another user's workspace is outside this one's.
    const theirs = await writeTemplate(member, 'tool-only', 'plugins/theirs');
    expect(() => workspacePackageDir(theirs, ctx(admin))).toThrow();
    const mine = await writeTemplate(admin, 'tool-only', 'plugins/mine');
    expect(workspacePackageDir('plugins/mine', ctx(admin))).toBe(mine);
  });

  test('a non-admin\'s agent is refused, and nothing is installed', async () => {
    await writeTemplate(member, 'tool-only', 'plugins/agent-tools', (m) => ({ ...m, name: 'agent-tools' }));
    const result = await install(member, 'plugins/agent-tools');
    expect(result).toMatchObject({ installed: false, error: expect.stringContaining('Only an admin can install plugins') });
    const svc = await import('../service');
    expect(await svc.listPackages()).toEqual([]);
  });

  test('runtime in-process is refused with a clear message', async () => {
    const dir = join(await workspaceOf(admin), 'plugins/inproc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'octipus-plugin.json'), JSON.stringify({ name: 'inproc', version: '1.0.0', apiVersion: '1.0.0', title: 'x', description: 'x', runtime: 'in-process', entry: 'index.mjs' }));
    writeFileSync(join(dir, 'index.mjs'), 'export default () => {};');
    const { IN_PROCESS_REFUSAL } = await import('./validate');
    expect(await install(admin, 'plugins/inproc')).toEqual({ installed: false, error: IN_PROCESS_REFUSAL });
    const svc = await import('../service');
    expect(await svc.listPackages()).toEqual([]);
  });

  test('a package that does not validate is refused with every problem', async () => {
    await writeTemplate(admin, 'tool-only', 'plugins/broken', (m) => ({ ...m, name: 'broken', commands: [{ name: 'x', tool: 'missing', description: 'x' }] }));
    const result = await install(admin, 'plugins/broken');
    expect(result).toMatchObject({ installed: false, problems: [expect.stringContaining('"missing" is not one of the package\'s declared tools')] });
  });

  test('an admin\'s agent installs it disabled, and the audit row and the view say an agent wrote it', async () => {
    const dir = await writeTemplate(admin, 'tool-only', 'plugins/agent-tools', (m) => ({ ...m, name: 'agent-tools' }));
    const { validatePluginDirectory } = await import('./validate');
    const expected = (await validatePluginDirectory(dir)).contentHash;
    const result = await install(admin, 'plugins/agent-tools');
    expect(result).toMatchObject({ installed: true, name: 'agent-tools', enabled: false, upgraded: false, contentHash: expected });
    if (!result.installed) throw new Error('not installed');
    expect(result.review).toContain('/admin/plugins');
    expect(result.review).toContain(expected);

    const svc = await import('../service');
    const view = await svc.packageView('agent-tools');
    expect(view).toMatchObject({ enabled: false, connected: false, contentHash: expected });
    expect(view.authoredBy).toMatchObject({ userId: admin, sessionId: session, agentId: 'agent-1' });
    expect((await svc.listPackages())[0].authoredBy).toMatchObject({ sessionId: session });
    const { getMCPBridge } = await import('@/mcp/bridge');
    expect(getMCPBridge().isConnected('plugin-agent-tools')).toBe(false);

    const { auditRepository } = await import('@/db/repositories/audit-repository');
    const rows = await auditRepository.findByResource('plugin_package', 'agent-tools');
    expect(rows.find((r) => (r.details as { op?: string }).op === 'installed')?.details).toMatchObject({
      op: 'installed', contentHash: expected, authoredBy: { kind: 'agent', userId: admin, sessionId: session, agentId: 'agent-1' },
    });
  });

  test('installing again needs upgrade, which leaves it disabled; a person\'s package is never replaced', async () => {
    expect(await install(admin, 'plugins/agent-tools')).toMatchObject({ installed: false, error: expect.stringContaining('pass upgrade: true') });
    await writeTemplate(admin, 'tool-only', 'plugins/agent-tools', (m) => ({ ...m, name: 'agent-tools', version: '0.2.0' }));
    expect(await install(admin, 'plugins/agent-tools', true)).toMatchObject({ installed: true, upgraded: true, version: '0.2.0', enabled: false });

    // A person installs a package; an agent's package of that name may not replace it.
    const personDir = mkdtempSync(join(tmpdir(), 'octipus-person-'));
    const { templatesRoot } = await import('./templates');
    cpSync(join(templatesRoot(), 'tool-only'), personDir, { recursive: true });
    const m = JSON.parse(readFileSync(join(personDir, 'octipus-plugin.json'), 'utf8'));
    writeFileSync(join(personDir, 'octipus-plugin.json'), JSON.stringify({ ...m, name: 'person-made' }));
    const svc = await import('../service');
    await svc.installFromDirectory(personDir, admin);
    expect((await svc.packageView('person-made')).authoredBy).toBeNull();
    await writeTemplate(admin, 'tool-only', 'plugins/person-made', (x) => ({ ...x, name: 'person-made', version: '9.0.0' }));
    expect(await install(admin, 'plugins/person-made', true)).toMatchObject({ installed: false, error: expect.stringContaining('installed by a person') });
    expect((await svc.packageView('person-made')).version).toBe('0.1.0');
  });

  test('once an admin enables it, the template server runs and its command answers', async () => {
    await writeTemplate(admin, 'with-command', 'plugins/agent-cmd', (m) => ({ ...m, name: 'agent-cmd' }));
    expect(await install(admin, 'plugins/agent-cmd')).toMatchObject({ installed: true, enabled: false });
    const { getCommandRegistry } = await import('@/core/gateway/commands');
    expect(getCommandRegistry().get('wordcount')).toBeUndefined();

    const svc = await import('../service');
    await svc.setEnabled('agent-cmd', true, admin);
    const view = await svc.packageView('agent-cmd');
    expect(view.enabled).toBe(true);
    expect(view.contributions.commands[0]).toMatchObject({ name: 'wordcount', bound: true });
    const answer = await getCommandRegistry().execute('/wordcount three small words', { userId: admin, clientType: 'tui', trustLevel: 'user' });
    expect(answer?.text).toBe('3 words, 17 characters');
    const { getMCPBridge } = await import('@/mcp/bridge');
    expect(getMCPBridge().isConnected('plugin-agent-cmd')).toBe(true);
  });
});
