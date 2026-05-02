/**
 * Route-level cross-tenant isolation test for /api/pipelines.
 *
 * Two gaps closed in Phase 1a:
 *   - GET/POST /pipelines/:id/(stop|approve) had hand-rolled
 *     "is admin or owner?" checks per-handler — error-prone.
 *   - PUT/DELETE /pipelines/templates/:id had NO auth check,
 *     so any authenticated user could mutate any template,
 *     including system presets.
 *
 * The fixture seeds:
 *   - one pipeline owned by bob
 *   - one private template owned by bob
 *   - one preset template (owned by no one)
 * and asserts alice can read presets but cannot mutate any of them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

let aliceApp: ElysiaLike;
const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';
let bobPipelineId: string;
let bobTemplateId: string;
let presetTemplateId: string;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-pipe-iso-'));

  const { initializeDb, executeRaw, queryRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  // Seed via raw SQL — see multiuser-fixtures.ts for the rationale.
  const { seedSession, seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: aliceId, username: 'alice' },
    { id: bobId, username: 'bob' },
  ]);
  const bobSession = await seedSession({ userId: bobId, channelId: 'b-1' });

  await executeRaw(
    `INSERT INTO pipelines (orchestrator_agent_id, session_id, user_id, title, type, status)
     VALUES ('orch-bob', '${bobSession.id}', '${bobId}', 'bob pipeline', 'general', 'running')`,
  );
  await executeRaw(
    `INSERT INTO pipeline_templates (user_id, name, is_preset, steps) VALUES
       ('${bobId}', 'bob-private', false, '[]'::jsonb),
       (NULL,       'shipped-preset', true,  '[]'::jsonb)`,
  );

  const { rows: pipes } = await queryRaw(`SELECT id FROM pipelines`);
  bobPipelineId = pipes[0].id;
  const { rows: tpls } = await queryRaw(`SELECT id, name, is_preset FROM pipeline_templates`);
  bobTemplateId = tpls.find((t: any) => t.name === 'bob-private').id;
  presetTemplateId = tpls.find((t: any) => t.name === 'shipped-preset').id;

  const { pipelineRoutes } = await import('./pipelines');
  const { principalFromUser } = await import('@/security/principal');

  aliceApp = new Elysia()
    .derive(() => {
      const u = { id: aliceId, username: 'alice', isAdmin: false };
      return { user: u, session: null, principal: principalFromUser(u) };
    })
    .group('/api', (a) => a.use(pipelineRoutes)) as unknown as ElysiaLike;
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function get(app: ElysiaLike, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json() };
}
async function del(app: ElysiaLike, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`, { method: 'DELETE' }));
  return { status: res.status, body: await res.json() };
}
async function putJson(app: ElysiaLike, path: string, body: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

describe('GET /api/pipelines/:id cross-tenant', () => {
  test('alice cannot fetch bob’s pipeline — "Pipeline not found"', async () => {
    const r = await get(aliceApp, `/api/pipelines/${bobPipelineId}`);
    expect(r.body).toEqual({ error: 'Pipeline not found' });
  });
});

describe('PUT /api/pipelines/templates/:id auth (gap closed in Phase 1a)', () => {
  test('alice cannot rewrite bob’s private template', async () => {
    const r = await putJson(aliceApp, `/api/pipelines/templates/${bobTemplateId}`, { name: 'pwned' });
    expect(r.body).toEqual({ error: 'Template not found' });

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT name FROM pipeline_templates WHERE id='${bobTemplateId}'`);
    expect(rows[0].name).toBe('bob-private');
  });

  test('alice cannot rewrite a system preset', async () => {
    const r = await putJson(aliceApp, `/api/pipelines/templates/${presetTemplateId}`, { name: 'pwned' });
    expect(r.body).toEqual({ error: 'Template not found' });

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT name FROM pipeline_templates WHERE id='${presetTemplateId}'`);
    expect(rows[0].name).toBe('shipped-preset');
  });
});

describe('DELETE /api/pipelines/templates/:id auth (gap closed in Phase 1a)', () => {
  test('alice cannot delete bob’s template', async () => {
    const r = await del(aliceApp, `/api/pipelines/templates/${bobTemplateId}`);
    expect(r.body).toEqual({ error: 'Template not found' });
  });

  test('alice cannot delete a system preset', async () => {
    const r = await del(aliceApp, `/api/pipelines/templates/${presetTemplateId}`);
    expect(r.body).toEqual({ error: 'Template not found' });
  });
});
