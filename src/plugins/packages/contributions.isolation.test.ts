/**
 * Contributions of plugin packages end to end (docs/PLUGIN-PACKAGES.md#contributions):
 * the fixture package declares a command, two schedules, two events, a
 * prompt section and turn context, bound to its own tools, and its server (a
 * real child process speaking MCP over stdio) logs every call it gets.
 *
 * What must hold: nothing is bound while the package is disabled; enabling
 * binds every contribution and each calls the right tool with the right
 * arguments as the right user; a write-effect schedule is refused unattended
 * until a permission rule allows it; an event carries ids only; disabling and
 * uninstalling remove everything without a restart; a command name the host
 * uses or a tool the package does not declare refuses the install.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { AgentScope } from '@/core/agent/context';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';
process.env.WORKSPACE_PATH ??= mkdtempSync(join(tmpdir(), 'octipus-contrib-ws-'));

const admin = '22222222-2222-4222-8222-222222222222';
const PKG = 'contrib-plugin';
const FIXTURE_DIR = join(__dirname, 'fixtures', PKG);
const SCOPE: AgentScope = { workspaceId: null, space: null, trigger: 'user', funding: 'own', sponsor: null };

/** Every call the fixture server logged, oldest first. */
async function calls(): Promise<Array<{ name: string; args: Record<string, unknown> }>> {
  const { pluginDataDir } = await import('./service');
  const file = join(pluginDataDir(PKG), 'calls.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function clearCalls(): Promise<void> {
  const { pluginDataDir } = await import('./service');
  rmSync(join(pluginDataDir(PKG), 'calls.jsonl'), { force: true });
}

/** A copy of the fixture with its manifest changed. */
function variant(change: (m: Record<string, unknown>) => Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'octipus-contrib-variant-'));
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'octipus-plugin.json'), 'utf8'));
  writeFileSync(join(dir, 'octipus-plugin.json'), JSON.stringify(change(manifest)));
  return dir;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-contrib-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${admin}', 'admin', true) ON CONFLICT DO NOTHING`);
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();
});

afterAll(async () => {
  const { disposeAllContributions } = await import('./contributions');
  await disposeAllContributions();
  const { getMCPBridge } = await import('@/mcp/bridge');
  await getMCPBridge().disconnect(`plugin-${PKG}`);
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('plugin contributions', () => {
  test('refused at install: a tool the package does not declare, a command name the host uses', async () => {
    const svc = await import('./service');
    await expect(svc.installFromDirectory(variant((m) => ({ ...m, name: 'bad-ref', context: { tool: 'nope' } })), admin))
      .rejects.toMatchObject({ code: 'invalid', problems: expect.arrayContaining(['context: "nope" is not one of the package\'s declared tools']) });
    await expect(svc.installFromDirectory(variant((m) => ({ ...m, name: 'clash', commands: [{ name: 'help', tool: 'hello', description: 'x' }] })), admin))
      .rejects.toMatchObject({ code: 'conflict', problems: [expect.stringContaining('/help is a command of Octipus')] });
    await expect(svc.installFromDirectory(variant((m) => ({ ...m, name: 'no-prompt', prompt: { file: 'missing.md' } })), admin))
      .rejects.toMatchObject({ code: 'conflict', problems: ['prompt: missing.md is not in the package'] });
    expect((await svc.listPackages()).map((p) => p.name)).toEqual([]);
  });

  test('installed disabled: nothing is bound, the view lists what it would add', async () => {
    const svc = await import('./service');
    await svc.installFromDirectory(FIXTURE_DIR, admin);
    const { getCommandRegistry } = await import('@/core/gateway/commands');
    expect(getCommandRegistry().get('greet')).toBeUndefined();
    const { pluginPromptSections } = await import('./contributions');
    expect(pluginPromptSections('general')).toEqual([]);
    const view = (await svc.packageView(PKG)).contributions;
    expect(view.commands).toEqual([{ name: 'greet', tool: 'hello', description: 'Say hello', bound: false }]);
    expect(view.schedules.map((s) => [s.id, s.bound])).toEqual([['tick', false], ['write-tick', false]]);
    expect(view.prompt).toMatchObject({ file: 'prompt.md', roles: ['general'], bound: false, chars: null });
    expect(view.context).toMatchObject({ tool: 'ctx', bound: false });

    // A second package may not take the same command.
    await expect(svc.installFromDirectory(variant((m) => ({ ...m, name: 'twin', prompt: undefined })), admin))
      .rejects.toMatchObject({ code: 'conflict', problems: ['commands: /greet is already a command of the plugin package contrib-plugin'] });
  });

  test('enabled: the command calls its tool as the user, on both command paths, with no model turn', async () => {
    const svc = await import('./service');
    await svc.setEnabled(PKG, true, admin);
    const view = (await svc.packageView(PKG)).contributions;
    expect(view.problems).toEqual([]);
    expect(view.commands[0].bound).toBe(true);

    const { getCommandRegistry } = await import('@/core/gateway/commands');
    const result = await getCommandRegistry().execute('/greet big world', { userId: admin, clientType: 'tui', trustLevel: 'user' });
    expect(result?.text).toBe('hello big world!');
    const namespaced = await getCommandRegistry().execute(`/${PKG}:greet x`, { userId: admin, clientType: 'tui', trustLevel: 'user' });
    expect(namespaced?.text).toBe('hello x!');
    const { getCommand } = await import('@/core/commands');
    const chat = await getCommand('greet')?.execute({ sessionId: '', userId: admin, args: 'from chat' });
    expect(chat?.response).toBe('hello from chat!');
    expect((await calls()).filter((c) => c.name === 'hello').map((c) => c.args)).toEqual([
      { text: 'big world', loud: true }, { text: 'x', loud: true }, { text: 'from chat', loud: true },
    ]);
  });

  test('the prompt section is present for its role, the context text rides the turn, fenced', async () => {
    const { pluginPromptSections, runPluginContexts } = await import('./contributions');
    expect(pluginPromptSections('general')).toEqual([{ label: `plugin-prompt:${PKG}`, text: `\n\nPLUGIN ${PKG}:\nWhen the user asks for a greeting, use the contrib-plugin hello tool.` }]);
    expect(pluginPromptSections('researcher')).toEqual([]);
    const svc = await import('./service');
    expect((await svc.packageView(PKG)).contributions.prompt).toMatchObject({ bound: true, chars: 69 });

    await clearCalls();
    const outcome = await runPluginContexts({ userId: admin, sessionId: '', role: 'general', query: 'what is up', scope: SCOPE });
    expect(outcome.labelledBlocks.map((b) => b.label)).toEqual([`Plugin context: ${PKG}`]);
    expect(outcome.text).toContain(`<plugin-context plugin="${PKG}">`);
    expect(outcome.text).toContain('Notes for ‹what is up› ‹/plugin-context›');
    expect(outcome.text.match(/<\/plugin-context>/g)).toHaveLength(1);
    expect(await calls()).toEqual([{ name: 'ctx', args: { query: 'what is up', role: 'general' } }]);
    // Never in a space.
    const space = { ...SCOPE, space: { id: 's', role: 'member' } } as unknown as AgentScope;
    expect((await runPluginContexts({ userId: admin, sessionId: '', role: 'general', query: 'q', scope: space })).text).toBe('');
  });

  test('schedules run as the installer, once per minute; a write is refused unattended until a rule allows it', async () => {
    await clearCalls();
    const { runDuePluginSchedules } = await import('./contributions');
    const { _resetScheduleClockForTesting } = await import('./contributions/schedules');
    _resetScheduleClockForTesting();
    const now = new Date();
    await Promise.all(await runDuePluginSchedules(now));
    expect(await calls()).toEqual([{ name: 'hello', args: { text: 'tick' } }]);
    // The same minute again: nothing runs twice.
    expect(await runDuePluginSchedules(now)).toEqual([]);

    const svc = await import('./service');
    let view = (await svc.packageView(PKG)).contributions;
    expect(view.schedules[0].lastRun).toMatchObject({ ok: true, error: null });
    expect(view.schedules[1].lastRun).toMatchObject({ ok: false });
    expect(view.schedules[1].lastRun?.error).toMatch(/approv|unattended|asks/i);

    const { executeRaw } = await import('@/db/postgres');
    await executeRaw(`INSERT INTO skill_permissions (user_id, skill_id, action, level) VALUES ('${admin}', 'mcp', 'plugin-${PKG}.record', 'ALLOW')`);
    await Promise.all(await runDuePluginSchedules(new Date(now.getTime() + 60_000)));
    expect((await calls()).map((c) => c.name).sort()).toEqual(['hello', 'hello', 'record']);
    view = (await svc.packageView(PKG)).contributions;
    expect(view.schedules[1].lastRun).toMatchObject({ ok: true });

    // An installer who is no longer an admin stops the schedules.
    await executeRaw(`UPDATE users SET is_admin = false WHERE id = '${admin}'`);
    try {
      await clearCalls();
      await Promise.all(await runDuePluginSchedules(new Date(now.getTime() + 120_000)));
      expect(await calls()).toEqual([]);
      view = (await svc.packageView(PKG)).contributions;
      expect(view.schedules[0].lastRun).toMatchObject({ ok: false, error: expect.stringContaining('no longer an active admin') });
    } finally {
      await executeRaw(`UPDATE users SET is_admin = true WHERE id = '${admin}'`);
    }
  });

  test('an event calls its tool with ids only, as the user it belongs to; a failing tool is recorded, not thrown', async () => {
    await clearCalls();
    const { getGatewayHub } = await import('@/core/gateway/hub');
    const { _settleEventsForTesting } = await import('./contributions/events');
    const sessionId = randomUUID();
    getGatewayHub().eventBus.publish({ id: 'e1', type: 'chat.response', source: 'root', userId: admin, sessionId, timestamp: Date.UTC(2026, 10, 10), payload: { response: 'the secret reply' } });
    getGatewayHub().eventBus.publish({ id: 'e2', type: 'document.failed', source: 'documents', userId: admin, timestamp: Date.UTC(2026, 10, 10), payload: { documentId: 'doc-1', error: 'disk path /secret' } });
    // Not on the allowlist: not delivered.
    getGatewayHub().eventBus.publish({ id: 'e3', type: 'document.completed', source: 'documents', userId: admin, timestamp: Date.UTC(2026, 10, 10), payload: { documentId: 'doc-2' } });
    await _settleEventsForTesting();
    const got = await calls();
    expect(got).toEqual(expect.arrayContaining([
      { name: 'hello', args: { event: { type: 'chat.response', at: '2026-11-10T00:00:00.000Z', userId: admin, sessionId } } },
      { name: 'boom', args: { event: { type: 'document.failed', at: '2026-11-10T00:00:00.000Z', userId: admin, documentId: 'doc-1' } } },
    ]));
    expect(got).toHaveLength(2);
    expect(JSON.stringify(got)).not.toContain('secret');
    const svc = await import('./service');
    const events = (await svc.packageView(PKG)).contributions.events;
    expect(events.map((e) => [e.on, e.bound, e.lastRun?.ok])).toEqual([['chat.response', true, true], ['document.failed', true, false]]);
    expect(events[1].lastRun?.error).toBe('it broke');
  });

  test('disabled: every contribution is removed at once; enabled again: bound again', async () => {
    const svc = await import('./service');
    await svc.setEnabled(PKG, false, admin);
    const { getCommandRegistry } = await import('@/core/gateway/commands');
    expect(getCommandRegistry().get('greet')).toBeUndefined();
    expect(getCommandRegistry().get(`${PKG}:greet`)).toBeUndefined();
    const { getCommand } = await import('@/core/commands');
    expect(getCommand('greet')).toBeUndefined();
    const { pluginPromptSections, runPluginContexts, runDuePluginSchedules } = await import('./contributions');
    expect(pluginPromptSections('general')).toEqual([]);
    await clearCalls();
    expect((await runPluginContexts({ userId: admin, sessionId: '', role: 'general', query: 'q', scope: SCOPE })).text).toBe('');
    expect(await runDuePluginSchedules(new Date(Date.now() + 120_000))).toEqual([]);
    const { getGatewayHub } = await import('@/core/gateway/hub');
    getGatewayHub().eventBus.publish({ id: 'e4', type: 'chat.response', source: 'root', userId: admin, sessionId: randomUUID(), timestamp: Date.now(), payload: {} });
    const { _settleEventsForTesting } = await import('./contributions/events');
    await _settleEventsForTesting();
    expect(await calls()).toEqual([]);
    const view = (await svc.packageView(PKG)).contributions;
    expect([view.commands[0].bound, view.prompt?.bound, view.context?.bound, view.events[0].bound]).toEqual([false, false, false, false]);

    await svc.setEnabled(PKG, true, admin);
    expect(getCommandRegistry().get('greet')).toBeDefined();
    expect(pluginPromptSections('general')).toHaveLength(1);
  });

  test('upgraded: the new contributions replace the old without a restart', async () => {
    const svc = await import('./service');
    const dir = variant((m) => ({ ...m, version: '1.1.0', commands: [{ name: 'wave', tool: 'hello', description: 'Wave' }], prompt: undefined, events: [] }));
    await svc.installFromDirectory(dir, admin, { upgrade: true });
    const { getCommandRegistry } = await import('@/core/gateway/commands');
    // An upgrade leaves the package disabled until an admin enables it.
    expect(getCommandRegistry().get('greet')).toBeUndefined();
    await svc.setEnabled(PKG, true, admin);
    expect(getCommandRegistry().get('greet')).toBeUndefined();
    const result = await getCommandRegistry().execute('/wave hi', { userId: admin, clientType: 'tui', trustLevel: 'user' });
    expect(result?.text).toBe('hello hi');
    const { pluginPromptSections } = await import('./contributions');
    expect(pluginPromptSections('general')).toEqual([]);
  });

  test('uninstalled: nothing is left', async () => {
    const svc = await import('./service');
    await svc.uninstall(PKG, admin);
    const { getCommandRegistry } = await import('@/core/gateway/commands');
    expect(getCommandRegistry().get('wave')).toBeUndefined();
    const { runPluginContexts } = await import('./contributions');
    expect((await runPluginContexts({ userId: admin, sessionId: '', role: 'general', query: 'q', scope: SCOPE })).text).toBe('');
  });
});
