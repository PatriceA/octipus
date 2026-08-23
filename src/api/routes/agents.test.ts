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

// Integration tests exercise read-only parts of the agents route (GET /agents,
// GET /agents/:id) against a real Postgres with seeded historical agent rows.
// POST /agents (spawn) and POST /:id/message are out of scope — they require a
// live AgentManager with model providers wired up.
//
// Run via:  bun run test:integration -- src/api/routes/agents.test.ts

describe.skipIf(!isIntegration)('Agents API (Integration)', () => {
  let app: ElysiaLike;
  let testUserId: string;
  let otherUserId: string;
  let sessionId: string;
  let liveAgentId: string;
  let historicalAgentId: string;

  beforeAll(async () => {
    await setupIntegrationDb();

    const { getDb } = await import('@/db/postgres');
    const { users } = await import('@/db/schema/users');
    const { sessions } = await import('@/db/schema/sessions');
    const { agents } = await import('@/db/schema/agents');
    const db = getDb();

    await truncateTables(['agents', 'sessions', 'users']);

    const [me, other] = await db
      .insert(users)
      .values([
        { username: `tester-${Date.now()}` },
        { username: `other-${Date.now()}` },
      ])
      .returning();
    testUserId = me.id;
    otherUserId = other.id;

    const [session] = await db
      .insert(sessions)
      .values({
        userId: testUserId,
        channelType: 'webchat',
        channelId: 'ch-1',
        title: 'Test session',
      })
      .returning();
    sessionId = session.id;

    liveAgentId = randomUUID();
    historicalAgentId = randomUUID();
    await db.insert(agents).values([
      {
        id: liveAgentId,
        sessionId,
        userId: testUserId,
        role: 'general',
        model: 'gpt-4',
        topic: 'coding',
        status: 'running',
        iterations: 3,
        totalTokens: 1200,
      },
      {
        id: historicalAgentId,
        sessionId,
        userId: testUserId,
        role: 'general',
        model: 'gpt-4',
        topic: 'coding',
        status: 'completed',
        iterations: 5,
        totalTokens: 3000,
        durationMs: 12345,
        completedAt: new Date(),
      },
      {
        id: randomUUID(),
        sessionId,
        userId: otherUserId,
        role: 'general',
        model: 'gpt-4',
        topic: 'research',
        status: 'completed',
        iterations: 1,
      },
    ]);

    const { agentRoutes } = await import('./agents');
    const { principalFromUser } = await import('@/security/principal');
    const callerUser = { id: testUserId, username: 'tester', isAdmin: false };
    app = new Elysia()
      .derive({ as: 'global' }, () => ({
        user: callerUser,
        session: null,
        principal: principalFromUser(callerUser),
      }))
      .use(agentRoutes);
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  test('GET /agents returns only the caller\'s agents when non-admin', async () => {
    const res = await app.handle(new Request('http://localhost/agents'));
    const data = (await res.json()) as { agents: Array<{ id: string; userId: string }> };

    expect(data.agents).toBeInstanceOf(Array);
    const userIds = new Set(data.agents.map((a) => a.userId));
    expect(userIds.size).toBe(1);
    expect([...userIds][0]).toBe(testUserId);

    const ids = data.agents.map((a) => a.id);
    expect(ids).toContain(liveAgentId);
    expect(ids).toContain(historicalAgentId);
  });

  test('GET /agents?sessionId= returns agents scoped to that session', async () => {
    const res = await app.handle(
      new Request(`http://localhost/agents?sessionId=${sessionId}`),
    );
    const data = (await res.json()) as { agents: Array<{ sessionId: string }> };
    expect(data.agents.length).toBeGreaterThan(0);
    for (const a of data.agents) expect(a.sessionId).toBe(sessionId);
  });

  test('GET /agents paginates via limit/offset and reports total + hasMore', async () => {
    type Page = {
      agents: Array<{ id: string }>;
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
    };
    const page1 = (await (
      await app.handle(new Request('http://localhost/agents?limit=1&offset=0'))
    ).json()) as Page;
    expect(page1.total).toBe(2); // caller owns exactly two agents
    expect(page1.limit).toBe(1);
    expect(page1.offset).toBe(0);
    expect(page1.agents.length).toBe(1);
    expect(page1.hasMore).toBe(true);

    const page2 = (await (
      await app.handle(new Request('http://localhost/agents?limit=1&offset=1'))
    ).json()) as Page;
    expect(page2.agents.length).toBe(1);
    expect(page2.hasMore).toBe(false);
    expect(page2.agents[0].id).not.toBe(page1.agents[0].id);
  });

  test('GET /agents clamps an oversized limit to the 200 cap', async () => {
    const data = (await (
      await app.handle(new Request('http://localhost/agents?limit=99999'))
    ).json()) as { limit: number };
    expect(data.limit).toBe(200);
  });

  test('GET /agents/:id returns a historical agent by id', async () => {
    const res = await app.handle(
      new Request(`http://localhost/agents/${historicalAgentId}`),
    );
    const data = (await res.json()) as {
      id: string;
      status: string;
      iteration: number;
      model: string;
    };
    expect(data.id).toBe(historicalAgentId);
    expect(data.status).toBe('completed');
    expect(data.iteration).toBe(5);
    expect(data.model).toBe('gpt-4');
  });

  test('GET /agents/:id returns Not found for an unknown id', async () => {
    const res = await app.handle(
      new Request(`http://localhost/agents/${randomUUID()}`),
    );
    const data = (await res.json()) as { error?: string };
    expect(data.error).toBeDefined();
  });

  test('GET /agents/:id returns Not authorized for another user\'s agent', async () => {
    // Find the other user's agent id via a fresh DB read
    const { getDb } = await import('@/db/postgres');
    const { agents } = await import('@/db/schema/agents');
    const { eq } = await import('drizzle-orm');
    const db = getDb();
    const [otherAgent] = await db
      .select()
      .from(agents)
      .where(eq(agents.userId, otherUserId))
      .limit(1);
    expect(otherAgent).toBeDefined();

    const res = await app.handle(
      new Request(`http://localhost/agents/${otherAgent.id}`),
    );
    const data = (await res.json()) as { error?: string };
    // The route collapses 403 into 404 to avoid leaking existence — a
    // foreign agent id looks indistinguishable from a non-existent one.
    expect(data.error).toBe('Agent not found');
  });

  // Runs LAST in this block: it deletes rows, so keep it after the read tests
  // that assert on the seeded counts.
  test('deleteCompletedBefore sweeps old finished agents + their events, keeps running ones', async () => {
    const { getDb } = await import('@/db/postgres');
    const { agents } = await import('@/db/schema/agents');
    const { agentEvents } = await import('@/db/schema/agent-events');
    const { agentRepository } = await import('@/db/repositories/agent-repository');
    const { eq } = await import('drizzle-orm');
    const db = getDb();

    const oldId = randomUUID();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600_000);
    await db.insert(agents).values({
      id: oldId,
      sessionId,
      userId: testUserId,
      role: 'general',
      model: 'gpt-4',
      topic: 'coding',
      status: 'completed',
      completedAt: thirtyDaysAgo,
    });
    await db
      .insert(agentEvents)
      .values({ agentId: oldId, sessionId, userId: testUserId, type: 'complete', data: {} });

    const cutoff = new Date(Date.now() - 14 * 24 * 3600_000);
    const removed = await agentRepository.deleteCompletedBefore(cutoff);
    expect(removed).toBeGreaterThanOrEqual(1);

    const remaining = await db.select().from(agents).where(eq(agents.id, oldId));
    expect(remaining.length).toBe(0);
    const remainingEvents = await db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentId, oldId));
    expect(remainingEvents.length).toBe(0);

    // Running agents (NULL completedAt) are never swept.
    const live = await db.select().from(agents).where(eq(agents.id, liveAgentId));
    expect(live.length).toBe(1);
  });
});

describe('Agents API (Unit)', () => {
  test('agent creation payload is valid', () => {
    const createPayload = {
      topic: 'coding',
      systemPrompt: 'You are a helpful coding assistant.',
      model: 'gpt-4',
    };

    expect(createPayload.topic).toBeDefined();
    expect(typeof createPayload.systemPrompt).toBe('string');
  });

  test('agent status values are valid', () => {
    const validStatuses = ['idle', 'running', 'paused', 'completed', 'failed'];
    const agentStatus = 'running';

    expect(validStatuses).toContain(agentStatus);
  });

  test('agent response structure is correct', () => {
    const mockAgent = {
      id: 'agent-123',
      status: 'running',
      topic: 'coding',
      model: 'gpt-4',
      iteration: 5,
      createdAt: new Date().toISOString(),
    };

    expect(mockAgent.id).toBeDefined();
    expect(mockAgent.status).toBe('running');
    expect(mockAgent.iteration).toBeGreaterThanOrEqual(0);
  });
});
