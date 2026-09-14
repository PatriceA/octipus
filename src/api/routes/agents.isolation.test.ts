/**
 * Route-level cross-tenant isolation test for /api/agents.
 *
 * Covers DB-history paths (the in-memory `agentManager` is harder to
 * stub in this slice — the existing `agents.test.ts` already exercises
 * its mocked happy path). The fixture seeds two agent rows owned by
 * alice + bob and asserts:
 *   - GET /agents/:id from alice for bob's id → "Agent not found"
 *   - GET /agents (no sessionId) → only the principal's own agents
 *   - GET /agents?sessionId=<bob's> from alice → empty list
 *   - GET /agents/:id/events for bob's agent from alice → "not found"
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from '@/api/http';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

let aliceApp: ElysiaLike;
let bobApp: ElysiaLike;
const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';
let aliceSessionId: string;
let bobSessionId: string;
const aliceAgentId = 'agent-alice-iso';
const bobAgentId = 'agent-bob-iso';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-agents-iso-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  // Seed via raw SQL — bypasses any module-mock state from earlier
  // test files in the same `npm test` invocation.
  const {
    seedAgent, seedAgentEvent, seedSession, seedUsers,
  } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: aliceId, username: 'alice' },
    { id: bobId, username: 'bob' },
  ]);
  aliceSessionId = (await seedSession({ userId: aliceId, channelId: 'a-1' })).id;
  bobSessionId = (await seedSession({ userId: bobId, channelId: 'b-1' })).id;
  await seedAgent({
    id: aliceAgentId, sessionId: aliceSessionId, userId: aliceId,
    topic: 'alice-topic', status: 'completed',
  });
  await seedAgent({
    id: bobAgentId, sessionId: bobSessionId, userId: bobId,
    topic: 'bob-topic', status: 'completed',
  });
  const { agentRepository } = await import('@/db/repositories/agent-repository');
  await agentRepository.updateStatus(aliceAgentId, { status: 'completed', completionReason: 'iteration_limit' });
  await seedAgentEvent({
    agentId: bobAgentId, sessionId: bobSessionId, type: 'thought', data: { secret: 'bob' },
  });
  // More than one repository page, so the history route's durable cursor is
  // exercised rather than accidentally passing with a single short result.
  const { getDb } = await import('@/db/postgres');
  const { agentEvents } = await import('@/db/schema/agent-events');
  await getDb().insert(agentEvents).values(Array.from({ length: 243 }, (_, index) => ({
    agentId: aliceAgentId,
    sessionId: aliceSessionId,
    userId: aliceId,
    type: index % 5 === 0 ? 'action' : 'thought',
    data: { index },
  })));

  const { agentRoutes } = await import('./agents');
  const { principalFromUser } = await import('@/security/principal');

  const buildApp = (uid: string): ElysiaLike =>
    new Elysia()
      .derive(() => {
        const u = { id: uid, username: uid === aliceId ? 'alice' : 'bob', isAdmin: false };
        return { user: u, session: null, principal: principalFromUser(u) };
      })
      .group('/api', (a) => a.use(agentRoutes)) as unknown as ElysiaLike;

  aliceApp = buildApp(aliceId);
  bobApp = buildApp(bobId);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function get(app: ElysiaLike, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json() };
}

describe('GET /api/agents/:id cross-tenant', () => {
  test('alice cannot fetch bob’s agent — "Agent not found"', async () => {
    const own = await get(aliceApp, `/api/agents/${aliceAgentId}`);
    expect(own.body.id).toBe(aliceAgentId);
    expect(own.body.completionReason).toBe('iteration_limit');
    expect(own.body.status).toBe('completed');

    const cross = await get(aliceApp, `/api/agents/${bobAgentId}`);
    expect(cross.body).toEqual({ error: 'Agent not found' });
  });
});

describe('GET /api/agents cross-tenant', () => {
  test('list returns only own agents (DB history path)', async () => {
    const r = await get(aliceApp, '/api/agents');
    expect(r.body.agents.find((a: any) => a.id === bobAgentId)).toBeUndefined();
    expect(r.body.agents.find((a: any) => a.id === aliceAgentId)).toBeDefined();
    expect(r.body.agents.find((a: { id: string }) => a.id === aliceAgentId).completionReason).toBe('iteration_limit');
  });

  test('sessionId scoped to a foreign session returns []', async () => {
    const r = await get(aliceApp, `/api/agents?sessionId=${bobSessionId}`);
    expect(r.body.agents).toEqual([]);
  });
});

describe('GET /api/agents/:id/events cross-tenant', () => {
  test('alice cannot read bob’s agent events — "not found"', async () => {
    const r = await get(aliceApp, `/api/agents/${bobAgentId}/events`);
    expect(r.body).toEqual({ error: 'Agent not found' });
  });

  test('bob can read his own events', async () => {
    const r = await get(bobApp, `/api/agents/${bobAgentId}/events`);
    expect(Array.isArray(r.body.events)).toBe(true);
    expect(r.body.events.find((e: any) => e.type === 'thought')).toBeDefined();
  });

  test('persisted source pages the complete durable history with DB-id cursors', async () => {
    const first = await get(aliceApp, `/api/agents/${aliceAgentId}/events?source=persisted`);
    expect(first.body.source).toBe('persisted');
    expect(first.body.events).toHaveLength(200);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.nextCursor).toBe(first.body.events[199].seq);
    expect(first.body.events[0].data.index).toBe(0);

    const second = await get(
      aliceApp,
      `/api/agents/${aliceAgentId}/events?source=persisted&after=${first.body.nextCursor}`,
    );
    expect(second.body.events).toHaveLength(43);
    expect(second.body.hasMore).toBe(false);
    expect(second.body.events[0].data.index).toBe(200);
    expect(second.body.events[42].data.index).toBe(242);
  });
});
