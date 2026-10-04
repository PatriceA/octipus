import { Elysia, t } from '@/api/http';
import { sessionRepository } from '@/db/repositories/session-repository';
import { apiContext } from '@/api/context';
import { getAgentService } from '@/core/agent';
import { auditRepository } from '@/db/repositories/audit-repository';
import { recordedClientIp } from '@/security/client-ip';
import { getPermissionManager } from '@/security/permissions';
import { isAdmin, isAuthenticated, type Principal } from '@/security/principal';

/**
 * The one door through which an admin answers another user's request.
 *
 * Permission requests (the tool gate) and root-agent approvals are answered
 * by their requester on every generic path — REST and the gateway. An
 * admin who must unblock someone else's run does it here, with a reason, and
 * each answer writes an audit row filed under the admin naming the requester,
 * next to the manager's own row filed under the requester naming the admin.
 */

type AdminCtx = {
  set: { status?: number | string };
  user: { id: string } | null;
  principal: Principal;
};

function requireAdmin(ctx: AdminCtx): { error: string } | null {
  if (!ctx.user || !isAuthenticated(ctx.principal)) {
    ctx.set.status = 401;
    return { error: 'Authentication required' };
  }
  if (!isAdmin(ctx.principal)) {
    ctx.set.status = 403;
    return { error: 'Admin access required' };
  }
  return null;
}

/**
 * Whether an admin may answer for a request raised in `sessionId`: not when
 * the session is in a space the admin is not a member of (D9).
 */
async function adminMayAnswerSession(adminUserId: string, sessionId: string): Promise<boolean> {
  const session = await sessionRepository.findById(sessionId);
  if (!session?.workspaceId) return true;
  const { sessionAudience } = await import('@/core/agent/audience');
  const { kind } = await sessionAudience(session);
  if (kind !== 'space' && kind !== 'room') return true;
  const { getMembership } = await import('@/core/spaces/service');
  return (await getMembership(adminUserId, session.workspaceId)) !== null;
}

const resolveBody = t.Object({
  approved: t.Boolean(),
  /** Why an admin answered for someone else. Required: it is the audit trail. */
  reason: t.String({ minLength: 1, maxLength: 1000 }),
});

export const adminApprovalRoutes = new Elysia({ prefix: '/admin' })
  .use(apiContext)

  // ── Tool permission requests ──────────────────────────────────
  .get(
    '/permission-requests',
    async (ctx) => {
      const refused = requireAdmin(ctx);
      if (refused) return refused;
      // Requests of a space the admin is not a member of are not theirs to see (D9).
      const requests = await getPermissionManager().getAllPendingRequests(ctx.principal.userId);
      return {
        requests: requests.map((r) => ({
          requestId: r.id,
          userId: r.userId,
          agentId: r.agentId,
          sessionId: r.sessionId,
          toolId: r.toolId,
          action: r.action,
          toolName: r.context?.toolName ?? r.action,
          createdAt: r.createdAt,
        })),
      };
    },
    { detail: { tags: ['admin'] } },
  )

  .post(
    '/permission-requests/:id/resolve',
    async (ctx) => {
      const refused = requireAdmin(ctx);
      if (refused) return refused;
      const { params, body, principal, request, socketAddress, set } = ctx;
      // A request of a space the admin is not a member of is refused like a
      // missing one (D9, I3): `resolveAsAdmin` never matches it.
      const resolved = await getPermissionManager().resolveAsAdmin(params.id, body.approved, principal.userId, body.reason);
      if (!resolved) {
        set.status = 404;
        return { error: 'Permission request not found or already resolved' };
      }
      await auditRepository.log({
        userId: principal.userId,
        action: body.approved ? 'permission_granted' : 'permission_denied',
        resourceType: 'permission',
        resourceId: params.id,
        sessionId: resolved.sessionId || undefined,
        ipAddress: recordedClientIp(request, socketAddress),
        details: {
          adminResolution: true,
          requesterUserId: resolved.userId,
          toolId: resolved.toolId,
          action: resolved.action,
          reason: body.reason,
        },
      });
      return { resolved: true, status: resolved.status, requesterUserId: resolved.userId };
    },
    {
      params: t.Object({ id: t.String() }),
      body: resolveBody,
      detail: { tags: ['admin'] },
    },
  )

  // ── Root-agent approvals ──────────────────────────────────────
  .get(
    '/approvals',
    async (ctx) => {
      const refused = requireAdmin(ctx);
      if (refused) return refused;
      const visible: ReturnType<ReturnType<typeof getAgentService>['getPendingApprovals']> = [];
      for (const a of getAgentService().getPendingApprovals()) {
        if (await adminMayAnswerSession(ctx.principal.userId, a.sessionId)) visible.push(a);
      }
      return {
        approvals: visible.map((a) => ({
          requestId: a.id,
          userId: a.userId,
          sessionId: a.sessionId,
          summary: a.summary,
          question: a.question,
          options: a.options,
          createdAt: a.createdAt,
        })),
      };
    },
    { detail: { tags: ['admin'] } },
  )

  .post(
    '/approvals/:id/resolve',
    async (ctx) => {
      const refused = requireAdmin(ctx);
      if (refused) return refused;
      const { params, body, principal, request, socketAddress, set } = ctx;
      // An approval raised in a space the admin is not a member of is refused
      // like a missing one (D9, I3).
      const pending = getAgentService().getPendingApprovals().find((a) => a.id === params.id);
      if (pending && !(await adminMayAnswerSession(principal.userId, pending.sessionId))) {
        set.status = 404;
        return { error: 'Approval request not found or already resolved' };
      }
      const { outcome, request: owner } = await getAgentService().resolveApprovalAsAdmin(
        params.id, body.approved, body.response, principal.userId,
      );
      if (outcome.status !== 'resolved') {
        set.status = outcome.status === 'not_found' ? 404 : 409;
        return { error: 'message' in outcome ? outcome.message : 'Approval request not found or already resolved' };
      }
      await auditRepository.log({
        userId: principal.userId,
        action: body.approved ? 'permission_granted' : 'permission_denied',
        resourceType: 'agent_approval',
        resourceId: params.id,
        ipAddress: recordedClientIp(request, socketAddress),
        details: {
          adminResolution: true,
          requesterUserId: owner?.userId,
          requesterSessionId: owner?.sessionId,
          response: body.response,
          reason: body.reason,
        },
      });
      return { resolved: true, requesterUserId: owner?.userId };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        approved: t.Boolean(),
        reason: t.String({ minLength: 1, maxLength: 1000 }),
        /** The answer text handed to the agent; defaults to approved / denied. */
        response: t.Optional(t.String({ maxLength: 4000 })),
      }),
      detail: { tags: ['admin'] },
    },
  );
