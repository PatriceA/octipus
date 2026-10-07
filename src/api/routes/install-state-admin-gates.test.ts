/**
 * Install-state routes are admin-only. A non-admin account (someone who
 * joined through a space invite, say) gets 403 on the tool, plugin, MCP,
 * capability, gateway, eval and telephony inventories and on the reload /
 * install / direct-execute actions; an admin still gets through. Where a
 * route stays open to members, the install details are dropped from it.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '@/api/http';
import { principalFromUser } from '@/security/principal';

type TestUser = { id: string; username: string; isAdmin: boolean };
const ADMIN: TestUser = { id: '11111111-1111-4111-8111-111111111111', username: 'owner', isAdmin: true };
const MEMBER: TestUser = { id: '22222222-2222-4222-8222-222222222222', username: 'member', isAdmin: false };

const fixture = vi.hoisted(() => ({
  user: null as { id: string; username: string; isAdmin: boolean } | null,
  toolExecute: null as unknown as import('vitest').Mock<(...args: any[]) => any>,
  extensionReload: null as unknown as import('vitest').Mock<(...args: any[]) => any>,
  pluginReload: null as unknown as import('vitest').Mock<(...args: any[]) => any>,
  installWhisper: null as unknown as import('vitest').Mock<(...args: any[]) => any>,
  conformance: null as unknown as import('vitest').Mock<(...args: any[]) => any>,
}));

vi.mock('@/api/context', async () => ({
  apiContext: new (await import('@/api/http')).App().derive(() => ({
    user: fixture.user,
    principal: fixture.user ? principalFromUser(fixture.user) : { kind: 'anonymous' },
  })),
}));

const toolManifest = {
  id: 'github', name: 'GitHub', version: '1', description: 'gh cli', author: 'x',
  permissions: [], tools: [{ name: 'list_prs', description: 'd', parameters: {} }],
};
vi.mock('@/tools/registry', () => ({
  getToolRegistry: () => ({
    getManifests: () => [toolManifest],
    checkAllAvailability: async () => new Map([['github', { available: true }]]),
    checkAvailability: async () => ({ available: true }),
    isInitialized: () => true,
    getAllToolHandlers: () => [{ name: 'github__list_prs', description: 'd', parameters: {}, toolId: 'github' }],
    getToolHandlersForTools: (ids: string[]) => ids.includes('notes') ? [{ name: 'notes__create', description: 'n', parameters: {}, toolId: 'notes' }] : [],
    get: (id: string) => (id === 'github' ? { getManifest: () => toolManifest } : undefined),
    getAll: () => [{ id: 'github', name: 'GitHub', description: 'gh cli' }],
    findTool: () => ({ execute: fixture.toolExecute }),
    has: () => false,
    unregister: async () => {},
    register: async () => {},
  }),
}));
vi.mock('@/extensions/registry', () => ({
  getExtensionRegistry: () => ({ reload: fixture.extensionReload }),
}));
vi.mock('@/core/agent/context', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/core/agent/context')>(),
  withAgentUsage: (_u: string, _s: unknown, fn: () => unknown) => fn(),
}));
vi.mock('@/mcp/bridge', () => ({
  getMCPBridge: () => ({
    getAllTools: () => [{ serverId: 'files', name: 'read', description: 'r', inputSchema: {} }],
    getConnection: (id: string) => (id === 'files' ? { tools: [], resources: [], prompts: [] } : undefined),
    getServerConfigs: () => [],
    getAllConnections: () => [],
  }),
}));
vi.mock('@/plugins', () => ({
  getLoadedPlugins: () => [],
  getLoadedPlugin: (name: string) =>
    name === 'demo'
      ? { manifest: { name: 'demo', version: '1', description: '', author: '', main: 'x', tools: [] }, directory: '/plugins/demo' }
      : undefined,
  reloadPlugin: (...args: unknown[]) => fixture.pluginReload(...args),
  PluginTool: class { constructor(public plugin: unknown) {} },
}));
vi.mock('@/capabilities/service', () => ({
  getCapabilityService: () => ({ list: async () => [] }),
}));
vi.mock('@/core/gateway/hub', () => ({
  getGatewayHub: () => ({
    getStatus: () => ({ ok: true }),
    eventBus: { getStats: () => ({ events: 0 }) },
    connectionManager: { getActiveConnections: () => [] },
  }),
}));
vi.mock('@/channels/interface', () => ({ getUMI: () => ({ getAllChannels: () => [] }) }));
vi.mock('@/voice/whisper', () => ({
  getVoiceAvailability: () => ({
    stt: { available: true, reason: null, local: true, external: false },
    tts: { available: false, reason: 'none' },
  }),
  installWhisper: (...args: unknown[]) => fixture.installWhisper(...args),
  ToolchainMissingError: class extends Error {},
  whisperModelPath: () => '/models/ggml.bin',
}));
vi.mock('@/models/providers/mistral-provider', () => ({ getMistralApiKey: async () => null }));
vi.mock('@/models/providers/openai-provider', () => ({ getOpenAIApiKey: async () => null }));
vi.mock('@/voice/telephony', () => ({
  getCallManager: () => ({ getActive: () => [] }),
  getTelephonyProvider: async () => null,
}));
vi.mock('@/core/rag/health', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/core/rag/health')>(),
  runKBSelfCheck: async () => ({
    ready: false,
    reason: 'vectorWrite: pg error at 10.0.0.5',
    checks: { db: { ok: true }, embeddingModel: { ok: true, modelId: 'nomic' }, vectorWrite: { ok: false, detail: 'pg error' } },
    lastCheckedAt: new Date(0),
  }),
}));

// Model rows: the install has an org model the member is not in; the member
// may use the system model and their own personal one.
const SYSTEM = { id: 'm1', name: 'system-model', modelId: 'sys', isEnabled: true };
const OTHER_ORG = { id: 'm2', name: 'other-org-model', modelId: 'org', isEnabled: true };
const PERSONAL = { id: 'm3', name: 'my-model', modelId: 'mine', isEnabled: true };
const PERSONAL_OFF = { id: 'm4', name: 'my-disabled', modelId: 'off', isEnabled: false };
vi.mock('@/models/model-registry', () => ({
  getModelRegistry: () => ({
    getAllModels: async () => [SYSTEM, OTHER_ORG],
    getModelsForUser: async () => [SYSTEM, PERSONAL, PERSONAL_OFF],
  }),
}));
vi.mock('@/models/testing', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/models/testing')>(),
  runConformanceTests: (...args: unknown[]) => fixture.conformance(...args),
}));
vi.mock('@/models/litellm-client', () => ({ getLiteLLMClient: () => ({}) }));
vi.mock('@/db/repositories/evaluation-repository', () => ({
  evaluationRepository: { saveConformanceRun: async () => ({ id: 'run' }) },
}));

// Search: every DB query answers empty; only the in-memory tool section can match.
vi.mock('@/db/postgres', async (importOriginal) => {
  const chain: Record<string, unknown> = new Proxy({}, {
    get: (_t, key) => (key === 'limit' ? async () => [] : () => chain),
  });
  return { ...await importOriginal<typeof import('@/db/postgres')>(), getDb: () => chain };
});
vi.mock('@/db/repositories/skill-repository', () => ({ skillRepository: { searchVisible: async () => [] } }));
vi.mock('@/core/rag/embeddings', () => ({ getEmbeddingService: () => { throw new Error('no embeddings in test'); } }));

const { toolRoutes } = await import('./tools');
const { pluginRoutes } = await import('./plugins');
const { mcpRoutes } = await import('./mcp');
const { capabilitiesRoutes } = await import('./capabilities');
const { gatewayRoutes } = await import('./gateway');
const { evalRoutes } = await import('./eval');
const { evaluationRoutes } = await import('./evaluations');
const { voiceRoutes } = await import('./voice');
const { knowledgeRoutes } = await import('./knowledge');
const { searchRoutes } = await import('./search');

const app = new App()
  .use(toolRoutes).use(pluginRoutes).use(mcpRoutes).use(capabilitiesRoutes).use(gatewayRoutes)
  .use(evalRoutes).use(evaluationRoutes).use(voiceRoutes).use(knowledgeRoutes).use(searchRoutes);

async function call(method: string, path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://test${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

beforeEach(() => {
  fixture.user = MEMBER;
  fixture.toolExecute = vi.fn(async () => 'ran');
  fixture.extensionReload = vi.fn(async () => ({ count: 2 }));
  fixture.pluginReload = vi.fn(async () => ({ manifest: { name: 'demo', version: '1', tools: [] } }));
  fixture.installWhisper = vi.fn(async () => {});
  fixture.conformance = vi.fn(async () => ({ summary: {}, results: [] }));
});

const GATED: Array<[string, string, unknown?]> = [
  ['GET', '/tools/role-map'],
  ['GET', '/tools/github'],
  ['POST', '/tools/reload', {}],
  ['POST', '/tools/github/tools/list_prs/execute', { args: {} }],
  ['GET', '/plugins'],
  ['GET', '/plugins/demo'],
  ['POST', '/plugins/demo/reload', {}],
  ['GET', '/mcp/tools'],
  ['GET', '/mcp/servers/files/tools'],
  ['GET', '/mcp/servers'],
  ['GET', '/mcp/circuit'],
  ['GET', '/capabilities'],
  ['GET', '/gateway/status'],
  ['GET', '/gateway/connections'],
  ['GET', '/gateway/events/stats'],
  ['GET', '/gateway/adapters'],
  ['GET', '/eval/status'],
  ['GET', '/eval/results'],
  ['GET', '/eval/results/run-1'],
  ['GET', '/eval/compare?ids=a,b'],
  ['GET', '/voice/calls'],
  ['POST', '/voice/install', {}],
  ['GET', '/voice/telephony/health'],
];

describe('install-state routes', () => {
  test.each(GATED)('%s %s → 403 for a non-admin', async (method, path, body) => {
    const res = await call(method, path, body);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Admin access required' });
  });

  test.each(GATED)('%s %s → not refused for an admin', async (method, path, body) => {
    fixture.user = ADMIN;
    const res = await call(method, path, body);
    expect([401, 403]).not.toContain(res.status);
  });

  test.each(GATED)('%s %s → 401 signed out', async (method, path, body) => {
    fixture.user = null;
    expect((await call(method, path, body)).status).toBe(401);
  });

  test('a non-admin cannot reload extensions or plugins, run a tool, or install whisper', async () => {
    await call('POST', '/tools/reload', {});
    await call('POST', '/plugins/demo/reload', {});
    await call('POST', '/tools/github/tools/list_prs/execute', { args: {} });
    await call('POST', '/voice/install', {});
    expect(fixture.extensionReload).not.toHaveBeenCalled();
    expect(fixture.pluginReload).not.toHaveBeenCalled();
    expect(fixture.toolExecute).not.toHaveBeenCalled();
    expect(fixture.installWhisper).not.toHaveBeenCalled();
  });

  test('GET /tools: a non-admin gets only the tools they may run, without status or permissions', async () => {
    const res = await call('GET', '/tools');
    expect(res.status).toBe(200);
    // `github` is not one of the general agent's tools.
    expect(res.body.tools).toEqual([]);
    fixture.user = ADMIN;
    expect((await call('GET', '/tools')).body.tools[0]).toMatchObject({ id: 'github', status: 'active' });
  });

  test('a non-admin runs and lists only the general agent\'s own tools, never MCP', async () => {
    const all = await call('GET', '/tools/all');
    expect(all.status).toBe(200);
    expect(all.body.tools.map((t: { name: string }) => t.name)).toEqual(['notes__create']);
    expect((await call('POST', '/tools/notes/tools/create/execute', { args: {} })).body).toEqual({ result: 'ran' });
    expect((await call('POST', '/tools/mcp_admin/tools/add/execute', { args: {} })).status).toBe(403);
    fixture.user = ADMIN;
    expect((await call('GET', '/tools/all')).body.tools.map((t: { name: string }) => t.name)).toEqual(['github__list_prs', 'read']);
  });

  test('an admin still reloads extensions and runs a tool directly', async () => {
    fixture.user = ADMIN;
    expect((await call('POST', '/tools/reload', {})).body).toEqual({ reloaded: true, extensionCount: 2 });
    expect((await call('POST', '/tools/github/tools/list_prs/execute', { args: {} })).body).toEqual({ result: 'ran' });
  });

  test('the caller still manages their own tool permission overrides', async () => {
    // Not gated: GET /tools/permissions reads only the caller's rows.
    const { getPermissionManager } = await import('@/security/permissions');
    const spy = vi.spyOn(getPermissionManager(), 'getUserPermissions').mockResolvedValue([]);
    const res = await call('GET', '/tools/permissions');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(MEMBER.id);
  });
});

describe('member-visible routes drop install details', () => {
  test('GET /voice/status omits the TTS provider and whisper model path for a non-admin', async () => {
    const res = await call('GET', '/voice/status');
    expect(res.status).toBe(200);
    expect(res.body.sttAvailable).toBe(true);
    expect(res.body).not.toHaveProperty('ttsProvider');
    expect(res.body).not.toHaveProperty('whisperModelPath');

    fixture.user = ADMIN;
    const admin = await call('GET', '/voice/status');
    expect(admin.body).toHaveProperty('ttsProvider');
    expect(admin.body).toHaveProperty('whisperModelPath');
  });

  test('GET /knowledge/readiness gives a non-admin only whether the KB works', async () => {
    const res = await call('GET', '/knowledge/readiness');
    expect(res.status).toBe(503);
    expect(res.body.ready).toBe(false);
    expect(res.body).not.toHaveProperty('checks');
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');

    fixture.user = ADMIN;
    const admin = await call('GET', '/knowledge/readiness');
    expect(admin.status).toBe(503);
    expect(admin.body.checks.vectorWrite.ok).toBe(false);
    expect(admin.body.reason).toContain('10.0.0.5');
  });

  test('GET /search returns no tool section for a non-admin, the tool for an admin', async () => {
    const member = await call('GET', '/search?q=github');
    expect(member.status).toBe(200);
    expect(member.body.results.filter((r: { type: string }) => r.type === 'tool')).toEqual([]);

    fixture.user = ADMIN;
    const admin = await call('GET', '/search?q=github');
    expect(admin.body.results.filter((r: { type: string }) => r.type === 'tool').map((r: { id: string }) => r.id)).toEqual(['github']);
  });
});

describe('POST /evaluations/conformance/run tests only models the caller may use', () => {
  test('a non-admin naming another org’s model finds nothing to test', async () => {
    const res = await call('POST', '/evaluations/conformance/run', { models: ['other-org-model'] });
    expect(res.status).toBe(400);
    expect(fixture.conformance).not.toHaveBeenCalled();
  });

  test('a non-admin gets their enabled visible models, never another org’s', async () => {
    const res = await call('POST', '/evaluations/conformance/run', {});
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual(['system-model', 'my-model']);
  });

  test('an admin tests every install model', async () => {
    fixture.user = ADMIN;
    const res = await call('POST', '/evaluations/conformance/run', {});
    expect(res.body.models).toEqual(['system-model', 'other-org-model']);
  });
});
