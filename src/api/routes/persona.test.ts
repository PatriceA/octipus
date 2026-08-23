import { describe, expect, test } from 'vitest';
import { Elysia } from '@/api/http';
import { personaRoutes } from './persona';

/**
 * Shape-and-auth tests for the persona REST endpoints. Routes that
 * touch the DB (PATCH, POST facts, DELETE) require a live PG and are
 * exercised by the integration suite; here we just verify (a) unauth
 * paths reject with 401, (b) presets endpoint works without DB
 * mutation, (c) routes are mounted.
 */

const app = new Elysia().use(personaRoutes);

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}

describe('persona REST API', () => {
  test('GET /persona returns 401 when not authenticated', async () => {
    const res = await call('GET', '/persona');
    expect(res.status).toBe(401);
  });

  test('GET /persona/presets returns the shipped preset list (no auth required)', async () => {
    const res = await call('GET', '/persona/presets');
    expect(res.status).toBe(200);
    const body = await res.json() as { presets: Array<{ id: string; isDefault: boolean }> };
    expect(Array.isArray(body.presets)).toBe(true);
    expect(body.presets.length).toBeGreaterThan(0);
    expect(body.presets.find(p => p.id === 'octipus')).toBeDefined();
    expect(body.presets.filter(p => p.isDefault).length).toBe(1);
  });

  test('PATCH /persona without auth → 401', async () => {
    const res = await call('PATCH', '/persona', { name: 'Adam' });
    expect(res.status).toBe(401);
  });

  test('POST /persona/facts without auth → 401', async () => {
    const res = await call('POST', '/persona/facts', { fact: 'be terse' });
    expect(res.status).toBe(401);
  });

  test('DELETE /persona/facts/:idx without auth → 401', async () => {
    const res = await call('DELETE', '/persona/facts/0');
    expect(res.status).toBe(401);
  });

  test('POST /persona/reset without auth → 401', async () => {
    const res = await call('POST', '/persona/reset');
    expect(res.status).toBe(401);
  });
});
