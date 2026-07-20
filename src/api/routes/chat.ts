import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getOrchestratorService } from '@/core/orchestrator';
import { scopedRepos } from '@/db/repositories/scoped';
import { checkProjectPath, devModeAllowed } from '@/security/devmode';
import { isAuthenticated, requireScope } from '@/security/principal';
import { API_SCOPES } from '@/security/scopes';
import { generateId } from '@/utils/crypto';
import { apiLogger } from '@/utils/logger';

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
