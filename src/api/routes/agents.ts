import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getAgentManager } from '@/core/agent-manager';
import { agentRepository } from '@/db/repositories/agent-repository';
import { getRouter } from '@/core/router';
import { sessionRepository } from '@/db/repositories/session-repository';
import { apiLogger } from '@/utils/logger';

export const agentRoutes = new Elysia({ prefix: '/agents' })
  .use(apiContext)
  // List all agents (in-memory live + DB history)
  .get(
    '/',
    async ({ user, query }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const agentManager = getAgentManager();
      let liveAgents = agentManager.list();

      // Non-admin users can only see their own agents
      if (!user.isAdmin) {
        liveAgents = liveAgents.filter((a) => a.userId === user.id);
      }

      // Collect IDs of agents still in memory
      const liveIds = new Set(liveAgents.map(a => a.id));

      // Fetch historical agents from DB (exclude ones still in memory)
      try {
        const sessionId = query?.sessionId as string | undefined;
        const dbAgents = sessionId
          ? await agentRepository.findBySession(sessionId)
          : user.isAdmin
            ? await agentRepository.listRecent()
            : await agentRepository.findByUser(user.id);

        const historical = dbAgents
          .filter(a => !liveIds.has(a.id))
          .map(a => ({
            id: a.id,
            sessionId: a.sessionId,
            userId: a.userId,
            topic: a.topic,
            model: a.model,
            role: a.role,
            status: a.status,
            createdAt: a.createdAt,
            iteration: a.iterations || 0,
            durationMs: a.durationMs,
            totalTokens: a.totalTokens,
            error: a.error,
            completedAt: a.completedAt,
          }));

        return { agents: [...liveAgents, ...historical] };
      } catch (err) {
        // Fallback to live-only if DB query fails
        apiLogger.error({ err }, 'Failed to fetch agent history from DB');
        return { agents: liveAgents };
      }
    },
    {
      query: t.Optional(t.Object({
        sessionId: t.Optional(t.String()),
      })),
      detail: { tags: ['agents'] },
    }
  )

  // Get agent details (live or from DB history)
  .get(
    '/:id',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const agentManager = getAgentManager();
      const agent = agentManager.get(params.id);

      if (agent) {
        const context = agent.getContext();
        if (!user.isAdmin && context.userId !== user.id) {
          return { error: 'Not authorized' };
        }
        return {
          id: context.id,
          sessionId: context.sessionId,
          userId: context.userId,
          topic: context.topic,
          model: context.model,
          status: agent.getStatus(),
          iteration: agent.getIteration(),
          createdAt: context.createdAt,
          metadata: context.metadata,
        };
      }

      // Fall back to DB history
      const dbAgent = await agentRepository.findById(params.id);
      if (!dbAgent) {
        return { error: 'Agent not found' };
      }
      if (!user.isAdmin && dbAgent.userId !== user.id) {
        return { error: 'Not authorized' };
      }
      return {
        id: dbAgent.id,
        sessionId: dbAgent.sessionId,
        userId: dbAgent.userId,
        topic: dbAgent.topic,
        model: dbAgent.model,
        status: dbAgent.status,
        iteration: dbAgent.iterations || 0,
        createdAt: dbAgent.createdAt,
        metadata: dbAgent.metadata || {},
        durationMs: dbAgent.durationMs,
        totalTokens: dbAgent.totalTokens,
        error: dbAgent.error,
        completedAt: dbAgent.completedAt,
      };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: { tags: ['agents'] },
    }
  )

  // Spawn a new agent
  .post(
    '/',
    async ({ user, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const { sessionId, topic, model, systemPrompt, message } = body;

      // Verify session ownership
      const session = await sessionRepository.findById(sessionId);
      if (!session) {
        return { error: 'Session not found' };
      }

      if (!user.isAdmin && session.userId !== user.id) {
        return { error: 'Not authorized' };
      }

      const agentManager = getAgentManager();

      try {
        const agent = await agentManager.spawn({
          sessionId,
          userId: user.id,
          topic,
          model,
          systemPrompt,
        });

        // Start the agent with initial message if provided
        if (message) {
          agent.run(message).catch((error) => {
            apiLogger.error({ error, agentId: agent.getContext().id }, 'Agent run failed');
          });
        }

        const context = agent.getContext();

        return {
          id: context.id,
          sessionId: context.sessionId,
          topic: context.topic,
          model: context.model,
          status: agent.getStatus(),
        };
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
    {
      body: t.Object({
        sessionId: t.String(),
        topic: t.Optional(t.String()),
        model: t.Optional(t.String()),
        systemPrompt: t.Optional(t.String()),
        message: t.Optional(t.String()),
      }),
      detail: { tags: ['agents'] },
    }
  )

  // Send message to agent
  .post(
    '/:id/message',
    async ({ user, params, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const agentManager = getAgentManager();
      const agent = agentManager.get(params.id);

      if (!agent) {
        return { error: 'Agent not found' };
      }

      const context = agent.getContext();

      if (!user.isAdmin && context.userId !== user.id) {
        return { error: 'Not authorized' };
      }

      if (agent.getStatus() !== 'idle' && agent.getStatus() !== 'completed') {
        return { error: 'Agent is busy' };
      }

      // Run agent with message
      agent.run(body.message).catch((error) => {
        apiLogger.error({ error, agentId: params.id }, 'Agent run failed');
      });

      return { status: 'processing' };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      body: t.Object({
        message: t.String(),
      }),
      detail: { tags: ['agents'] },
    }
  )

  // Stop an agent
  .post(
    '/:id/stop',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const agentManager = getAgentManager();
      const agent = agentManager.get(params.id);

      if (!agent) {
        return { error: 'Agent not found' };
      }

      const context = agent.getContext();

      if (!user.isAdmin && context.userId !== user.id) {
        return { error: 'Not authorized' };
      }

      const stopped = agentManager.stop(params.id);

      return { stopped };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: { tags: ['agents'] },
    }
  )

  // Remove an agent
  .delete(
    '/:id',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const agentManager = getAgentManager();
      const agent = agentManager.get(params.id);

      if (!agent) {
        return { error: 'Agent not found' };
      }

      const context = agent.getContext();

      if (!user.isAdmin && context.userId !== user.id) {
        return { error: 'Not authorized' };
      }

      const removed = agentManager.remove(params.id);

      return { removed };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: { tags: ['agents'] },
    }
  )

  // Get agent events (polling endpoint)
  .get(
    '/:id/events',
    async ({ user, params, query }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const agentManager = getAgentManager();
      const agent = agentManager.get(params.id);

      if (!agent) {
        return { error: 'Agent not found' };
      }

      const context = agent.getContext();
      if (!user.isAdmin && context.userId !== user.id) {
        return { error: 'Not authorized' };
      }

      const afterSeq = query.after ? parseInt(query.after, 10) : 0;
      const buffered = agentManager.getEvents(params.id, afterSeq);

      return {
        events: buffered.map(b => ({
          seq: b.seq,
          type: b.event.type,
          agentId: b.event.agentId,
          data: b.event.data,
          timestamp: b.event.timestamp,
        })),
      };
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ after: t.Optional(t.String()) }),
      detail: { tags: ['agents'] },
    }
  )

  // Get routing decision for a message
  .post(
    '/route',
    async ({ user, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const router = getRouter();
      const decision = await router.route(body.message, body.preferredModel);

      return decision;
    },
    {
      body: t.Object({
        message: t.String(),
        preferredModel: t.Optional(t.String()),
      }),
      detail: { tags: ['agents'] },
    }
  );
