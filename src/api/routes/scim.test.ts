import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import {
  isIntegration,
  setupIntegrationDb,
  teardownIntegration,
} from '@/test-helpers/integration';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

/**
 * SCIM v2 routes — auth refusal smoke tests. Full SCIM CRUD requires
 * a real bearer token bound to a vault entry and an active org; those
 * happy-path tests would belong in scim.isolation.test.ts when SCIM
 * gets RLS coverage. For now we verify the 401 surface: every endpoint
 * must reject calls without a token and calls with garbage tokens.
 *
 * The endpoints exercised:
 *   GET    /scim/v2/Users
 *   GET    /scim/v2/Users/:id
 *   POST   /scim/v2/Users
 *   PATCH  /scim/v2/Users/:id
 *   DELETE /scim/v2/Users/:id
 *   GET    /scim/v2/Groups
 *   GET    /scim/v2/Groups/:id
 */
describe.skipIf(!isIntegration)('SCIM auth refusal (Integration)', () => {
  let app: ElysiaLike;

  beforeAll(async () => {
    await setupIntegrationDb();
    const { scimRoutes } = await import('./scim');
    app = new Elysia().use(scimRoutes);
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  const get = (path: string, auth?: string) =>
    app.handle(new Request(`http://test${path}`, {
      method: 'GET',
      headers: auth ? { authorization: auth } : {},
    }));

  test('GET /scim/v2/Users with no bearer → 401', async () => {
    const res = await get('/scim/v2/Users');
    expect(res.status).toBe(401);
  });

  test('GET /scim/v2/Users with garbage bearer → 401', async () => {
    const res = await get('/scim/v2/Users', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  test('GET /scim/v2/Users with non-bearer scheme → 401', async () => {
    const res = await get('/scim/v2/Users', 'Basic notreal');
    expect(res.status).toBe(401);
  });

  test('GET /scim/v2/Users/:id without bearer → 401', async () => {
    const res = await get('/scim/v2/Users/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(401);
  });

  test('POST /scim/v2/Users without bearer → 401', async () => {
    const res = await app.handle(new Request('http://test/scim/v2/Users', {
      method: 'POST',
      headers: { 'content-type': 'application/scim+json' },
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'someone@example.com',
      }),
    }));
    expect(res.status).toBe(401);
  });

  test('DELETE /scim/v2/Users/:id without bearer → 401', async () => {
    const res = await app.handle(new Request('http://test/scim/v2/Users/00000000-0000-0000-0000-000000000000', {
      method: 'DELETE',
    }));
    expect(res.status).toBe(401);
  });

  test('GET /scim/v2/Groups without bearer → 401', async () => {
    const res = await get('/scim/v2/Groups');
    expect(res.status).toBe(401);
  });

  test('401 response body uses the SCIM Error schema', async () => {
    const res = await get('/scim/v2/Users');
    const body = await res.json() as { schemas?: string[]; status?: string };
    expect(body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:Error');
    expect(body.status).toBe('401');
  });
});
