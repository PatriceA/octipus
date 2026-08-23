/**
 * Experts API — model-override (`modelPreference`) contract.
 *
 * Root cause of the "can't clear an expert's model override" 422: the UI sends
 * `modelPreference: null` for "use the lane's model", but TypeBox `t.Optional`
 * only admits `undefined`. The schema is now `t.Optional(t.Union([t.String(),
 * t.Null()]))` on both POST and PATCH.
 *
 * The schema tests run without a DB (validation happens before the handler;
 * an unauthenticated request that PASSES validation reaches the handler and
 * gets `{ error: 'Not authenticated' }` instead of a 422). The end-to-end
 * "PATCH null → 200 and cleared" test is DB-backed:
 * `npm run test:integration -- src/api/routes/experts.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'crypto';
import { Elysia } from '@/api/http';
import { isIntegration, setupIntegrationDb, teardownIntegration, truncateTables } from '@/test-helpers/integration';
import { expertRoutes } from './experts';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

async function send(app: ElysiaLike, method: string, path: string, body: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('Experts API — modelPreference schema accepts null', () => {
  // No derived user → handlers return { error: 'Not authenticated' } with a
  // 200, which proves the body PASSED validation (422 = it didn't).
  const app = new Elysia()
    .group('/api', (a) => a.use(expertRoutes)) as unknown as ElysiaLike;

  test('PATCH with modelPreference: null passes validation', async () => {
    const r = await send(app, 'PATCH', '/api/experts/some-id', { modelPreference: null });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ error: 'Not authenticated' });
  });

  test('POST with modelPreference: null passes validation', async () => {
    const r = await send(app, 'POST', '/api/experts', {
      name: 'Tax Advisor',
      role: 'general',
      modelPreference: null,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ error: 'Not authenticated' });
  });

  test('PATCH with a non-string modelPreference is still rejected (422)', async () => {
    const r = await send(app, 'PATCH', '/api/experts/some-id', { modelPreference: 123 });
    expect(r.status).toBe(422);
  });
});

// DB-backed: run via `npm run test:integration -- src/api/routes/experts.test.ts`.
describe.skipIf(!isIntegration)('Experts API (Integration) — clearing the override', () => {
  let userApp: ElysiaLike;
  const userId = randomUUID();

  beforeAll(async () => {
    await setupIntegrationDb();
    // The `experts` schema export maps to the physical `presets` table
    // (see src/db/schema/experts.ts). truncateTables takes physical table
    // names, so 'experts' would raise `relation "experts" does not exist`.
    await truncateTables(['presets', 'users']);

    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: userId, username: 'alice', isAdmin: false }]);

    const { principalFromUser } = await import('@/security/principal');
    const u = { id: userId, username: 'alice', isAdmin: false };
    userApp = new Elysia()
      .derive(() => ({ user: u, session: null, principal: principalFromUser(u) }))
      .group('/api', (a) => a.use(expertRoutes)) as unknown as ElysiaLike;
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  test('PATCH modelPreference: null → 200 and cleared', async () => {
    const created = await send(userApp, 'POST', '/api/experts', {
      name: 'Pinned Expert',
      role: 'general',
      modelPreference: 'deepseek-v4-flash',
    });
    expect(created.status).toBe(200);
    expect(created.body.modelPreference).toBe('deepseek-v4-flash');

    const patched = await send(userApp, 'PATCH', `/api/experts/${created.body.id}`, {
      modelPreference: null,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.modelPreference).toBeNull();
  });
});
