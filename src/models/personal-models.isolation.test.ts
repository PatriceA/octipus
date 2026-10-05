/**
 * Own models (docs/plans/coworking-spec.md §8, S4), against embedded PGlite.
 *
 * Alice owns personal rows — one sharing its provider model id with an
 * install row, one with an id nobody else has, one CLI row — and binds one to
 * the `build` lane. Bob is another user; an admin runs the admin routes. The
 * suite drives the registry, the resolver, the provider boundary, the CLI
 * spawn path and the real routes:
 *   - the same modelId never swaps rows between users;
 *   - personal rows never reach install lists, defaults or topic routing;
 *   - admin model and topic routes refuse them;
 *   - every explicit-name site refuses Alice's model name to Bob;
 *   - keys resolve under the row owner, never the requester;
 *   - CLI runs get the owner's env and per-owner session/quota keys;
 *   - a private endpoint is refused.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Elysia } from '@/api/http';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';
process.env.WORKSPACE_PATH = mkdtempSync(join(tmpdir(), 'octipus-own-models-ws-'));

type ElysiaLike = { handle: (req: Request) => Promise<Response> };
// biome-ignore lint/suspicious/noExplicitAny: JSON bodies
type Json = any;

const aliceId = '31111111-1111-4111-8111-111111111111';
const bobId = '32222222-2222-4222-8222-222222222222';
const adminId = '33333333-3333-4333-8333-333333333333';
const MINE = `u/${aliceId}/mine`;
const SOLO = `u/${aliceId}/solo`;
const CLI = `u/${aliceId}/cli`;
let bobSessionId: string;
let aliceSessionId: string;

// biome-ignore lint/suspicious/noExplicitAny: route plugins
let routes: any[];
// biome-ignore lint/suspicious/noExplicitAny: route plugin
let openaiRoutes: any;
let principalFromUser: typeof import('@/security/principal').principalFromUser;

function appFor(uid: string, isAdmin: boolean): ElysiaLike {
  const app = new Elysia().derive(() => {
    const u = { id: uid, username: uid.slice(0, 8), isAdmin };
    return { user: u, session: null, principal: principalFromUser(u) };
  });
  app.group('/api', (a) => routes.reduce((acc, r) => acc.use(r), a));
  app.group('/v1', (a) => a.use(openaiRoutes));
  return app as unknown as ElysiaLike;
}

async function call(uid: string, isAdmin: boolean, method: string, path: string, body?: unknown) {
  const app = appFor(uid, isAdmin);
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  let parsed: Json = text;
  try { parsed = JSON.parse(text); } catch { /* plain text */ }
  return { status: res.status, body: parsed };
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-own-models-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();
  // Quota state lives in the Postgres-backed KV store.
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { seedSession, seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: aliceId, username: 'alice' },
    { id: bobId, username: 'bob' },
    { id: adminId, username: 'admin', isAdmin: true },
  ]);
  aliceSessionId = (await seedSession({ userId: aliceId })).id;
  bobSessionId = (await seedSession({ userId: bobId })).id;

  const { getModelRegistry } = await import('@/models/model-registry');
  const reg = getModelRegistry();
  await reg.registerModel({
    name: 'install-shared', provider: 'openai', modelId: 'shared-id', isDefault: true,
    topicRoles: { build: 'primary', everyday: 'primary' }, costPerInputToken: 1, costPerOutputToken: 2,
  });
  await reg.registerModel({ name: 'install-backup', provider: 'openai', modelId: 'backup-id', topicRoles: { build: 'backup' } });

  const { createPersonalModel } = await import('@/services/personal-models');
  await createPersonalModel(aliceId, { slug: 'mine', provider: 'openai', modelId: 'shared-id', key: 'sk-alice-mine', topics: ['build'] });
  await createPersonalModel(aliceId, { slug: 'solo', provider: 'deepseek', modelId: 'alice-only-id', key: 'sk-alice-solo' });
  await createPersonalModel(aliceId, { slug: 'cli', provider: 'cli', modelId: 'cli/claude-code', key: 'sk-ant-oat-alice' });
  // A personal row someone tried to make an install binding / default by hand
  // still never routes for anyone (§8.1).
  const { executeRaw } = await import('@/db/postgres');
  await executeRaw(`UPDATE model_config SET topic_roles = '{"research":"primary","verify":"backup"}'::jsonb, topics = ARRAY['research'] WHERE name = '${SOLO}'`);

  const { agentRoutes } = await import('@/api/routes/agents');
  const { modelRoutes } = await import('@/api/routes/models');
  const { topicRoutes } = await import('@/api/routes/topics');
  const { meModelRoutes } = await import('@/api/routes/me-models');
  const { openaiCompatRoutes } = await import('@/api/routes/openai-compat');
  const { evaluationRoutes } = await import('@/api/routes/evaluations');
  routes = [agentRoutes, modelRoutes, topicRoutes, meModelRoutes, evaluationRoutes];
  openaiRoutes = openaiCompatRoutes;
  ({ principalFromUser } = await import('@/security/principal'));
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('model identity (§8.1)', () => {
  test('the same modelId never swaps rows between users', async () => {
    const { getModelRegistry } = await import('@/models/model-registry');
    const reg = getModelRegistry();
    expect((await reg.getModelByModelId('shared-id'))?.name).toBe('install-shared');
    expect((await reg.getModelByModelId('shared-id', { userId: bobId }))?.name).toBe('install-shared');
    expect((await reg.getModelByModelId('shared-id', { userId: aliceId }))?.name).toBe('install-shared');
    // An id only Alice has: hers, and nobody else's.
    expect((await reg.getModelByModelId('alice-only-id', { userId: aliceId }))?.name).toBe(SOLO);
    expect(await reg.getModelByModelId('alice-only-id', { userId: bobId })).toBeNull();
    expect(await reg.getModelByModelId('alice-only-id')).toBeNull();
    // The row identity is the name: Alice's own row is reachable only by it.
    expect((await reg.getModel(MINE))?.ownerUserId).toBe(aliceId);
  });

  test('personal rows never appear in install lists, defaults or topic routing', async () => {
    const { getModelRegistry } = await import('@/models/model-registry');
    const reg = getModelRegistry();
    const names = (rows: { name: string }[]) => rows.map((r) => r.name);
    for (const list of [await reg.getAllModels(), await reg.getAllModelsIncludeDisabled(), await reg.getModelsByProvider('deepseek'), await reg.getModelsByProvider('openai')]) {
      expect(names(list).filter((n) => n.startsWith('u/'))).toEqual([]);
    }
    expect((await reg.getDefaultModel())?.name).toBe('install-shared');
    expect(await reg.getModelForTopic('research')).toBeNull();
    expect(await reg.getBackupModelForTopic('verify')).toBeNull();
    expect(names(await reg.getModelsForUser(aliceId))).toEqual(expect.arrayContaining([MINE, SOLO, CLI, 'install-shared']));
    expect(names(await reg.getModelsForUser(bobId)).filter((n) => n.startsWith('u/'))).toEqual([]);
  });

  test('resolveModel: the owner\'s binding first, install for everyone else and for install lanes', async () => {
    const { resolveModel } = await import('@/models/resolve-model');
    expect((await resolveModel({ userId: aliceId, topic: 'build' }))?.name).toBe(MINE);
    expect((await resolveModel({ userId: aliceId, topic: 'coding' }))?.name).toBe(MINE);
    expect((await resolveModel({ userId: bobId, topic: 'build' }))?.name).toBe('install-shared');
    expect((await resolveModel({ topic: 'build' }))?.name).toBe('install-shared');
    // Backups are the install's; personal bindings have none.
    expect((await resolveModel({ userId: aliceId, topic: 'build', backup: true }))?.name).toBe('install-backup');
  });

  test('a personal row may bind text lanes only', async () => {
    const { updatePersonalModel } = await import('@/services/personal-models');
    for (const topic of ['background', 'embedding', 'vision', 'ocr', 'decision']) {
      await expect(updatePersonalModel(aliceId, 'solo', { topics: [topic] })).rejects.toThrow(/text lanes/);
    }
  });

  test('pricing by modelId considers install rows only', async () => {
    const { getCostTracker } = await import('@/models/cost-tracker');
    const row = await getCostTracker().logUsageWithCost(bobId, 'shared-id', 1_000_000, 0, { lookupByModelId: true });
    expect(row.metadata?.costSource).toBe('estimated');
    expect(row.totalCost).toBe(1);
  });
});

describe('explicit names refuse another user\'s personal model (§8.2)', () => {
  test('resolveModel by name', async () => {
    const { resolveModel } = await import('@/models/resolve-model');
    expect((await resolveModel({ userId: aliceId, name: MINE }))?.name).toBe(MINE);
    expect(await resolveModel({ userId: bobId, name: MINE })).toBeNull();
    expect(await resolveModel({ userId: bobId, name: 'alice-only-id' })).toBeNull();
  });

  test('router.route preferredModel (and its OpenRouter pass-through check)', async () => {
    const { getRouter } = await import('@/core/router');
    await expect(getRouter().route('hi', MINE, { userId: bobId })).rejects.toThrow(/not available/);
    expect((await getRouter().route('hi', MINE, { userId: aliceId })).modelName).toBe(MINE);
  });

  test('POST /api/agents/route preferredModel', async () => {
    const r = await call(bobId, false, 'POST', '/api/agents/route', { message: 'hi', preferredModel: MINE });
    expect(r.body.error).toMatch(/not available/);
  });

  test('POST /api/agents model', async () => {
    const r = await call(bobId, false, 'POST', '/api/agents', { sessionId: bobSessionId, model: MINE });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not available/);
  });

  test('/model <name>', async () => {
    await import('@/core/commands/model');
    const { getCommand } = await import('@/core/commands/registry');
    const cmd = getCommand('model');
    const bob = await cmd!.execute({ sessionId: bobSessionId, userId: bobId, args: MINE, notify: () => {} } as never);
    expect(bob.response).toMatch(/No model named/);
    const alice = await cmd!.execute({ sessionId: aliceSessionId, userId: aliceId, args: MINE, notify: () => {} } as never);
    expect(alice.response).toMatch(/switched/);
    const { getSessionModel } = await import('@/core/agent/session-model-override');
    expect(getSessionModel(aliceSessionId, aliceId)).toBe(MINE);
    expect(getSessionModel(aliceSessionId, bobId)).toBeUndefined();
    const list = await cmd!.execute({ sessionId: bobSessionId, userId: bobId, args: 'list', notify: () => {} } as never);
    expect(list.response).not.toContain('alice-only-id');
  });

  test('pipeline stage model', async () => {
    const { resolveStageModel } = await import('@/core/agent/pipeline-manager');
    const { getModelRegistry } = await import('@/models/model-registry');
    await expect(resolveStageModel({ model: MINE }, 'build', bobId, getModelRegistry())).rejects.toThrow(/no such model/);
    expect(await resolveStageModel({ model: MINE }, 'build', aliceId, getModelRegistry())).toEqual({ modelId: 'shared-id', name: MINE });
    // The stage's lane binding follows its owner.
    expect(await resolveStageModel(undefined, 'build', aliceId, getModelRegistry())).toEqual({ modelId: 'shared-id', name: MINE });
    expect(await resolveStageModel(undefined, 'build', bobId, getModelRegistry())).toEqual({ modelId: 'shared-id', name: 'install-shared' });
  });

  test('swarm executor override', async () => {
    const { __setTopicConfigCacheForTest } = await import('@/models/topic-config');
    __setTopicConfigCacheForTest({ build: { executorModel: MINE, temperature: null, maxTokens: null } });
    try {
      const { SwarmSpawner } = await import('@/core/swarm/spawner');
      // biome-ignore lint/suspicious/noExplicitAny: private method under test
      const resolveChildModel = (SwarmSpawner.prototype as any).resolveChildModel;
      await expect(resolveChildModel.call({}, 'x', 'coding', 'task', false, true, 'build', bobId)).rejects.toThrow(/no such model/);
      const own = await resolveChildModel.call({}, 'x', 'coding', 'task', false, true, 'build', aliceId);
      expect(own.modelName).toBe(MINE);
    } finally {
      __setTopicConfigCacheForTest({});
    }
  });

  test('OpenAI-compatible passthrough and model list', async () => {
    const r = await call(bobId, false, 'POST', '/v1/chat/completions', { model: MINE, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('model_not_found');
    const list = await call(bobId, false, 'GET', '/v1/models');
    expect(list.body.data.map((m: Json) => m.id).filter((id: string) => id.startsWith('u/'))).toEqual([]);
    const own = await call(aliceId, false, 'GET', '/v1/models');
    expect(own.body.data.map((m: Json) => m.id)).toContain(MINE);
  });

  test('evaluations model', async () => {
    const r = await call(bobId, false, 'POST', '/api/evaluations/eval/run', { model: MINE });
    expect(r.body.error).toMatch(/not available/);
  });
});

describe('admin routes refuse personal rows (§8.1)', () => {
  test('model routes', async () => {
    const enc = encodeURIComponent(MINE);
    expect((await call(adminId, true, 'PATCH', `/api/models/${enc}`, { isEnabled: false })).status).toBe(403);
    expect((await call(adminId, true, 'DELETE', `/api/models/${enc}`)).status).toBe(403);
    expect((await call(adminId, true, 'POST', `/api/models/${enc}/default`)).status).toBe(403);
    expect((await call(adminId, true, 'POST', `/api/models/${enc}/check-capabilities`)).status).toBe(403);
    expect((await call(adminId, true, 'GET', `/api/models/${enc}`)).body.error).toBe('Model not found');
    expect((await call(bobId, false, 'GET', `/api/models/${enc}`)).body.error).toBe('Model not found');
    const list = await call(adminId, true, 'GET', '/api/models');
    expect(list.body.models.map((m: Json) => m.name).filter((n: string) => n.startsWith('u/'))).toEqual([]);
    const created = await call(adminId, true, 'POST', '/api/models', { name: `u/${adminId}/x`, provider: 'openai', modelId: 'x' });
    expect(created.status).toBe(400);
    // Still Alice's, still enabled.
    const { getModelRegistry } = await import('@/models/model-registry');
    expect((await getModelRegistry().getModel(MINE))?.isEnabled).toBe(true);
  });

  test('topic binding', async () => {
    const r = await call(adminId, true, 'PUT', '/api/topics/build/binding', { primaryModel: MINE });
    expect(r.status).toBe(403);
  });
});

describe('/api/me/models (§8.4)', () => {
  test('owner-only: list, update and delete are scoped to the caller', async () => {
    const own = await call(aliceId, false, 'GET', '/api/me/models');
    expect(own.body.models.map((m: Json) => m.name).sort()).toEqual([CLI, MINE, SOLO].sort());
    expect(JSON.stringify(own.body)).not.toContain('sk-alice');
    expect((await call(bobId, false, 'GET', '/api/me/models')).body.models).toEqual([]);
    expect((await call(bobId, false, 'PATCH', '/api/me/models/mine', { label: 'x' })).status).toBe(404);
    expect((await call(bobId, false, 'DELETE', '/api/me/models/mine')).status).toBe(404);
  });

  test('the body is an allowlist', async () => {
    const r = await call(bobId, false, 'POST', '/api/me/models', {
      slug: 'evil', provider: 'cli', modelId: 'cli/claude-code', key: 'k',
      metadata: { cliAgent: { inheritApiKeys: true, extraArgs: ['--x'] } },
    });
    expect(r.status).toBe(400);
    expect((await call(bobId, false, 'POST', '/api/me/models', { slug: 'v', provider: 'vertex', modelId: 'm', key: 'k' })).status).toBe(400);
    expect((await call(bobId, false, 'POST', '/api/me/models', { slug: 'v', provider: 'openai', modelId: `u/${aliceId}/mine`, key: 'k' })).status).toBe(400);
  });

  test('a private, loopback or link-local endpoint is refused', async () => {
    for (const endpoint of ['http://127.0.0.1:8080', 'http://10.0.0.5', 'http://169.254.169.254', 'http://localhost:11434', 'http://[::1]/']) {
      const r = await call(bobId, false, 'POST', '/api/me/models', { slug: 'c', provider: 'custom-openai', modelId: 'm', endpoint, key: 'k' });
      expect(r.status, endpoint).toBe(400);
      expect(r.body.error).toMatch(/Endpoint refused/);
    }
  });

  test('the endpoint is re-checked on every request and redirects are not followed', async () => {
    const { personalEndpointFetch } = await import('@/models/providers/custom/base-custom-provider');
    await expect(personalEndpointFetch('http://169.254.169.254/latest/meta-data', {})).rejects.toThrow(/SSRF/);
    // A row whose stored endpoint now points inward (DNS changed, or written
    // before a check) still fails at request time.
    const { executeRaw } = await import('@/db/postgres');
    const { createPersonalModel } = await import('@/services/personal-models');
    await createPersonalModel(bobId, { slug: 'gw', provider: 'custom-openai', modelId: 'gw-model', endpoint: 'https://1.1.1.1', key: 'sk-bob' });
    await executeRaw(`UPDATE model_config SET endpoint = 'http://127.0.0.1:9' WHERE name = 'u/${bobId}/gw'`);
    const { getProviderRouter } = await import('@/models/providers');
    const provider = getProviderRouter().getProviderByName('custom-openai')!;
    const err = await provider.complete({ model: 'gw-model', modelConfigName: `u/${bobId}/gw`, userId: bobId, messages: [{ role: 'user', content: 'hi', timestamp: new Date() }] })
      .then(() => null, (e: unknown) => e);
    // The SDK wraps the refusal as a connection error; the guard's reason is its cause.
    const chain: string[] = [];
    for (let e = err as { message?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) chain.push(String(e.message));
    expect(chain.join(' | ')).toMatch(/SSRF guard/);
  });
});

describe('keys resolve under the row owner (§8.3)', () => {
  test('resolveModelKey reads the owner\'s vault, whoever asks', async () => {
    const { getModelRegistry } = await import('@/models/model-registry');
    const { resolveModelKey } = await import('@/models/model-key');
    expect(await resolveModelKey((await getModelRegistry().getModel(MINE))!)).toBe('sk-alice-mine');
    // An install row never reads a user's vault, even a same-named entry.
    const { getVault } = await import('@/security/vault');
    await getVault().store(bobId, 'install-ref', 'sk-bob-shadow', { credentialType: 'api_key' });
    await getModelRegistry().updateModel('install-backup', { apiKeyRef: 'install-ref' });
    expect(await resolveModelKey((await getModelRegistry().getModel('install-backup'))!)).toBeUndefined();
  });

  test('every instrumented provider receives the owner\'s key for a personal row, and only for it', async () => {
    const { instrumentProvider } = await import('@/models/providers/instrumented');
    const providers = ['anthropic', 'openai', 'deepseek', 'gemini', 'grok', 'mistral', 'moonshot', 'openrouter', 'zai', 'custom-openai', 'custom-anthropic', 'custom-gemini'];
    for (const name of providers) {
      const seen: Array<string | undefined> = [];
      const provider = instrumentProvider({
        name, type: 'direct', supportsModel: () => true,
        complete: async (o: { apiKey?: string; model: string }) => { seen.push(o.apiKey); return { content: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: o.model, latencyMs: 1 }; },
        stream: async function* () { /* unused */ },
        checkHealth: async () => ({ healthy: true }),
      } as never);
      const msg = [{ role: 'user' as const, content: 'hi', timestamp: new Date() }];
      // Bob's request on Alice's row (e.g. a shared turn re-reading the row by name) carries Alice's key.
      await provider.complete({ model: 'shared-id', modelConfigName: MINE, userId: bobId, messages: msg });
      // Bob's request by modelId lands on the install row: no personal key.
      await provider.complete({ model: 'shared-id', userId: bobId, messages: msg });
      // Alice's request by an id only she has resolves her row.
      await provider.complete({ model: 'alice-only-id', userId: aliceId, messages: msg });
      expect(seen, name).toEqual(['sk-alice-mine', undefined, 'sk-alice-solo']);
    }
  });

  test('a personal row without a key fails loud instead of using the install key', async () => {
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw(`UPDATE model_config SET api_key_ref = NULL WHERE name = '${SOLO}'`);
    try {
      const { getLiteLLMClient } = await import('@/models/litellm-client');
      await expect(getLiteLLMClient().complete({ model: 'alice-only-id', modelConfigName: SOLO, userId: aliceId, messages: [{ role: 'user', content: 'hi', timestamp: new Date() }] }))
        .rejects.toThrow(/no API key stored/);
    } finally {
      await executeRaw(`UPDATE model_config SET api_key_ref = 'model-key:${SOLO}' WHERE name = '${SOLO}'`);
    }
  });
});

describe('CLI logins per user (§8.5)', () => {
  test('cliEnvFor: the owner\'s home and token, no server auth', async () => {
    const saved = { ...process.env };
    process.env.ANTHROPIC_API_KEY = 'sk-server';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'server-oauth';
    try {
      const { cliEnvFor } = await import('@/core/cli-child-env');
      const { CLI_TOOLS } = await import('@/models/providers/cli-provider');
      const claude = CLI_TOOLS.find((t) => t.modelPatterns.includes('cli/claude-code'))!;
      const install = cliEnvFor(null, claude, undefined, true);
      expect(install.CLAUDE_CODE_OAUTH_TOKEN).toBe('server-oauth');
      const own = cliEnvFor({ userId: aliceId, token: 'sk-ant-oat-alice' }, claude, { ANTHROPIC_API_KEY: 'sk-tool' }, true);
      expect(own.ANTHROPIC_API_KEY).toBeUndefined();
      expect(own.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat-alice');
      expect(own.HOME).toBe(join(process.env.WORKSPACE_PATH!, 'users', aliceId, 'cli-home'));
      expect(own.CLAUDE_CONFIG_DIR?.startsWith(own.HOME!)).toBe(true);
      expect(own.CODEX_HOME?.startsWith(own.HOME!)).toBe(true);
      const bob = cliEnvFor({ userId: bobId, token: 'sk-ant-oat-bob' }, claude);
      expect(bob.HOME).not.toBe(own.HOME);
    } finally {
      process.env = saved;
    }
  });

  test('the one-shot CLI provider spawns with the row owner\'s env and quota key', async () => {
    const { CLIProvider } = await import('@/models/providers/cli-provider');
    const provider = new CLIProvider();
    let env: Record<string, string> | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: stub the process boundary
    (provider as any).execCli = async (_b: string, _a: string[], opts: { env: Record<string, string> }) => {
      env = opts.env;
      return JSON.stringify({ result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } });
    };
    const msg = [{ role: 'user' as const, content: 'hi', timestamp: new Date() }];
    await provider.complete({ model: 'cli/claude-code', modelConfigName: CLI, userId: aliceId, messages: msg });
    expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat-alice');
    expect(env?.HOME).toContain(join('users', aliceId, 'cli-home'));
    // Alice's exhausted subscription does not block the install's login.
    const { cliQuotaKey, getQuotaTracker } = await import('@/models/quota-tracker');
    await getQuotaTracker().markExhausted(cliQuotaKey('claude-code', { userId: aliceId }));
    await expect(provider.complete({ model: 'cli/claude-code', modelConfigName: CLI, userId: aliceId, messages: msg })).rejects.toThrow(/Quota exhausted/);
    expect((await getQuotaTracker().getStatus('claude-code')).exhausted).toBe(false);
  });

  test('all three spawn sites build their env through cliEnvFor', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of ['src/core/cli-agent-worker.ts', 'src/models/providers/cli-provider.ts', 'src/core/cli-compaction.ts']) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).toMatch(/cliEnvFor\(/);
      expect(src.replace(/export \{ buildChildEnv \}[^\n]*/, ''), file).not.toMatch(/\bbuildChildEnv\(/);
    }
  });

  test('a resume never crosses credential owners', async () => {
    const { loadCliSession, ownedResumeKey, rootCliSessionKey, saveCliSession, cliSessionKeyAdapter, childCliSessionKey } = await import('@/core/cli-session-store');
    const { sessionGeneration } = await import('@/db/schema/sessions');
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const session = await sessionRepository.findById(aliceSessionId);
    const generation = sessionGeneration(session?.context as never);
    const aliceKey = rootCliSessionKey('Claude Code', aliceId);
    const installKey = rootCliSessionKey('Claude Code');
    expect(new Set([aliceKey, installKey, rootCliSessionKey('Claude Code', bobId)]).size).toBe(3);
    expect(cliSessionKeyAdapter(aliceKey)).toBe('Claude Code');
    expect(childCliSessionKey('Claude Code', ownedResumeKey('k', aliceId))).not.toBe(childCliSessionKey('Claude Code', ownedResumeKey('k', bobId)));
    await saveCliSession(aliceSessionId, aliceKey, { id: 'vendor-a', fingerprint: 'fp', lastUsedAt: new Date().toISOString(), generation, credentialOwner: aliceId });
    expect((await loadCliSession(aliceSessionId, aliceKey, 'fp'))?.id).toBe('vendor-a');
    expect(await loadCliSession(aliceSessionId, installKey, 'fp')).toBeNull();
    expect(await loadCliSession(aliceSessionId, rootCliSessionKey('Claude Code', bobId), 'fp')).toBeNull();
  });
});

describe('direct completion callers name their row', () => {
  test('a registry row passed as `model: x.modelId` with messages also passes `modelConfigName`', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.includes('.test.')) files.push(p);
      }
    };
    walk('src');
    const offenders: string[] = [];
    for (const file of files) {
      // Provider internals build wire bodies, not completion options.
      if (file.startsWith(join('src', 'models', 'providers'))) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const m = /^(\s*)model: [\w.?]+\.modelId( \?\? \w+)?,\s*$/.exec(line);
        if (!m) return;
        const indent = m[1].length;
        const depth = (l: string) => l.length - l.trimStart().length;
        let start = i;
        while (start > 0 && lines[start - 1].trim() && depth(lines[start - 1]) >= indent) start--;
        let end = i;
        while (end + 1 < lines.length && (!lines[end + 1].trim() || depth(lines[end + 1]) >= indent)) end++;
        const literal = lines.slice(start, end + 1).join('\n');
        if (/messages|imageBase64/.test(literal) && !literal.includes('modelConfigName')) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
