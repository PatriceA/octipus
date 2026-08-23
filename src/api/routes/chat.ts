import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getOrchestratorService } from '@/core/orchestrator';
import { scopedRepos } from '@/db/repositories/scoped';
import { checkProjectPath, devModeAllowed } from '@/security/devmode';
import { isAuthenticated, requireScope } from '@/security/principal';
import { API_SCOPES } from '@/security/scopes';
import { swarmNodeRepository } from '@/core/swarm/node-repository';
import { generateId } from '@/utils/crypto';
import { apiLogger } from '@/utils/logger';

/**
 * The specialist roles this turn actually delegated to.
 *
 * The turn's `agentId` is the ORCHESTRATOR's, so it says nothing about where
 * the work went. The routing decision lives in the swarm nodes spawned under
 * this session, which is the only place it is recorded as fact rather than as
 * intent.
 *
 * Added for the eval harness, whose `routes_to_role` assertion previously read
 * the classifier's own topic — the function under test answering the question
 * about itself.
 *
 * The turn boundary is a timestamp rather than the set of node ids that existed
 * before the turn. Bracketing by identity meant two unbounded
 * `findByRootSession` calls per chat turn — one before, one awaited inside the
 * response literal and therefore on the wire-time critical path of every reply
 * — for a field only the eval harness reads.
 *
 * The reason identity was chosen originally still stands and is answered rather
 * than ignored: `swarm_nodes.created_at` is stamped by Postgres, so a boundary
 * from the app's `new Date()` compares two clocks, and any negative skew drops
 * the children created in the turn's first moments — a flaky red for the very
 * assertion this exists to make honest. So the boundary comes from the DATABASE
 * clock (`swarmNodeRepository.now()`), which is one trivial round trip with no
 * rows and no scan, and both sides of the comparison are the same clock again.
 *
 * Best-effort throughout: a lookup failure returns nothing rather than failing
 * the reply, because a missing diagnostic field must never cost the user their
 * answer.
 */
async function routedRolesForTurn(sessionId: string, since: Date): Promise<string[] | undefined> {
  try {
    const fresh = await swarmNodeRepository.findChildrenSince(sessionId, since);
    return [...new Set(fresh.reverse().map((n) => n.role))];
  } catch (err) {
    apiLogger.warn({ err, sessionId }, 'routed-role lookup failed — reply omits routedRoles');
    return undefined;
  }
}

/**
 * Chat — Phase 1a multi-user conversion.
 *
 * - POST /chat: session ownership check moves to the scoped session repo.
 *   Cross-tenant session ids surface as "Session not found" rather than
 *   "Not authorized" (collapses 403/404 to prevent ID enumeration).
 * - GET /chat/approvals/pending: was global — leaked one user's pending
 *   approval prompts to every other authenticated caller. Now filtered
 *   to the principal (or all, for admins). ApprovalRequest gained a
 *   userId field to make this filter possible.
 * - POST /chat/approve: was reachable by anyone with the requestId.
 *   Now verifies the principal owns the approval before resolving.
 *
 * ## Blocking contract (docs/plans/blocked-vs-stuck.md Phase 2)
 *
 * `POST /chat` BLOCKS until the turn finishes. If the turn raises an approval
 * it blocks until a human answers or `orchestrator.approvalTimeoutMs` (1h)
 * expires. This is deliberate — the web UI and TUI expect the finished answer
 * on the response — but it means a REST caller sees only a quiet socket.
 *
 * A REST caller MUST drive approvals out-of-band on a second connection:
 * poll `GET /chat/approvals/pending` and answer via `POST /chat/approve` while
 * the original request is still in flight. `scripts/e2e/approvals.ts`
 * (`autoApproveLoop`) is the supported helper.
 *
 * WebSocket clients need none of this: the approval is pushed as
 * `orchestrator.approval_required`. Since Phase 1, `agent.blocked` also names
 * WHAT a quiet turn is waiting for (your approval / a child / a long tool),
 * every ~20s — so the silence is legible even before the approval lands.
 */
export const chatRoutes = new Elysia({ prefix: '/chat' })
  .use(apiContext)

  // Send a chat message through the orchestrator
  .post(
    '/',
    async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }

      // WS6 — enforce the `api:chat` scope. No-op for browser sessions and
      // unscoped tokens (both full-access); only a token minted with an
      // explicit scope set lacking `api:chat` is rejected here.
      if (!requireScope(principal, API_SCOPES.CHAT)) {
        set.status = 403;
        return { error: `API token missing required scope "${API_SCOPES.CHAT}"` };
      }

      let { sessionId } = body;
      const { message, channel } = body;

      const repos = scopedRepos(principal);

      // devMode/projectPath point the agent at an arbitrary host path — only
      // honor them for a single-user install or an admin (see devModeAllowed).
      // A non-admin request on a shared instance has them dropped, not errored,
      // so a stray devMode flag doesn't break the chat turn.
      const allowDev = devModeAllowed(!!user.isAdmin, body.projectPath);
      if ((body.devMode || body.projectPath) && !allowDev) {
        // Admin + rejected ⇒ the path is the problem, not the caller.
        const pathReason =
          user.isAdmin && body.projectPath ? checkProjectPath(body.projectPath).reason : undefined;
        apiLogger.warn(
          { userId: user.id, projectPath: body.projectPath, reason: pathReason },
          pathReason
            ? 'Ignoring devMode/projectPath — rejected project path'
            : 'Ignoring devMode/projectPath from non-admin under multiuser',
        );
      }

      // Auto-create a session if none provided
      if (!sessionId) {
        const session = await repos.sessions.create({
          channelType: channel || 'webchat',
          channelId: `chat-${generateId().slice(0, 8)}`,
          title: message.slice(0, 100),
          context: {
            devMode: allowDev ? body.devMode : undefined,
            projectPath: allowDev ? body.projectPath : undefined,
            projectName: allowDev && body.projectPath ? body.projectPath.split('/').pop() : undefined,
          },
        });
        sessionId = session.id;
      } else {
        // Verify session ownership through the scoped repo.
        const session = await repos.sessions.findById(sessionId);
        if (!session) {
          return { error: 'Session not found' };
        }
      }

      const orchestrator = getOrchestratorService();

      // Marks this turn's boundary on the DATABASE clock, so the roles reported
      // below are the ones THIS request routed to and not a previous turn's.
      // Falls back to no boundary rather than failing the turn: `routedRoles`
      // is a diagnostic, and losing it must never cost the user their answer.
      const turnStartedAt = await swarmNodeRepository.now().catch((err: unknown) => {
        apiLogger.warn({ err, sessionId }, 'turn-boundary clock read failed — reply omits routedRoles');
        return null;
      });
      try {
        const result = await orchestrator.handleMessage(
          sessionId,
          user.id,
          message,
          channel,
          body.expertId,
          body.fileRefs,
          body.outputMode,
        );

        return {
          response: result.response,
          sessionId: result.sessionId || sessionId,
          agentId: result.agentId,
          classification: result.classification,
          routedRoles: turnStartedAt
            ? await routedRolesForTurn(result.sessionId || sessionId, turnStartedAt)
            : undefined,
          metadata: result.metadata,
        };
      } catch (error) {
        apiLogger.error({ error, sessionId }, 'Chat request failed');
        return {
          error: 'Failed to process message',
          details: (error as Error).message,
        };
      }
    },
    {
      body: t.Object({
        message: t.String({ minLength: 1 }),
        sessionId: t.Optional(t.String()),
        channel: t.Optional(t.String()),
        expertId: t.Optional(t.String()),
        devMode: t.Optional(t.Boolean()),
        projectPath: t.Optional(t.String()),
        // Edit-and-continue: session files to inline (current version) into
        // this turn's context — `.octipus/end-user-ux-design.md` Thread 2.
        fileRefs: t.Optional(t.Array(t.Object({
          path: t.String(),
          version: t.Optional(t.String()),
        }), { maxItems: 10 })),
        // Chat/work split (Thread 3): force the deliverable mode for this message.
        outputMode: t.Optional(t.Union([t.Literal('inline'), t.Literal('file')])),
      }),
      detail: { tags: ['chat'] },
    },
  )

  // Resolve an approval request
  .post(
    '/approve',
    async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }
      if (!requireScope(principal, API_SCOPES.CHAT)) {
        set.status = 403;
        return { error: `API token missing required scope "${API_SCOPES.CHAT}"` };
      }

      const orchestrator = getOrchestratorService();
      const approval = orchestrator.peekApproval(body.requestId);

      // Collapse "doesn't exist" and "not yours" into the same response so
      // attackers can't tell whether a requestId is currently pending.
      if (!approval || (!user.isAdmin && approval.userId !== user.id)) {
        return { error: 'Approval request not found or already resolved' };
      }

      const resolved = orchestrator.resolveApproval(
        body.requestId,
        body.approved,
        body.response,
      );

      if (!resolved) {
        return { error: 'Approval request not found or already resolved' };
      }

      return { resolved: true };
    },
    {
      body: t.Object({
        requestId: t.String(),
        approved: t.Boolean(),
        response: t.Optional(t.String()),
      }),
      detail: { tags: ['chat'] },
    },
  )

  // Get pending approvals (polling fallback when WebSocket disconnects)
  .get(
    '/approvals/pending',
    async ({ user, principal, set }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }
      if (!requireScope(principal, API_SCOPES.CHAT)) {
        set.status = 403;
        return { error: `API token missing required scope "${API_SCOPES.CHAT}"` };
      }

      const orchestrator = getOrchestratorService();
      // Admins see global list (operational triage); everyone else only
      // their own pending approvals.
      const pending = user.isAdmin
        ? orchestrator.getPendingApprovals()
        : orchestrator.getPendingApprovals(user.id);

      return {
        approvals: pending.map((a) => ({
          requestId: a.id,
          summary: a.summary,
          question: a.question,
          options: a.options,
          createdAt: a.createdAt,
        })),
      };
    },
    {
      detail: { tags: ['chat'] },
    },
  );
