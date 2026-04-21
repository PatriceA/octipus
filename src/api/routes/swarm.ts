/**
 * Swarm admin API (Phase 3).
 *
 * Read + cancel endpoints for the swarm-node tree. Primary consumer is the
 * web live tree (`web/components/swarm-tree.tsx`); gateway events are the
 * live push channel, these routes are the REST fallback for rehydration +
 * explicit per-node cancel.
 *
 * Authorization rules (all enforced here — no middleware magic):
 *  - Admin users see/act on any node.
 *  - Non-admins may only touch nodes whose `rootSessionId` is a session
 *    they own (checked via `sessionRepository.findById`).
 *
 * Integration pattern mirrors `src/api/routes/agents.ts` — pure Elysia +
 * Drizzle, no new middleware, errors returned as `{ error }` bodies with a
 * 200 status (the rest of the API uses the same convention).
 */
import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getAgentManager } from '@/core/agent-manager';
import { swarmNodeRepository } from '@/core/swarm/node-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { SwarmNodeRecord } from '@/db/schema/swarm-nodes';
import { apiLogger } from '@/utils/logger';

/**
 * Check the caller has permission to act on a given `rootSessionId`.
 * Admins bypass; non-admins must own the session.
 */
async function canAccessRootSession(
  user: { id: string; isAdmin: boolean },
  rootSessionId: string,
): Promise<boolean> {
  if (user.isAdmin) return true;
  try {
    const session = await sessionRepository.findById(rootSessionId);
    if (!session) return false;
    return session.userId === user.id;
  } catch (err) {
    apiLogger.error({ err, rootSessionId }, 'Failed to check session ownership for swarm node');
    return false;
  }
}

/** Strip the verbose `result` jsonb off list responses. */
function serializeNodeListItem(n: SwarmNodeRecord) {
  return {
    id: n.id,
    rootSessionId: n.rootSessionId,
    parentNodeId: n.parentNodeId,
    depth: n.depth,
    kind: n.kind,
    role: n.role,
    expertId: n.expertId,
    topicPath: n.topicPath,
    subtopic: n.subtopic,
    model: n.model,
    status: n.status,
    tokenCap: n.tokenCap,
    tokensUsed: n.tokensUsed,
    wallClockCapMs: n.wallClockCapMs,
    fanOutCap: n.fanOutCap,
    fanOutUsed: n.fanOutUsed,
    cacheHits: n.cacheHits,
    briefHash: n.briefHash,
    taskBriefPreview: n.taskBriefPreview,
    result: n.result,
    createdAt: n.createdAt,
    completedAt: n.completedAt,
    error: n.error,
  };
}

export const swarmRoutes = new Elysia({ prefix: '/swarm' })
  .use(apiContext)

  // ── List all nodes for a root session ───────────────────────────────
  //
  // Rehydration fallback for the web live tree: if the WS replay buffer
  // has aged out (>200 swarm events per session) the UI calls this route
  // to rebuild the tree before subscribing to new events.
  .get(
    '/nodes',
    async ({ user, query }) => {
      if (!user) return { error: 'Not authenticated' };
      const rootSessionId = query.rootSessionId;
      if (!rootSessionId) return { error: 'rootSessionId is required' };

      const allowed = await canAccessRootSession(user, rootSessionId);
      if (!allowed) return { error: 'Not authorized' };

      try {
        const nodes = await swarmNodeRepository.findByRootSession(rootSessionId);
        return { nodes: nodes.map(serializeNodeListItem) };
      } catch (err) {
        apiLogger.error({ err, rootSessionId }, 'Failed to list swarm nodes');
        return { error: 'Failed to list swarm nodes' };
      }
    },
    {
      query: t.Object({ rootSessionId: t.String() }),
      detail: { tags: ['swarm'], description: 'List swarm nodes in a session (tree rehydration).' },
    },
  )

  // ── Single-node detail (full result jsonb) ──────────────────────────
  .get(
    '/nodes/:id',
    async ({ user, params }) => {
      if (!user) return { error: 'Not authenticated' };

      try {
        const node = await swarmNodeRepository.findById(params.id);
        if (!node) return { error: 'Swarm node not found' };

        const allowed = await canAccessRootSession(user, node.rootSessionId);
        if (!allowed) return { error: 'Not authorized' };

        return {
          node: {
            ...serializeNodeListItem(node),
            result: node.result,
          },
        };
      } catch (err) {
        apiLogger.error({ err, id: params.id }, 'Failed to fetch swarm node');
        return { error: 'Failed to fetch swarm node' };
      }
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['swarm'] },
    },
  )

  // ── Cancel a node + all descendants ─────────────────────────────────
  //
  // Emulates the `AgentManager.stop(id, { cascade:true })` behaviour
  // described in `.assistant/swarm-design.md §Cancellation`. Discovers
  // descendants in DB, then calls `AgentManager.stop(childId)` on each
  // (live agents stop via their abort controller; zombie DB rows are
  // flipped to `cancelled` by the stop path).
  .post(
    '/nodes/:id/cancel',
    async ({ user, params }) => {
      if (!user) return { error: 'Not authenticated' };

      try {
        const node = await swarmNodeRepository.findById(params.id);
        if (!node) return { error: 'Swarm node not found' };

        const allowed = await canAccessRootSession(user, node.rootSessionId);
        if (!allowed) return { error: 'Not authorized' };

        const agentManager = getAgentManager();

        // Collect descendants first so the returned list reflects the full
        // cascade target set even if the stop path has side effects.
        const descendants = await swarmNodeRepository.findDescendants(node.id);

        // Stop self + descendants. `AgentManager.stop` is idempotent and
        // handles non-live rows — we don't need to differentiate.
        const targets = [node.id, ...descendants.map((d) => d.id)];
        let stoppedLive = 0;
        for (const id of targets) {
          try {
            if (agentManager.stop(id)) stoppedLive++;
          } catch (err) {
            apiLogger.warn({ err, id }, 'Failed to stop swarm node (continuing cascade)');
          }
        }

        // Flip DB rows still marked `running` to `cancelled` so the UI
        // reflects the cancel immediately (live agents' stop path will
        // also persist, but we don't want to race the UI).
        const STILL_RUNNING: Array<'running'> = ['running'];
        for (const id of targets) {
          try {
            const fresh = await swarmNodeRepository.findById(id);
            if (fresh && STILL_RUNNING.includes(fresh.status as 'running')) {
              await swarmNodeRepository.updateStatus(id, {
                status: 'cancelled',
                error: 'cancelled_by_user',
              });
            }
          } catch (err) {
            apiLogger.warn({ err, id }, 'Failed to persist cancel status for swarm node');
          }
        }

        apiLogger.info(
          {
            nodeId: node.id,
            rootSessionId: node.rootSessionId,
            descendants: descendants.length,
            stoppedLive,
            actor: user.id,
          },
          'Swarm node cancelled via admin API',
        );

        return {
          cancelled: true,
          nodeId: node.id,
          descendantIds: descendants.map((d) => d.id),
          stoppedLive,
        };
      } catch (err) {
        apiLogger.error({ err, id: params.id }, 'Failed to cancel swarm node');
        return { error: 'Failed to cancel swarm node' };
      }
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['swarm'] },
    },
  );
