/**
 * Who may use the install's models (src/models/install-access.ts,
 * docs/SPACES.md → Who may use the install's models), against embedded PGlite.
 *
 * Carol joined without install-model access and owns one personal row; Dave
 * has neither access nor a model; Erin is an ordinary account that has it;
 * the admin always does. The suite drives the registry lists, the resolver,
 * the root model choice, the provider boundary (API and sponsored turns),
 * registration and the admin toggle.
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
process.env.WORKSPACE_PATH = mkdtempSync(join(tmpdir(), 'octipus-install-access-ws-'));

type ElysiaLike = { handle: (req: Request) => Promise<Response> };
// biome-ignore lint/suspicious/noExplicitAny: JSON bodies
type Json = any;

const carolId = '41111111-1111-4111-8111-111111111111';
const daveId = '42222222-2222-4222-8222-222222222222';
const erinId = '43333333-3333-4333-8333-333333333333';
const adminId = '44444444-4444-4444-8444-444444444444';
const OWN = `u/${carolId}/own`;

// biome-ignore lint/suspicious/noExplicitAny: route plugins
let routes: any[];
let principalFromUser: typeof import('@/security/principal').principalFromUser;

async function call(uid: string, isAdmin: boolean, method: string, path: string, body?: unknown) {
  const app = new Elysia().derive(() => {
    const u = { id: uid, username: uid.slice(0, 8), isAdmin };
    return { user: u, session: null, principal: principalFromUser(u) };
  });
  app.group('/api', (a) => routes.reduce((acc, r) => acc.use(r), a));
  const res = await (app as unknown as ElysiaLike).handle(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  let parsed: Json = text;
  try { parsed = JSON.parse(text); } catch { /* plain text */ }
  return { status: res.status, body: parsed };
}

const msg = [{ role: 'user' as const, content: 'hi', timestamp: new Date() }];

function fakeProvider(seen: string[]) {
  return {
    name: 'openai', type: 'direct', supportsModel: () => true,
    complete: async (o: { model: string; modelConfigName?: string }) => {
      seen.push(o.modelConfigName ?? o.model);
      return { content: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: o.model, latencyMs: 1 };
    },
    stream: async function* () { /* unused */ },
    checkHealth: async () => ({ healthy: true }),
  };
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-install-access-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: carolId, username: 'carol' },
    { id: daveId, username: 'dave' },
    { id: erinId, username: 'erin' },
    { id: adminId, username: 'admin', isAdmin: true },
  ]);
  await executeRaw(`UPDATE users SET install_models = false WHERE id IN ('${carolId}', '${daveId}')`);

  const { getModelRegistry } = await import('@/models/model-registry');
  await getModelRegistry().registerModel({
    name: 'install-main', provider: 'openai', modelId: 'install-id', isDefault: true,
    topicRoles: { build: 'primary', everyday: 'primary', background: 'primary' },
  });
  const { createPersonalModel } = await import('@/services/personal-models');
  await createPersonalModel(carolId, { slug: 'own', provider: 'openai', modelId: 'carol-id', key: 'sk-carol' });

  ({ principalFromUser } = await import('@/security/principal'));
  const { modelRoutes } = await import('@/api/routes/models');
  const { adminRoutes } = await import('@/api/routes/admin');
  routes = [modelRoutes, adminRoutes];
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('install-model access', () => {
  test('the flag: admins and allowed accounts may, the others and unknown ids may not', async () => {
    const { mayUseInstallModels, resetInstallAccessCache } = await import('@/models/install-access');
    resetInstallAccessCache();
    expect(await mayUseInstallModels(adminId)).toBe(true);
    expect(await mayUseInstallModels(erinId)).toBe(true);
    expect(await mayUseInstallModels(carolId)).toBe(false);
    expect(await mayUseInstallModels('45555555-5555-4555-8555-555555555555')).toBe(false);
    // Internal callers that serve no account.
    expect(await mayUseInstallModels('system')).toBe(true);
    expect(await mayUseInstallModels(undefined)).toBe(true);
  });

  test('lists: an account without access sees only its own rows', async () => {
    const { getModelRegistry } = await import('@/models/model-registry');
    const reg = getModelRegistry();
    expect((await reg.getModelsForUser(carolId)).map((m) => m.name)).toEqual([OWN]);
    expect(await reg.getModelsForUser(daveId)).toEqual([]);
    expect((await reg.getModelsForUser(erinId)).map((m) => m.name)).toContain('install-main');
    expect(await reg.getModelVisibleTo('install-main', carolId)).toBeNull();
    const res = await call(carolId, false, 'GET', '/api/models');
    expect(res.status).toBe(200);
    expect(res.body.models.map((m: Json) => m.name)).toEqual([OWN]);
  });

  test('resolver: text lanes and names land on their own row, never the install\'s', async () => {
    const { resolveModel } = await import('@/models/resolve-model');
    expect((await resolveModel({ userId: carolId, topic: 'build' }))?.name).toBe(OWN);
    expect(await resolveModel({ userId: daveId, topic: 'build' })).toBeNull();
    expect(await resolveModel({ userId: carolId, name: 'install-main' })).toBeNull();
    expect(await resolveModel({ userId: carolId, name: 'install-id' })).toBeNull();
    expect((await resolveModel({ userId: erinId, topic: 'build' }))?.name).toBe('install-main');
    // Install work keeps its install lane.
    expect((await resolveModel({ userId: carolId, topic: 'background' }))?.name).toBe('install-main');
    // A sponsored turn runs on what the sponsor may use.
    const sponsor = { userId: adminId, models: [] };
    expect((await resolveModel({ userId: daveId, topic: 'build', sponsor }))?.name).toBe('install-main');
  });

  test('root model: their own in place of the install default, a clear error without one', async () => {
    const { ModelSelector } = await import('@/core/agent/model-selector');
    const selector = new ModelSelector();
    expect((await selector.selectForRootAgent(undefined, 'casual', undefined, { userId: carolId })).name).toBe(OWN);
    await expect(selector.selectForRootAgent(undefined, 'casual', undefined, { userId: daveId })).rejects.toThrow(/may not use the install's models/);
    expect((await selector.selectByComplexity('moderate', { userId: carolId })).name).toBe(OWN);
    expect((await selector.selectForRootAgent(undefined, 'casual', undefined, { userId: erinId })).name).toBe('install-main');
  });

  test('provider boundary: an install row or raw id never serves an account without access', async () => {
    const { instrumentProvider, withInstallUsage, withSponsor } = await import('@/models/providers/instrumented');
    const seen: string[] = [];
    const provider = instrumentProvider(fakeProvider(seen) as never);
    await expect(provider.complete({ model: 'install-id', modelConfigName: 'install-main', userId: carolId, messages: msg })).rejects.toThrow(/may not use the install's models/);
    // A raw id with no row would run on the install's env key.
    await expect(provider.complete({ model: 'gpt-anything', userId: carolId, messages: msg })).rejects.toThrow(/may not use the install's models/);
    // Their own row, install work, and a sponsored call whose sponsor may.
    await provider.complete({ model: 'carol-id', modelConfigName: OWN, userId: carolId, messages: msg });
    await withInstallUsage(() => provider.complete({ model: 'install-id', modelConfigName: 'install-main', userId: carolId, messages: msg }));
    await provider.complete({ model: 'install-id', modelConfigName: 'install-main', userId: carolId, requestType: 'embedding', messages: msg });
    await withSponsor({ userId: adminId, models: [] }, () => provider.complete({ model: 'install-id', modelConfigName: 'install-main', userId: daveId, funding: 'sponsor', messages: msg }));
    // A sponsor without access does not lend what they lack.
    await expect(withSponsor({ userId: carolId, models: [] }, () => provider.complete({ model: 'install-id', modelConfigName: 'install-main', userId: daveId, funding: 'sponsor', messages: msg }))).rejects.toThrow(/may not use the install's models/);
    await provider.complete({ model: 'install-id', modelConfigName: 'install-main', userId: erinId, messages: msg });
    expect(seen).toEqual([OWN, 'install-main', 'install-main', 'install-main', 'install-main']);
  });

  test('registration: a self-registered account starts without access unless the install allows it', async () => {
    const { registerUser } = await import('@/security/registration');
    const { getConfig } = await import('@/config');
    const { getDb } = await import('@/db/postgres');
    const { users } = await import('@/db/schema/users');
    const { eq } = await import('drizzle-orm');
    const flag = async (id: string) => (await getDb().select({ v: users.installModels }).from(users).where(eq(users.id, id)))[0].v;
    const off = await registerUser({ username: 'selfreg-off', email: null, password: 'correct horse battery' });
    expect(await flag(off.user.id)).toBe(false);
    const security = getConfig().security as { selfRegisteredInstallModels: boolean };
    security.selfRegisteredInstallModels = true;
    try {
      const on = await registerUser({ username: 'selfreg-on', email: null, password: 'correct horse battery' });
      expect(await flag(on.user.id)).toBe(true);
    } finally {
      security.selfRegisteredInstallModels = false;
    }
  });

  test('admin toggle: takes effect at once and only an admin may flip it', async () => {
    const { mayUseInstallModels } = await import('@/models/install-access');
    expect(await mayUseInstallModels(daveId)).toBe(false);
    expect((await call(erinId, false, 'PATCH', `/api/admin/users/${daveId}`, { installModels: true })).status).toBe(403);
    const res = await call(adminId, true, 'PATCH', `/api/admin/users/${daveId}`, { installModels: true });
    expect(res.status).toBe(200);
    expect(res.body.installModels).toBe(true);
    expect(await mayUseInstallModels(daveId)).toBe(true);
    const list = await call(adminId, true, 'GET', '/api/admin/users');
    expect(list.body.users.find((u: Json) => u.id === carolId).installModels).toBe(false);
  });
});
