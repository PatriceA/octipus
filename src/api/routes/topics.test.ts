import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { Elysia } from 'elysia';
import { isIntegration, setupIntegrationDb, truncateTables } from '@/test-helpers/integration';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

// DB-backed: run via `bun run test:integration -- src/api/routes/topics.test.ts`.
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
    const { closeDb } = await import('@/db/postgres');
    await closeDb();
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
    const coding = r.body.topics.find((t: any) => t.value === 'coding');
    expect(coding).toBeDefined();
    expect(coding.kind).toBe('text');
    expect(coding).toHaveProperty('primaryModel');
    expect(coding).toHaveProperty('executorModel');
  });

  test('non-admin cannot PATCH topic config', async () => {
    const r = await send(userApp, 'PATCH', '/api/topics/coding/config', { temperature: 0.1 });
    expect(r.status).toBe(403);
  });

  test('admin PATCH config persists extras and GET reflects them', async () => {
    const r = await send(adminApp, 'PATCH', '/api/topics/coding/config', {
      executorModel: 'model-b',
      temperature: 0.2,
      maxTokens: 2048,
    });
    expect(r.status).toBe(200);
    expect(r.body.executorModel).toBe('model-b');

    const list = await get(adminApp, '/api/topics');
    const coding = list.body.topics.find((t: any) => t.value === 'coding');
    expect(coding.executorModel).toBe('model-b');
    expect(coding.temperature).toBe(0.2);
    expect(coding.maxTokens).toBe(2048);
  });

  test('PATCH config for unknown topic → 404', async () => {
    const r = await send(adminApp, 'PATCH', '/api/topics/not-a-topic/config', { temperature: 0.1 });
    expect(r.status).toBe(404);
  });

  test('admin PUT binding sets primary/backup, GET reflects it', async () => {
    const r = await send(adminApp, 'PUT', '/api/topics/coding/binding', {
      primaryModel: 'model-a',
      backupModel: 'model-b',
    });
    expect(r.status).toBe(200);

    const list = await get(adminApp, '/api/topics');
    const coding = list.body.topics.find((t: any) => t.value === 'coding');
    expect(coding.primaryModel).toBe('model-a');
    expect(coding.backupModel).toBe('model-b');
  });

  test('PUT binding swaps primary to another model (old primary demoted)', async () => {
    await send(adminApp, 'PUT', '/api/topics/coding/binding', { primaryModel: 'model-a' });
    await send(adminApp, 'PUT', '/api/topics/coding/binding', { primaryModel: 'model-b' });
    const list = await get(adminApp, '/api/topics');
    const coding = list.body.topics.find((t: any) => t.value === 'coding');
    expect(coding.primaryModel).toBe('model-b');
  });

  test('PUT binding to an unknown model → 400', async () => {
    const r = await send(adminApp, 'PUT', '/api/topics/coding/binding', { primaryModel: 'ghost-model' });
    expect(r.status).toBe(400);
  });

  test('PUT binding rejects same model as primary and backup → 400', async () => {
    const r = await send(adminApp, 'PUT', '/api/topics/coding/binding', { primaryModel: 'model-a', backupModel: 'model-a' });
    expect(r.status).toBe(400);
  });

  test('PATCH config merges (omitted field keeps current value)', async () => {
    await send(adminApp, 'PATCH', '/api/topics/research/config', { executorModel: 'model-a', temperature: 0.5 });
    // Patch only temperature — executorModel must survive.
    await send(adminApp, 'PATCH', '/api/topics/research/config', { temperature: 0.9 });
    const list = await get(adminApp, '/api/topics');
    const research = list.body.topics.find((t: any) => t.value === 'research');
    expect(research.executorModel).toBe('model-a');
    expect(research.temperature).toBe(0.9);
  });

  test('non-admin cannot PUT binding', async () => {
    const r = await send(userApp, 'PUT', '/api/topics/coding/binding', { primaryModel: 'model-a' });
    expect(r.status).toBe(403);
  });
});
