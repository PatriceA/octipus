import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { getNotificationService } from '@/core/notification-service';
import type { AgentContext } from '@/core/types';
import { getDb } from '@/db/postgres';
import { agentApprovals, type AgentApproval } from '@/db/schema/agent-approvals';
import { coreLogger } from '@/utils/logger';
import type { TurnEvent } from './service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the user is told when they answer a request whose agent died with a previous process. */
export const ORPHANED_APPROVAL_MESSAGE =
  'This approval request has expired: the server restarted while it was waiting, so the agent that asked ' +
  'is no longer running. Ask again to rerun the step.';

export type ApprovalResolveOutcome =
  | { status: 'resolved' }
  /** Unknown id, or one owned by someone else — deliberately indistinguishable. */
  | { status: 'not_found' }
  | { status: 'already_resolved' }
  | { status: 'orphaned'; message: string };

export interface ApprovalRequest {
  id: string;
  /**
   * Principal that owns this approval. Phase 1a: required so the chat
   * route can filter pending approvals per-user and reject cross-tenant
   * resolveApproval calls. Older callers reading `pendingApprovals.values()`
   * will see this field; the field is always populated by `requestApproval`.
   */
  userId: string;
  sessionId: string;
  summary: string;
  question: string;
  options?: string[];
  resolve: (response: string) => void;
  reject: (reason: string) => void;
  createdAt: Date;
}

/**
 * Expire pending rows (all of them, or just `ids`) and tell each owner.
 * Conditional on `status = 'pending'`, so a row answered concurrently keeps
 * its answer. Returns the rows this call expired.
 */
async function expirePending(ids: string[] | null, why: string): Promise<AgentApproval[]> {
  const pending = eq(agentApprovals.status, 'pending');
  const expired = await getDb()
    .update(agentApprovals)
    .set({ status: 'expired', resolvedAt: new Date() })
    .where(ids ? and(pending, inArray(agentApprovals.id, ids)) : pending)
    .returning();
  for (const row of expired) {
    getNotificationService().notify(
      row.userId,
      'approval_expired',
      'Approval Expired',
      `${row.summary}\n\n${why}`,
      { requestId: row.id, sessionId: row.sessionId },
    ).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in approval-manager'));
  }
  return expired;
}

/**
 * Mark every approval left pending by a previous process as expired.
 *
 * The promise an agent awaits lives in this process's memory, so a row still
 * `pending` at boot belongs to an agent that no longer exists and can never be
 * answered. Call once at boot, before any agent runs. Returns how many were released.
 */
export async function releaseOrphanedApprovals(): Promise<number> {
  const released = await expirePending(null, 'The server restarted before this was answered.');
  if (released.length > 0) {
    coreLogger.info({ count: released.length }, 'Released agent approvals orphaned by a restart');
  }
  return released.length;
}

export class ApprovalManager {
  /** In-process waiters. The `agent_approvals` row is the record of truth. */
  private pendingApprovals: Map<string, ApprovalRequest> = new Map();
  /** Settles to whether the row was written; resolution waits on it so its UPDATE sees the row. */
  private persisted: Map<string, Promise<boolean>> = new Map();

  private get db() { return getDb(); }

  /**
   * Request user approval. Returns a promise that resolves when the user responds.
   */
  async requestApproval(
    summary: string,
    question: string,
    context: AgentContext,
    emitFn: (event: TurnEvent) => void,
    options?: string[],
  ): Promise<unknown> {
    const requestId = randomUUID();

    emitFn({
      type: 'approval_required',
      sessionId: context.sessionId,
      userId: context.userId,
      data: { requestId, summary, question, options },
      timestamp: new Date(),
    });

    getNotificationService().notify(
      context.userId,
      'approval_required',
      'Approval Required',
      `${summary}\n\n${question}`,
      { requestId, sessionId: context.sessionId },
    ).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in approval-manager'));

    return new Promise<unknown>((resolve) => {
      const approval: ApprovalRequest = {
        id: requestId,
        userId: context.userId,
        sessionId: context.sessionId,
        summary,
        question,
        options,
        resolve: (response: string) => {
          this.pendingApprovals.delete(requestId);
          resolve({ approved: true, response, requestId });
        },
        reject: (reason: string) => {
          this.pendingApprovals.delete(requestId);
          resolve({ approved: false, reason, requestId });
        },
        createdAt: new Date(),
      };

      // Registered synchronously so getPendingApprovals sees it at once; the
      // row is written in the background.
      this.pendingApprovals.set(requestId, approval);
      this.persisted.set(requestId, this.persist(approval, context.id));

      // Auto-timeout after 1 hour unless the context overrides it. Use ?? so an
      // explicit 0 (schema-valid: immediate/disabled) isn't coerced back to 1h.
      const timeoutMs = (context.metadata?.approvalTimeoutMs as number) ?? 3600000;
      const timeout = setTimeout(() => {
        const claimed = this.claim(requestId);
        if (!claimed) return;
        resolve({ approved: false, reason: 'Approval timed out', requestId });
        void claimed.written.then(async (ok) => { if (ok) await expirePending([requestId], 'Nobody answered in time.'); })
          .catch((err: unknown) => coreLogger.error({ err, requestId }, 'Could not expire timed-out approval'));
      }, timeoutMs);

      // Clean up timeout when resolved
      const originalResolve = approval.resolve;
      const originalReject = approval.reject;
      approval.resolve = (response: string) => {
        clearTimeout(timeout);
        originalResolve(response);
      };
      approval.reject = (reason: string) => {
        clearTimeout(timeout);
        originalReject(reason);
      };
    });
  }

  /**
   * Resolve a pending approval request (called from WebSocket or API).
   * `forUserId` scopes the lookup to one owner; `resolvedBy` is recorded.
   */
  async resolveApproval(
    requestId: string,
    approved: boolean,
    response?: string,
    by?: { forUserId?: string; resolvedBy?: string },
  ): Promise<boolean> {
    return (await this.resolveApprovalDetailed(requestId, approved, response, by)).status === 'resolved';
  }

  /** `resolveApproval`, saying why it failed — callers use it to explain an orphaned request. */
  async resolveApprovalDetailed(
    requestId: string,
    approved: boolean,
    response?: string,
    by?: { forUserId?: string; resolvedBy?: string },
  ): Promise<ApprovalResolveOutcome> {
    const approval = this.pendingApprovals.get(requestId);
    if (!approval) return this.resolveWithoutWaiter(requestId, by?.forUserId);
    if (by?.forUserId && approval.userId !== by.forUserId) return { status: 'not_found' };

    // Claimed synchronously, so a second answer racing this one finds no waiter.
    const { written } = this.claim(requestId)!;
    const text = response || (approved ? 'approved' : 'denied');
    if (await written) {
      const updated = await this.markResolved(requestId, approved, text, by?.resolvedBy);
      if (updated === false) {
        // The row left `pending` under us (swept as orphaned): honour the DB.
        approval.reject('Approval expired');
        return { status: 'already_resolved' };
      }
    }

    if (approved) {
      approval.resolve(text);
    } else {
      approval.reject(text);
    }

    return { status: 'resolved' };
  }

  /**
   * Try to resolve a pending approval from a chat message (e.g. "yes", "approve").
   */
  async tryResolveFromMessage(message: string, forUserId?: string): Promise<boolean> {
    const approvals = this.getPendingApprovals(forUserId);
    if (approvals.length !== 1) return false;

    const approval = approvals[0];
    const normalized = message.trim().toLowerCase();

    const approvePatterns = /^(approve|yes|go\s*ahead|proceed|confirm|accept|lgtm|ship\s*it)\b/i;
    const denyPatterns = /^(deny|reject|no|stop|cancel|abort|don'?t)\b/i;

    if (approvePatterns.test(normalized)) {
      return this.resolveApproval(approval.id, true, message, { forUserId, resolvedBy: forUserId });
    } else if (denyPatterns.test(normalized)) {
      return this.resolveApproval(approval.id, false, message, { forUserId, resolvedBy: forUserId });
    }

    return false;
  }

  /**
   * Get pending approvals. Without arguments returns the global list
   * (used by admin tooling and the existing service signature). Pass
   * `forUserId` to scope to a single user — the chat route uses this
   * to prevent leaking pending approval prompts across tenants.
   */
  getPendingApprovals(forUserId?: string): ApprovalRequest[] {
    const all = [...this.pendingApprovals.values()];
    if (!forUserId) return all;
    return all.filter((a) => a.userId === forUserId);
  }

  /** Pending approvals as recorded in the database, oldest first. */
  async listPending(userId: string): Promise<AgentApproval[]> {
    return this.db
      .select()
      .from(agentApprovals)
      .where(and(eq(agentApprovals.userId, userId), eq(agentApprovals.status, 'pending')))
      .orderBy(asc(agentApprovals.createdAt));
  }

  /**
   * Look up a single pending approval by id without resolving it.
   * Used by the chat route to verify the principal owns the request
   * before forwarding the approve/deny decision to `resolveApproval`.
   */
  peek(requestId: string): ApprovalRequest | null {
    return this.pendingApprovals.get(requestId) ?? null;
  }

  /** Remove a waiter from the registry, returning it with its write status. */
  private claim(requestId: string): { approval: ApprovalRequest; written: Promise<boolean> } | null {
    const approval = this.pendingApprovals.get(requestId);
    if (!approval) return null;
    const written = this.persisted.get(requestId) ?? Promise.resolve(false);
    this.pendingApprovals.delete(requestId);
    this.persisted.delete(requestId);
    return { approval, written };
  }

  private async persist(approval: ApprovalRequest, agentId: string): Promise<boolean> {
    try {
      await this.db.insert(agentApprovals).values({
        id: approval.id,
        userId: approval.userId,
        sessionId: UUID_RE.test(approval.sessionId) ? approval.sessionId : null,
        agentId,
        summary: approval.summary,
        question: approval.question,
        options: approval.options ?? null,
      });
      return true;
    } catch (err) {
      coreLogger.error({ err, requestId: approval.id }, 'Could not persist approval request; holding it in memory only');
      return false;
    }
  }

  /** Conditional write of the answer: true if this call settled the row, false if it was no longer pending, null on error. */
  private async markResolved(requestId: string, approved: boolean, response: string, resolvedBy?: string): Promise<boolean | null> {
    try {
      const rows = await this.db
        .update(agentApprovals)
        .set({
          status: approved ? 'approved' : 'denied',
          response,
          resolvedBy: resolvedBy && UUID_RE.test(resolvedBy) ? resolvedBy : null,
          resolvedAt: new Date(),
        })
        .where(and(eq(agentApprovals.id, requestId), eq(agentApprovals.status, 'pending')))
        .returning({ id: agentApprovals.id });
      return rows.length > 0;
    } catch (err) {
      coreLogger.error({ err, requestId }, 'Could not record approval answer; resolving in memory');
      return null;
    }
  }

  /**
   * An answer for a request with no waiter in this process. A row still
   * `pending` means its agent died with a previous process: expire it and say
   * so, rather than the misleading "not found".
   */
  private async resolveWithoutWaiter(requestId: string, forUserId?: string): Promise<ApprovalResolveOutcome> {
    if (!UUID_RE.test(requestId)) return { status: 'not_found' };
    try {
      const [row] = await this.db.select().from(agentApprovals).where(eq(agentApprovals.id, requestId)).limit(1);
      if (!row || (forUserId && row.userId !== forUserId)) {
        coreLogger.warn({ requestId }, 'Approval request not found');
        return { status: 'not_found' };
      }
      if (row.status !== 'pending') return { status: 'already_resolved' };

      const expired = await expirePending([requestId], ORPHANED_APPROVAL_MESSAGE);
      if (expired.length === 0) return { status: 'already_resolved' };
      coreLogger.warn({ requestId }, 'Answer arrived for an approval orphaned by a restart');
      return { status: 'orphaned', message: ORPHANED_APPROVAL_MESSAGE };
    } catch (err) {
      coreLogger.error({ err, requestId }, 'Could not look up approval request');
      return { status: 'not_found' };
    }
  }
}
