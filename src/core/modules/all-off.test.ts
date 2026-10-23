/**
 * Every module off (docs/MODULES.md): the core only, as on a new install.
 * Each module route answers 404, no agent is offered or can run a module
 * tool, no module sweep starts, case links to an off module's entities are
 * hidden (and kept), and `/api/modules` says so.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getConfig } from '@/config';
import { MODULES } from '@/modules';

const sweeps = vi.hoisted(() => ({ mail: vi.fn(async () => 0), scan: vi.fn(async () => 0) }));
vi.mock('@/core/mail/sync', () => ({ syncDueMailAccounts: sweeps.mail }));
vi.mock('@/core/scan-folders/sweep', () => ({ scanDueFolders: sweeps.scan }));

const MODULE_TOOLS = MODULES.flatMap((m) => m.tools);
let saved: string[] = [];

beforeEach(() => {
  saved = getConfig().modules.enabled;
  getConfig().modules.enabled = [];
});
afterEach(() => { getConfig().modules.enabled = saved; });

describe('every module off', () => {
  test('module routes answer 404 before authentication; core routes do not', async () => {
    const { createServer } = await import('@/api/server');
    const app = createServer();
    const get = async (path: string) => {
      const res = await app.handle(new Request(`http://test${path}`));
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    for (const m of MODULES) {
      for (const prefix of m.routes) {
        const res = await get(`${prefix}/x`);
        expect(res.status, prefix).toBe(404);
        expect(res.body).toMatchObject({ code: 'module_off', module: m.id });
      }
    }
    // Percent-encoded, as the router decodes it.
    expect((await get('/api/c%61ses/x')).body?.code).toBe('module_off');
    expect((await get('/api/%6D%61il')).body?.code).toBe('module_off');
    // Public forms too: no sign-in needed to be refused.
    expect((await get('/api/forms/sometoken')).body?.code).toBe('module_off');
    // A core route goes on to the rest of the pipeline (here it fails later,
    // on the rate limiter's cache this test does not start).
    expect((await get('/api/notes')).body?.code).not.toBe('module_off');
  });

  test('no agent is offered a module tool, and a handler held from before refuses', async () => {
    const { ToolRegistry } = await import('@/tools/registry');
    const { discoverTools } = await import('@/tools/discovery');
    const { ROLE_CONFIGS } = await import('@/core/agent/roles');
    const registry = new ToolRegistry();
    const wanted = new Set([...MODULE_TOOLS, 'notes']);
    getConfig().modules.enabled = saved;
    for (const { tool } of await discoverTools()) if (wanted.has(tool.id)) await registry.register(tool);
    const held = registry.getToolHandlersForTools(['cases']);
    expect(held.length).toBeGreaterThan(0);
    getConfig().modules.enabled = [];

    const offered = registry.getToolHandlersForTools(ROLE_CONFIGS.general.toolIds).map((h) => h.toolId);
    expect(offered).toContain('notes');
    for (const id of MODULE_TOOLS) expect(offered).not.toContain(id);
    expect(registry.getAllToolHandlers().some((h) => MODULE_TOOLS.includes(h.toolId ?? ''))).toBe(false);
    expect(registry.findTool('cases__list_cases')).toBeUndefined();
    expect(registry.getEnabledManifests().map((m) => m.id)).toEqual(['notes']);
    // Still registered: a role naming it is not taken for a typo.
    expect(registry.get('cases')).toBeDefined();

    const result = await held[0].execute({}, { userId: 'u', agentId: 'a' } as never);
    expect(result).toMatchObject({ error: expect.stringMatching(/switched off/) });
  });

  test('a running worker stops offering a module tool and refuses its call', async () => {
    const { ToolExecutor } = await import('@/core/tool-executor');
    const { messageRepository } = await import('@/db/repositories/message-repository');
    const { auditRepository } = await import('@/db/repositories/audit-repository');
    vi.spyOn(messageRepository, 'create').mockResolvedValue({} as never);
    vi.spyOn(auditRepository, 'log').mockResolvedValue(undefined as never);
    const execute = vi.fn(async () => ({ ok: true }));
    const executor = new ToolExecutor({ id: 'agent-1', userId: 'u', sessionId: 's', status: 'running' } as never, () => {});
    executor.registerTools([
      { name: 'cases__list_cases', description: '', parameters: {}, toolId: 'cases', execute },
      { name: 'notes__list', description: '', parameters: {}, toolId: 'notes', execute },
    ]);
    expect([...executor.getTools().keys()]).toEqual(['notes__list']);
    const [msg] = await executor.handleToolCalls([{ id: 'c1', name: 'cases__list_cases', arguments: {} }]);
    expect(String(msg?.content)).toMatch(/switched off/);
    expect(execute).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  test('no module sweep starts; with the modules on, they do', async () => {
    const { startModuleSweeps } = await import('@/core/cron-runner');
    expect(startModuleSweeps(new Date())).toEqual([]);
    expect(sweeps.mail).not.toHaveBeenCalled();
    expect(sweeps.scan).not.toHaveBeenCalled();
    getConfig().modules.enabled = ['mail', 'scan-folders'];
    expect(startModuleSweeps(new Date())).toEqual(['mail-sync', 'scan-folders']);
    await vi.waitFor(() => expect(sweeps.mail).toHaveBeenCalled());
  });

  test('case links to an off module\'s entity are hidden and kept', async () => {
    const { caseLinks } = await import('@/core/cases/links');
    const pruneDangling = vi.fn(async () => 0);
    const links = [
      { caseId: 'c', entityType: 'mail', entityId: 'm1', role: null },
      { caseId: 'c', entityType: 'task', entityId: 't1', role: null },
    ];
    const repos = {
      cases: { links: async () => links, pruneDangling },
      contacts: { findByIds: async () => [] },
      tasks: { findByIds: async () => [{ id: 't1', title: 'Call back', status: 'open' }] },
      notes: { getByIds: async () => [] },
      mail: { findByIds: vi.fn(async () => []) },
    };
    const resolved = await caseLinks(repos as never, 'c');
    expect(resolved?.map((l) => l.entityType)).toEqual(['task']);
    expect(repos.mail.findByIds).not.toHaveBeenCalled();
    expect(pruneDangling).not.toHaveBeenCalled();
  });

  test('/api/modules reports every module off', async () => {
    const { moduleViews, enabledModules } = await import('./registry');
    expect(enabledModules().size).toBe(0);
    expect(moduleViews().every((m) => !m.on)).toBe(true);
  });
});

describe('a pipeline stage', () => {
  test('naming only an off module\'s tools gets none, never the role\'s whole set', async () => {
    const { narrowToStage } = await import('@/core/agent/worker-spawner');
    const tool = (name: string) => ({ name, description: '', parameters: {}, toolId: name.split('__')[0], execute: async () => null });
    const roleTools = [tool('notes__list'), tool('shell__run')];
    expect(narrowToStage(roleTools, ['cases'], 'general')).toEqual([]);
    expect(narrowToStage(roleTools, ['cases__list_cases'], 'general')).toEqual([]);
    expect(narrowToStage(roleTools, ['cases', 'notes'], 'general').map((t) => t.name)).toEqual(['notes__list']);
    // A plain typo still fails open, as before.
    expect(narrowToStage(roleTools, ['notez'], 'general')).toHaveLength(2);
  });
});

describe('prompts', () => {
  test('no role prompt, nor the delegation table, names an off module\'s tools', async () => {
    const { ROLE_CONFIGS } = await import('@/core/agent/roles');
    const { withoutOffModules } = await import('./prompt');
    const delegation = (await import('@/core/agent/delegation-prompt.md')).default as string;
    const named = /voice__|initiate_call|art_toolbox|artifacts_toolbox|create_live_artifact|search_profiles|add_profile_fact|email-processor|send_to_user|channel_history|`messaging`|`profiles`|`voice`|<!--/;
    for (const cfg of Object.values(ROLE_CONFIGS)) {
      for (const [kind, text] of [['prompt', cfg.systemPromptTemplate], ['lite', cfg.liteSystemPromptTemplate]] as const) {
        if (!text) continue;
        const hit = withoutOffModules(text).split('\n').find((line) => named.test(line));
        expect(hit, `${cfg.role} ${kind}`).toBeUndefined();
      }
    }
    expect(withoutOffModules(delegation).split('\n').find((line) => named.test(line))).toBeUndefined();
  });
});
