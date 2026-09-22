import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'crypto';
import { Elysia } from '@/api/http';
import { isIntegration, setupIntegrationDb, teardownIntegration, truncateTables } from '@/test-helpers/integration';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

// DB-backed: run via `npm run test:integration -- src/api/routes/topics.test.ts`.
describe.skipIf(!isIntegration)('Topics API (Integration)', () => {
  let adminApp: ElysiaLike;
  let userApp: ElysiaLike;
  const adminId = randomUUID();
  const userId = randomUUID();

  beforeAll(async () => {
    await setupIntegrationDb();
    await truncateTables(['topics_config', 'model_config', 'users']);

    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([
      { id: adminId, username: 'root', isAdmin: true },
      { id: userId, username: 'alice', isAdmin: false },
    ]);

    // Two enabled models to bind.
    const { getModelRegistry } = await import('@/models/model-registry');
    const reg = getModelRegistry();
    await reg.registerModel({ name: 'model-a', provider: 'ollama', modelId: 'a', isEnabled: true } as any);
    await reg.registerModel({ name: 'model-b', provider: 'ollama', modelId: 'b', isEnabled: true } as any);
    // A CLI-provider model — no CLI can ever produce embeddings (Guard 1).
    await reg.registerModel({ name: 'model-cli', provider: 'cli', modelId: 'cli/claude', isEnabled: true } as any);

    const { loadTopicConfigs } = await import('@/models/topic-config');
    await loadTopicConfigs();

    const { topicRoutes } = await import('./topics');
    const { ANONYMOUS_PRINCIPAL, principalFromUser } = await import('@/security/principal');

    const buildApp = (uid: string | null, isAdmin: boolean): ElysiaLike =>
      new Elysia()
        .derive(() => {
          if (!uid) return { user: null, session: null, principal: ANONYMOUS_PRINCIPAL };
          const u = { id: uid, username: uid === adminId ? 'root' : 'alice', isAdmin };
          return { user: u, session: null, principal: principalFromUser(u) };
        })
        .group('/api', (a) => a.use(topicRoutes)) as unknown as ElysiaLike;

    adminApp = buildApp(adminId, true);
    userApp = buildApp(userId, false);
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  async function get(app: ElysiaLike, path: string) {
    const res = await app.handle(new Request(`http://localhost${path}`));
    return { status: res.status, body: await res.json() };
  }
  async function send(app: ElysiaLike, method: string, path: string, body: unknown) {
    const res = await app.handle(new Request(`http://localhost${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  test('GET /topics lists canonical topics with binding + extras', async () => {
    const r = await get(adminApp, '/api/topics');
    expect(r.status).toBe(200);
    const build = r.body.topics.find((t: any) => t.value === 'build');
    expect(build).toBeDefined();
    expect(build.kind).toBe('text');
    expect(build).toHaveProperty('primaryModel');
    expect(build).toHaveProperty('executorModel');
  });

  test('non-admin cannot PATCH topic config', async () => {
    const r = await send(userApp, 'PATCH', '/api/topics/build/config', { temperature: 0.1 });
    expect(r.status).toBe(403);
  });

  test('admin PATCH config persists extras and GET reflects them', async () => {
    const r = await send(adminApp, 'PATCH', '/api/topics/build/config', {
      executorModel: 'model-b',
      temperature: 0.2,
      maxTokens: 2048,
    });
    expect(r.status).toBe(200);
    expect(r.body.executorModel).toBe('model-b');

    const list = await get(adminApp, '/api/topics');
    const build = list.body.topics.find((t: any) => t.value === 'build');
    expect(build.executorModel).toBe('model-b');
    expect(build.temperature).toBe(0.2);
    expect(build.maxTokens).toBe(2048);
  });

  test('PATCH config for unknown topic → 404', async () => {
    const r = await send(adminApp, 'PATCH', '/api/topics/not-a-topic/config', { temperature: 0.1 });
    expect(r.status).toBe(404);
  });

  test('admin PUT binding sets primary/backup, GET reflects it', async () => {
    const r = await send(adminApp, 'PUT', '/api/topics/build/binding', {
      primaryModel: 'model-a',
      backupModel: 'model-b',
    });
    expect(r.status).toBe(200);

    const list = await get(adminApp, '/api/topics');
    const build = list.body.topics.find((t: any) => t.value === 'build');
    expect(build.primaryModel).toBe('model-a');
    expect(build.backupModel).toBe('model-b');
  });

  test('PUT binding swaps primary to another model (old primary demoted)', async () => {
    await send(adminApp, 'PUT', '/api/topics/build/binding', { primaryModel: 'model-a' });
    await send(adminApp, 'PUT', '/api/topics/build/binding', { primaryModel: 'model-b' });
    const list = await get(adminApp, '/api/topics');
    const build = list.body.topics.find((t: any) => t.value === 'build');
    expect(build.primaryModel).toBe('model-b');
  });

  test('PUT binding to an unknown model → 400', async () => {
    const r = await send(adminApp, 'PUT', '/api/topics/build/binding', { primaryModel: 'ghost-model' });
    expect(r.status).toBe(400);
  });

  test('PUT binding rejects same model as primary and backup → 400', async () => {
    const r = await send(adminApp, 'PUT', '/api/topics/build/binding', { primaryModel: 'model-a', backupModel: 'model-a' });
    expect(r.status).toBe(400);
  });

  test('PATCH config merges (omitted field keeps current value)', async () => {
    await send(adminApp, 'PATCH', '/api/topics/everyday/config', { executorModel: 'model-a', temperature: 0.5 });
    // Patch only temperature — executorModel must survive.
    await send(adminApp, 'PATCH', '/api/topics/everyday/config', { temperature: 0.9 });
    const list = await get(adminApp, '/api/topics');
    const everyday = list.body.topics.find((t: any) => t.value === 'everyday');
    expect(everyday.executorModel).toBe('model-a');
    expect(everyday.temperature).toBe(0.9);
  });

  test('a retired topic name writes through to its lane', async () => {
    // `agents`, `coding` and `chat` are still in operators' scripts and in
    // plugins. The model registry and the topic-config store have always
    // resolved them; the API used to 404, which made the compatibility promise
    // false exactly where it is easiest to depend on.
    const r = await send(adminApp, 'PUT', '/api/topics/agents/binding', { primaryModel: 'model-a' });
    expect(r.status).toBe(200);
    expect(r.body.topic).toBe('build');

    const cfg = await send(adminApp, 'PATCH', '/api/topics/coding/config', { temperature: 0.42 });
    expect(cfg.status).toBe(200);
    expect(cfg.body.topic).toBe('build');

    const list = await get(adminApp, '/api/topics');
    const build = list.body.topics.find((t: any) => t.value === 'build');
    expect(build.primaryModel).toBe('model-a');
    expect(build.temperature).toBe(0.42);
    // A name that is not a topic at all is still a 404, and the error names
    // what the caller actually sent.
    const bad = await send(adminApp, 'PUT', '/api/topics/not-a-topic/binding', { primaryModel: 'model-a' });
    expect(bad.status).toBe(404);
    expect(bad.body.error).toContain('not-a-topic');
  });

  test('non-admin cannot PUT binding', async () => {
    const r = await send(userApp, 'PUT', '/api/topics/build/binding', { primaryModel: 'model-a' });
    expect(r.status).toBe(403);
  });

  test('PUT binding a CLI-provider model as embedding primary → 400, names model + qualifying providers', async () => {
    const r = await send(adminApp, 'PUT', '/api/topics/embedding/binding', { primaryModel: 'model-cli' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('model-cli');
    expect(r.body.error).toMatch(/embed/i);
    expect(r.body.error).toMatch(/ollama/i);
  });

  test('PUT binding a CLI-provider model as embedding backup → 400', async () => {
    const r = await send(adminApp, 'PUT', '/api/topics/embedding/binding', { primaryModel: 'model-a', backupModel: 'model-cli' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('model-cli');
  });

  test('PUT binding an embed-capable model to embedding topic succeeds', async () => {
    const r = await send(adminApp, 'PUT', '/api/topics/embedding/binding', { primaryModel: 'model-a' });
    expect(r.status).toBe(200);
    const list = await get(adminApp, '/api/topics');
    const embedding = list.body.topics.find((t: any) => t.value === 'embedding');
    expect(embedding.primaryModel).toBe('model-a');
  });

  test('PUT binding a CLI-provider model to a non-embedding topic is unaffected', async () => {
    const r = await send(adminApp, 'PUT', '/api/topics/build/binding', { primaryModel: 'model-cli' });
    expect(r.status).toBe(200);
  });
});
