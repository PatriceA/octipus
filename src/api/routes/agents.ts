import { Elysia, t } from '@/api/http';
import { recheckSpace } from '@/core/agent/context';
import type { AgentSpace } from '@/core/types';
import { type AgentScope, resolveAgentScope, withAgentUsage } from '@/core/agent/context';
import { SpaceError, spaceErrorStatus } from '@/security/space-access';
import { apiContext } from '@/api/context';
import { getAgentManager } from '@/core/agent-manager';
import { getRouter } from '@/core/router';
import { sessionRepository } from '@/db/repositories/session-repository';
import { contentRepos } from '@/db/repositories/content';
import { isAuthenticated } from '@/security/principal';
import { apiLogger } from '@/utils/logger';
import { readAgentCompletionReason } from '@/shared/agent-completion';
import { getMembership, isSharedWorkspace } from '@/core/spaces/service';

type LiveContext = { userId?: string | null; workspaceId?: string | null };

/**
 * May `user` reach a live agent (its details, events, stop, removal)? Its
 * owner may — in a space only while still a member (I5). An admin reaches
 * another user's live agent only outside spaces: admins reach spaces through
 * membership or audited impersonation, and a space agent's tool output is
 * space content (I2).
 */
async function mayReachLive(user: { id: string; isAdmin: boolean }, context: LiveContext): Promise<boolean> {
  const inSpace = !!context.workspaceId && (await isSharedWorkspace(context.workspaceId));
  if (context.userId === user.id) return !inSpace || (await getMembership(user.id, context.workspaceId as string)) !== null;
  return user.isAdmin && !inSpace;
}

/**
 * May `user` run their live agent again (`/:id/message`)? Outside spaces,
 * yes. In a space, the membership is re-read the way every spawn re-reads
 * it (`recheckSpace`, §5.6): only while their role may run the agent and
 * the space is not archived. A space agent built without its scope never runs.
 */
async function mayRunLive(userId: string, context: LiveContext & { space?: AgentSpace | null }): Promise<boolean> {
  if (context.space) {
    try {
      await recheckSpace(userId, context.space);
      return true;
    } catch (err) {
      if (err instanceof SpaceError) return false;
      throw err;
    }
  }
  return !context.workspaceId || !(await isSharedWorkspace(context.workspaceId));
}

/**
 * Agents — Phase 1a multi-user conversion.
 *
 * DB lookups go through `contentRepos(principal).agents`. The in-memory
 * agent manager continues to enforce ownership on `agent.getContext().userId`
 * (the live source of truth for running agents). The two layers compose:
 * a non-admin can only see live agents whose `context.userId` matches and
 * historical rows whose `agents.user_id` matches.
 *
 * Sibling-channel aggregation (telegram/slack/etc) resolves the original
 * session via the scoped session repo so we can't aggregate across a
 * foreign session id.
 */
export const agentRoutes = new Elysia({ prefix: '/agents' })
  .use(apiContext)
  // List all agents (in-memory live + DB history)
  .get(
    '/',
    async ({ user, principal, query }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }

      const agentManager = getAgentManager();
      // Each user sees their own live agents; an admin also sees other
      // users' agents outside spaces (never a space's, I2).
      const listed = agentManager.list();
      const reachable = await Promise.all(listed.map((a) => mayReachLive(user, {
        userId: a.userId,
        workspaceId: agentManager.get(a.id)?.getContext().workspaceId ?? null,
      })));
      let liveAgents = listed.filter((_, i) => reachable[i]);

      const repos = contentRepos(principal);

      // Pagination over the (potentially unbounded) historical rows. Live
      // agents are a small, active set and are always surfaced on the first
      // page; only DB history is paged. `limit` is clamped so a client can't
      // ask for an arbitrarily large payload. A session-scoped request is
      // inherently bounded to one conversation, so it keeps the higher legacy
      // default (200) — the chat page restores a whole session's agent
      // timeline in one shot and must not be silently truncated.
      const sessionScoped = !!query?.sessionId;
      const defaultLimit = sessionScoped ? 200 : 50;
      const limit = Math.min(Math.max(Number.parseInt(String(query?.limit ?? ''), 10) || defaultLimit, 1), 200);
      const offset = Math.max(Number.parseInt(String(query?.offset ?? ''), 10) || 0, 0);
      const firstPage = offset === 0;

      // Session scope: when a sessionId is provided, ALL results (live and
      // historical) must be scoped to that session. We resolve through the
      // scoped session repo so foreign session ids return null and the
      // route shows an empty list.
      const sessionId = query?.sessionId as string | undefined;
      let allowedSessionIds: Set<string> | undefined;
      if (sessionId) {
        const session = await repos.sessions.findById(sessionId);
        if (!session) {
          // Foreign or missing — present as empty rather than 404 so the
          // UI can keep rendering an empty agent list.
          return { agents: [], total: 0, limit, offset, hasMore: false };
        }
        const AGGREGATED_CHANNELS = new Set(['telegram', 'slack', 'whatsapp', 'teams', 'discord']);
        if (AGGREGATED_CHANNELS.has(session.channelType) && !session.groupChannelId) {
          // Siblings share session.userId by definition (the index is on
          // (user_id, channel_type, channel_id)), so they're all in tenant.
          const siblings = await sessionRepository.findAllByUserAndChannel(
            session.userId,
            session.channelType,
            session.channelId,
          );
          allowedSessionIds = new Set(siblings.map((s) => s.id));
        } else {
          allowedSessionIds = new Set([sessionId]);
        }
        liveAgents = liveAgents.filter((a) => allowedSessionIds!.has(a.sessionId));
      }

      // Collect IDs of agents still in memory
      const liveIds = new Set(liveAgents.map((a) => a.id));

      // Fetch historical agents from DB (exclude ones still in memory).
      // Scoped agent repo enforces user ownership in SQL.
      try {
        let dbAgents: Awaited<ReturnType<typeof repos.agents.listOwn>>;
        let total: number;
        // The page query and its count are independent — run them together
        // rather than paying two serial round-trips on every poll.
        if (allowedSessionIds) {
          const ids = [...allowedSessionIds];
          [dbAgents, total] = await Promise.all([
            repos.agents.findBySessions(ids, limit, offset),
            repos.agents.countBySessions(ids),
          ]);
        } else if (user.isAdmin && repos.kind === 'personal') {
          // Admin sees every user's history — outside spaces (I2).
          [dbAgents, total] = await Promise.all([
            repos.agents.listAllAdmin(limit, offset),
            repos.agents.countAllAdmin(),
          ]);
        } else {
          [dbAgents, total] = await Promise.all([
            repos.agents.listOwn(limit, offset),
            repos.agents.countOwn(),
          ]);
        }

        const historical = dbAgents
          .filter((a) => !liveIds.has(a.id))
          .map((a) => ({
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
            completionReason: readAgentCompletionReason(a.metadata),
          }));

        // Live agents anchor the first page only; later pages are pure history.
        const agents = firstPage ? [...liveAgents, ...historical] : historical;
        return {
          agents,
          total,
          limit,
          offset,
          hasMore: offset + dbAgents.length < total,
        };
      } catch (err) {
        // Fallback to live-only if DB query fails
        apiLogger.error({ err }, 'Failed to fetch agent history from DB');
        return { agents: firstPage ? liveAgents : [], total: liveAgents.length, limit, offset, hasMore: false };
      }
    },
    {
      query: t.Optional(t.Object({
        sessionId: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
      })),
      detail: { tags: ['agents'] },
    }
  )

  // Get agent details (live or from DB history)
  .get(
    '/:id',
    async ({ user, principal, params }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }

      const agentManager = getAgentManager();
      const agent = agentManager.get(params.id);

      if (agent) {
        const context = agent.getContext();
        if (!(await mayReachLive(user, context))) {
          return { error: 'Agent not found' };
        }
        // Same duration logic as `list()` — freeze at completedAt for finished
        // agents, live elapsed otherwise. Keeps inline cards accurate even
        // while the worker sits in memory awaiting cleanup.
        const durationMs = context.completedAt
          ? context.completedAt.getTime() - context.createdAt.getTime()
          : agent.getElapsedMs();
        return {
          id: context.id,
          sessionId: context.sessionId,
          userId: context.userId,
          topic: context.topic,
          model: context.model,
          status: agent.getStatus(),
          iteration: agent.getIteration(),
          createdAt: context.createdAt,
          completedAt: context.completedAt,
          durationMs,
          totalTokens: agent.getTotalTokens(),
          metadata: context.metadata,
          completionReason: readAgentCompletionReason(context.metadata),
        };
      }

      // Fall back to DB history — scoped repo collapses cross-tenant to null.
      const dbAgent = await contentRepos(principal).agents.findById(params.id);
      if (!dbAgent) {
        return { error: 'Agent not found' };
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
        completionReason: readAgentCompletionReason(dbAgent.metadata),
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
    async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }

      const { sessionId, topic, model, systemPrompt, message } = body;

      // The body names the session, so the session decides the workspace —
      // a member's private chat in a space included (the header does not
      // make this route act on a space). Another user's session is "Session
      // not found"; in a space, the agent runs only for a role that may run
      // it (a viewer gets 403, a removed member 404, an archived space 409),
      // through the one scope resolver every spawner uses (§5.6).
      const session = await sessionRepository.findById(sessionId);
      if (!session || session.userId !== user.id) {
        set.status = 404;
        return { error: 'Session not found' };
      }
      let scope: AgentScope;
      try {
        scope = await resolveAgentScope({ session, userId: user.id, trigger: 'user' });
      } catch (err) {
        if (err instanceof SpaceError) {
          set.status = spaceErrorStatus(err);
          return { error: err.message, code: err.code };
        }
        throw err;
      }

      const agentManager = getAgentManager();

      try {
        const agent = await agentManager.spawn({
          sessionId,
          userId: user.id,
          ...scope,
          topic,
          model,
          systemPrompt,
          // REST has no approval relay (`channelCanPrompt('api')`).
          attended: false,
        });

        // Start the agent with initial message if provided
        if (message) {
          withAgentUsage(user.id, scope, () => agent.run(message)).catch((error) => {
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
    async ({ user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }

      const agentManager = getAgentManager();
      const agent = agentManager.get(params.id);

      if (!agent) {
        return { error: 'Agent not found' };
      }

      const context = agent.getContext();
      if (!(await mayReachLive(user, context))) {
        return { error: 'Agent not found' };
      }
      // A run, not a read: in a space the role must allow it, and an
      // archived space runs nothing.
      if (!(await mayRunLive(user.id, context))) {
        set.status = 403;
        return { error: 'Your role in this space cannot run the agent, or the space is archived' };
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
    async ({ user, principal, params }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }

      const agentManager = getAgentManager();
      const agent = agentManager.get(params.id);

      if (!agent) {
        return { error: 'Agent not found' };
      }

      const context = agent.getContext();
      if (!(await mayReachLive(user, context))) {
        return { error: 'Agent not found' };
      }

      // Stop the target agent and all other agents in the same session
      // (e.g. stopping the root agent should also stop child CLI workers)
      const stopped = agentManager.stopSession(context.sessionId);

      return { stopped: stopped > 0 };
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
    async ({ user, principal, params }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }

      const agentManager = getAgentManager();
      const agent = agentManager.get(params.id);

      if (!agent) {
        return { error: 'Agent not found' };
      }

      const context = agent.getContext();
      if (!(await mayReachLive(user, context))) {
        return { error: 'Agent not found' };
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
    async ({ user, principal, params, query }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }

      const agentManager = getAgentManager();
      const agent = agentManager.get(params.id);
      const persisted = query.source === 'persisted';
      const parsedAfter = Number.parseInt(query.after ?? '', 10);
      const after = Number.isSafeInteger(parsedAfter) && parsedAfter > 0 ? parsedAfter : 0;

      // Existing polling clients use the low-latency in-memory ring for live
      // activity. History clients opt into the durable stream: a completed
      // worker can remain in AgentManager with only its last 200 buffered
      // events, so preferring memory there silently truncates its history.
      if (agent && !persisted) {
        const context = agent.getContext();
        if (!(await mayReachLive(user, context))) {
          return { error: 'Agent not found' };
        }

        const buffered = agentManager.getEvents(params.id, after);
        const nextCursor = buffered.at(-1)?.seq ?? after;

        return {
          source: 'live' as const,
          nextCursor,
          hasMore: false,
          events: buffered.map((b) => ({
            seq: b.seq,
            type: b.event.type,
            agentId: b.event.agentId,
            data: b.event.data,
            timestamp: b.event.timestamp,
          })),
        };
      }

      // Fall back to DB history — but first verify the principal owns
      // this agent so we don't leak event streams cross-tenant.
      const dbAgent = await contentRepos(principal).agents.findById(params.id);
      if (!dbAgent) {
        return { error: 'Agent not found' };
      }

      const { agentEventRepository } = await import('@/db/repositories/agent-event-repository');
      const dbEvents = await agentEventRepository.findByAgent(params.id, after || undefined);
      const nextCursor = dbEvents.at(-1)?.id ?? after;

      return {
        source: 'persisted' as const,
        nextCursor,
        // Repository pages are capped at 200. An exact 200-row final page may
        // cause one empty follow-up request; that is preferable to dropping a
        // 201st row, and the durable id cursor makes the request stable.
        hasMore: dbEvents.length === 200,
        events: dbEvents.map((e) => ({
          seq: e.id,
          type: e.type,
          agentId: e.agentId,
          data: e.data,
          timestamp: e.createdAt,
        })),
      };
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({
        after: t.Optional(t.String()),
        source: t.Optional(t.Union([t.Literal('live'), t.Literal('persisted')])),
      }),
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
