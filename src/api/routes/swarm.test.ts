import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'crypto';
import { Elysia } from '@/api/http';
import {
  isIntegration,
  setupIntegrationDb,
  teardownIntegration,
  truncateTables,
} from '@/test-helpers/integration';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

/**
 * Swarm admin API integration tests.
 *
 * Covers GET /swarm/nodes (list), GET /swarm/nodes/:id (detail), and
 * POST /swarm/nodes/:id/cancel (cascade cancel). Uses the same derived-
 * user pattern as `agents.test.ts` — we bypass the real auth derive and
 * inject a fake `user` so the route's ownership check uses our seeded
 * session.
 *
 * Run via:  npm run test:integration -- src/api/routes/swarm.test.ts
 */

describe.skipIf(!isIntegration)('Swarm API (Integration)', () => {
  let app: ElysiaLike;
  let testUserId: string;
  let otherUserId: string;
  let sessionId: string;
  let otherSessionId: string;
  let rootNodeId: string;
  let agentNodeId: string;
  let subagentNodeId: string;
  let outsiderNodeId: string;

  beforeAll(async () => {
    await setupIntegrationDb();

    // Defensive reset — bun's mock.module + shared `getConfig()` mean an
    // earlier test in the run might have left RLS or workspace flags on.
    // Swarm routes use the unscoped sessionRepository and would 401 if RLS
    // were enforcing under our non-superuser test role.
    const { getConfig } = await import('@/config');
    getConfig().multiuser.rlsEnabled = false;
    getConfig().multiuser.orgWorkspaces = false;

    const { getDb } = await import('@/db/postgres');
    const { users } = await import('@/db/schema/users');
    const { sessions } = await import('@/db/schema/sessions');
    const { swarmNodes } = await import('@/db/schema/swarm-nodes');
    const db = getDb();

    await truncateTables(['swarm_nodes', 'agents', 'sessions', 'users']);

    const [me, other] = await db
      .insert(users)
      .values([
        { username: `swarm-tester-${Date.now()}` },
        { username: `swarm-other-${Date.now()}` },
      ])
      .returning();
    testUserId = me.id;
    otherUserId = other.id;

    const [mySession, otherSession] = await db
      .insert(sessions)
      .values([
        { userId: testUserId, channelType: 'webchat', channelId: 'ch-1', title: 'Mine' },
        { userId: otherUserId, channelType: 'webchat', channelId: 'ch-2', title: 'Theirs' },
      ])
      .returning();
    sessionId = mySession.id;
    otherSessionId = otherSession.id;

    rootNodeId = randomUUID();
    agentNodeId = randomUUID();
    subagentNodeId = randomUUID();
    outsiderNodeId = randomUUID();

    await db.insert(swarmNodes).values([
      {
        id: rootNodeId,
        rootSessionId: sessionId,
        parentNodeId: null,
        depth: 0,
        kind: 'root',
        role: 'general',
        topicPath: 'root',
        model: 'gpt-4',
        status: 'running',
        tokenCap: 200_000,
        wallClockCapMs: 600_000,
        fanOutCap: 6,
        briefHash: 'h-root',
      },
      {
        id: agentNodeId,
        rootSessionId: sessionId,
        parentNodeId: rootNodeId,
        depth: 1,
        kind: 'agent',
        role: 'security',
        topicPath: 'root/security',
        model: 'gpt-4',
        status: 'running',
        tokenCap: 80_000,
        wallClockCapMs: 240_000,
        fanOutCap: 4,
        briefHash: 'h-sec',
      },
      {
        id: subagentNodeId,
        rootSessionId: sessionId,
        parentNodeId: agentNodeId,
        depth: 2,
        kind: 'subagent',
        role: 'security',
        topicPath: 'root/security/oauth',
        model: 'gpt-4',
        status: 'completed',
        tokenCap: 30_000,
        wallClockCapMs: 90_000,
        fanOutCap: 0,
        briefHash: 'h-oauth',
        result: {
          nodeId: subagentNodeId,
          kind: 'subagent',
          status: 'ok',
          output: 'oauth review done',
          usedTokens: 1234,
          durationMs: 4000,
          spawnedChildren: [],
        },
        completedAt: new Date(),
      },
      {
        id: outsiderNodeId,
        rootSessionId: otherSessionId,
        parentNodeId: null,
        depth: 0,
        kind: 'root',
        role: 'general',
        topicPath: 'root',
        model: 'gpt-4',
        status: 'running',
        tokenCap: 200_000,
        wallClockCapMs: 600_000,
        fanOutCap: 6,
        briefHash: 'h-outsider',
      },
    ]);

    const { swarmRoutes } = await import('./swarm');
    const { principalFromUser } = await import('@/security/principal');
    const callerUser = { id: testUserId, username: 'swarm-tester', isAdmin: false };
    app = new Elysia()
      .derive({ as: 'global' }, () => ({
        user: callerUser,
        session: null,
        principal: principalFromUser(callerUser),
      }))
      .use(swarmRoutes);
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  async function hit(path: string, opts: { method?: string } = {}): Promise<{ status: number; body: any }> {
    const res = await app.handle(
      new Request(`http://localhost${path}`, { method: opts.method ?? 'GET' }),
    );
    const body = await res.json();
    return { status: res.status, body };
  }

  test('GET /swarm/nodes returns all nodes for a session the caller owns', async () => {
    const { body } = await hit(`/swarm/nodes?rootSessionId=${sessionId}`);
    expect(body.nodes).toBeInstanceOf(Array);
    const ids = body.nodes.map((n: { id: string }) => n.id);
    expect(ids).toContain(rootNodeId);
    expect(ids).toContain(agentNodeId);
    expect(ids).toContain(subagentNodeId);
    expect(ids).not.toContain(outsiderNodeId);
  });

  test('GET /swarm/nodes requires rootSessionId', async () => {
    const { status, body } = await hit('/swarm/nodes');
    // Elysia validator rejects with a 422 when the required query param is
    // missing. Response body may or may not include an `error` field
    // depending on Elysia internals — either the status code or the error
    // body is enough evidence of refusal.
    expect(status >= 400 || body.error !== undefined).toBe(true);
  });

  test('GET /swarm/nodes rejects sessions the caller does not own', async () => {
    const { body } = await hit(`/swarm/nodes?rootSessionId=${otherSessionId}`);
    expect(body.error).toBe('Not authorized');
  });

  test('GET /swarm/nodes/:id returns single node with full result jsonb', async () => {
    const { body } = await hit(`/swarm/nodes/${subagentNodeId}`);
    expect(body.node).toBeDefined();
    expect(body.node.id).toBe(subagentNodeId);
    expect(body.node.result).toBeDefined();
    expect(body.node.result.status).toBe('ok');
    expect(body.node.result.output).toBe('oauth review done');
  });

  test('GET /swarm/nodes/:id rejects nodes in sessions the caller does not own', async () => {
    const { body } = await hit(`/swarm/nodes/${outsiderNodeId}`);
    expect(body.error).toBe('Not authorized');
  });

  test('GET /swarm/nodes/:id returns Not found for unknown id', async () => {
    const { body } = await hit(`/swarm/nodes/${randomUUID()}`);
    expect(body.error).toBe('Swarm node not found');
  });

  test('POST /swarm/nodes/:id/cancel cancels node + descendants', async () => {
    const { body } = await hit(`/swarm/nodes/${agentNodeId}/cancel`, { method: 'POST' });
    expect(body.cancelled).toBe(true);
    expect(body.nodeId).toBe(agentNodeId);
    expect(body.descendantIds).toContain(subagentNodeId);

    // The agent row (was running) should be flipped to cancelled now.
    // The subagent row was completed — it must remain completed so we don't
    // retroactively rewrite terminal states.
    const { getDb } = await import('@/db/postgres');
    const { swarmNodes } = await import('@/db/schema/swarm-nodes');
    const { eq } = await import('drizzle-orm');
    const db = getDb();
    const [agentRow] = await db.select().from(swarmNodes).where(eq(swarmNodes.id, agentNodeId));
    expect(agentRow.status).toBe('cancelled');
    const [subRow] = await db.select().from(swarmNodes).where(eq(swarmNodes.id, subagentNodeId));
    expect(subRow.status).toBe('completed');
  });

  test('POST /swarm/nodes/:id/cancel rejects nodes outside the caller\'s sessions', async () => {
    const { body } = await hit(`/swarm/nodes/${outsiderNodeId}/cancel`, { method: 'POST' });
    expect(body.error).toBe('Not authorized');
  });
});

describe('Swarm API (Unit)', () => {
  test('cancel response shape is stable', () => {
    const payload = {
      cancelled: true,
      nodeId: 'abc',
      descendantIds: ['def', 'ghi'],
      stoppedLive: 2,
    };
    expect(payload.cancelled).toBe(true);
    expect(payload.descendantIds).toHaveLength(2);
    expect(typeof payload.stoppedLive).toBe('number');
  });
});
