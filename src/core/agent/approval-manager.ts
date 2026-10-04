import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { getNotificationService } from '@/core/notification-service';
import type { AgentContext } from '@/core/types';
import { getDb } from '@/db/postgres';
import { isUuid } from '@/db/repositories/scoped';
import { agentApprovals, type AgentApproval } from '@/db/schema/agent-approvals';
import { coreLogger } from '@/utils/logger';
import type { TurnEvent } from './service';

/** Stamped on every row this process writes, so a waiter lost here is told apart from one lost to a restart. */
const BOOT_ID = randomUUID();

/** What the user is told when they answer a request whose agent died with a previous process. */
export const ORPHANED_APPROVAL_MESSAGE =
  'This approval request has expired: the server restarted while it was waiting, so the agent that asked ' +
  'is no longer running. Ask again to rerun the step.';

/** What the user is told when they answer a request after it timed out. */
export const TIMED_OUT_APPROVAL_MESSAGE =
  'This approval request has expired: nobody answered in time, so the agent carried on without it.';

/**
 * Whether a phrase reads as yes or no ("go ahead", "Stop Pipeline"), or null.
 * Used to read an approval's option labels; a typed reply goes through the
 * stricter `replyAnswer`.
 */
export function approvalAnswer(message: string): 'approve' | 'deny' | null {
  const normalized = message.trim().toLowerCase();
  if (/^(approve|yes|go\s*ahead|proceed|confirm|accept|lgtm|ship\s*it)\b/i.test(normalized)) return 'approve';
  if (/^(deny|reject|no|stop|cancel|abort|don'?t)\b/i.test(normalized)) return 'deny';
  return null;
}

/**
 * A typed reply as an answer to an approval, or null. The whole message may
 * be any approve / deny word ("yes", "stop", "go ahead"); a longer message
 * only counts when it opens with one that cannot start a request ("yes,
 * ship it", "no, not yet"). "Cancel my 3pm with Bob" or "stop the staging
 * server" are requests, and answering them would decide a step by accident.
 */
export function replyAnswer(message: string): 'approve' | 'deny' | null {
  const t = message.trim().replace(/[.!]+$/, '').trim();
  if (/^(approve|approved|yes|y|go\s*ahead|proceed|confirm|accept|lgtm|ship\s*it)$/i.test(t)) return 'approve';
  if (/^(deny|denied|reject|rejected|no|n|stop|cancel|abort|don'?t)$/i.test(t)) return 'deny';
  if (/^(yes|yep|yeah|approve|approved|lgtm|go\s*ahead|proceed)\b/i.test(t)) return 'approve';
  if (/^(no|nope|deny|denied|reject|rejected|don'?t)\b/i.test(t)) return 'deny';
  return null;
}

/**
 * What an approval asks. A `gate` is a go / no-go on a step: a typed "no",
 * "stop" or "abort" declines it, and so does choosing an option worded that
 * way ("Stop Pipeline"). A `question` asks for an answer (a pipeline's
 * human-input node): choosing any option is the answer, even one that reads
 * "No".
 */
export type ApprovalKind = 'gate' | 'question';

export type ApprovalResolveOutcome =
  | { status: 'resolved' }
  /** Unknown id, or one owned by someone else — deliberately indistinguishable. */
  | { status: 'not_found' }
  | { status: 'already_resolved' }
  | { status: 'timed_out'; message: string }
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
 * Expire pending rows (all of them, or just `ids`) and tell each owner why;
 * the reason is kept in `response`. Conditional on `status = 'pending'`, so a
 * row answered concurrently keeps its answer. Returns the rows this call expired.
 */
async function expirePending(ids: string[] | null, why: string): Promise<AgentApproval[]> {
  const pending = eq(agentApprovals.status, 'pending');
  const expired = await getDb()
    .update(agentApprovals)
    .set({ status: 'expired', response: why, resolvedAt: new Date() })
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
 *
 * Assumes a single instance per database, as `releaseOrphanedRequests` in
 * security/permissions.ts does: a second process booting would expire the
 * first one's live requests.
 */
export async function releaseOrphanedApprovals(): Promise<number> {
  const released = await expirePending(null, ORPHANED_APPROVAL_MESSAGE);
  if (released.length > 0) {
    coreLogger.info({ count: released.length }, 'Released agent approvals orphaned by a restart');
  }
  return released.length;
}

/**
 * Agent approvals. The `agent_approvals` row is the durable record; the Map is
 * the registry of live in-process waiters and the listing source, which is
 * complete under the single-instance assumption (see releaseOrphanedApprovals).
 */
export class ApprovalManager {
  private pendingApprovals: Map<string, ApprovalRequest> = new Map();
  /** Settles to whether the row was written; resolution waits on it so its UPDATE sees the row. */
  private persisted: Map<string, Promise<boolean>> = new Map();
  /** Claimed by an answer whose UPDATE is still in flight; a racing answer is refused. */
  private settling: Set<string> = new Set();
  /**
   * Answered in memory but the row could not be updated, so it is still
   * `pending`. A later answer must not expire (and "time out") a request the
   * agent already acted on. Bounded; oldest entries drop first.
   */
  private unpersisted: Map<string, { userId: string; status: 'approved' | 'denied' }> = new Map();

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
    kind: ApprovalKind = 'gate',
  ): Promise<unknown> {
    const requestId = randomUUID();

    emitFn({
      type: 'approval_required',
      sessionId: context.sessionId,
      userId: context.userId,
      data: { requestId, summary, question, options, kind },
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
        // An answer landing before this write finds the row pending with our
        // boot id and is told it timed out. If the write fails, the next
        // boot sweep expires the row.
        void claimed.written.then(async (ok) => { if (ok) await expirePending([requestId], TIMED_OUT_APPROVAL_MESSAGE); })
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
   * Only the requester answers: `forUserId` must own the request, or the
   * answer is refused as `not_found`. `resolvedBy` is recorded.
   */
  async resolveApproval(
    requestId: string,
    approved: boolean,
    response: string | undefined,
    by: { forUserId: string; resolvedBy?: string },
  ): Promise<boolean> {
    return (await this.resolveApprovalDetailed(requestId, approved, response, by)).status === 'resolved';
  }

  /** `resolveApproval`, saying why it failed — callers use it to explain an expired request. */
  async resolveApprovalDetailed(
    requestId: string,
    approved: boolean,
    response: string | undefined,
    by: { forUserId: string; resolvedBy?: string },
  ): Promise<ApprovalResolveOutcome> {
    return this.settle(requestId, approved, response, by.forUserId, by.resolvedBy ?? by.forUserId);
  }

  /**
   * An admin answering another user's request. The one caller is the audited
   * `POST /api/admin/approvals/:id/resolve`, which records who answered for
   * whom and why; no other path skips the owner check. Returns the request's
   * owner and session (when a waiter was found) for that audit row.
   */
  async resolveApprovalAsAdmin(
    requestId: string,
    approved: boolean,
    response: string | undefined,
    adminUserId: string,
  ): Promise<{ outcome: ApprovalResolveOutcome; request?: { userId: string; sessionId: string } }> {
    const approval = this.pendingApprovals.get(requestId);
    const outcome = await this.settle(requestId, approved, response, null, adminUserId);
    return { outcome, request: approval ? { userId: approval.userId, sessionId: approval.sessionId } : undefined };
  }

  /** `owner` null skips the owner check — only `resolveApprovalAsAdmin` passes it. */
  private async settle(
    requestId: string,
    approved: boolean,
    response: string | undefined,
    owner: string | null,
    resolvedBy: string,
  ): Promise<ApprovalResolveOutcome> {
    const approval = this.pendingApprovals.get(requestId);
    if (!approval) {
      if (this.settling.has(requestId)) return { status: 'already_resolved' };
      return this.resolveWithoutWaiter(requestId, owner);
    }
    if (owner !== null && approval.userId !== owner) return { status: 'not_found' };

    // Claimed synchronously, so a second answer racing this one finds no waiter.
    const { written } = this.claim(requestId)!;
    this.settling.add(requestId);
    try {
      const text = response || (approved ? 'approved' : 'denied');
      if (await written) {
        const updated = await this.markResolved(requestId, approved, text, resolvedBy);
        if (updated === false) {
          // The row left `pending` under us: honour the DB.
          approval.reject('Approval expired');
          return { status: 'already_resolved' };
        }
        if (updated === null) {
          this.unpersisted.set(requestId, { userId: approval.userId, status: approved ? 'approved' : 'denied' });
          if (this.unpersisted.size > 1000) this.unpersisted.delete(this.unpersisted.keys().next().value!);
        }
      }

      if (approved) {
        approval.resolve(text);
      } else {
        approval.reject(text);
      }
      return { status: 'resolved' };
    } finally {
      this.settling.delete(requestId);
    }
  }

  /**
   * Try to resolve a pending approval from a chat message (e.g. "yes", "approve").
   */
  async tryResolveFromMessage(message: string, forUserId: string): Promise<boolean> {
    const approvals = this.getPendingApprovals(forUserId);
    if (approvals.length !== 1) return false;

    const answer = replyAnswer(message);
    if (!answer) return false;
    return this.resolveApproval(approvals[0].id, answer === 'approve', message, { forUserId, resolvedBy: forUserId });
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

  /**
   * Expire every pending approval of `userId` — the live waiters (their agents
   * resume with a denial) and any row left pending without one. Used when the
   * account is deactivated: nobody may answer those prompts any more. Returns
   * how many rows were expired.
   *
   * `inSessions` narrows it to approvals raised in those sessions (a member
   * removed from a space loses the prompts of their sessions there only).
   */
  async expireForUser(userId: string, why: string, inSessions?: ReadonlySet<string>): Promise<number> {
    if (inSessions && inSessions.size === 0) return 0;
    const claimed = this.getPendingApprovals(userId)
      .filter((approval) => !inSessions || inSessions.has(approval.sessionId))
      .map((approval) => this.claim(approval.id))
      .filter((c): c is NonNullable<typeof c> => c !== null);
    for (const { approval } of claimed) approval.reject(why);
    // A waiter's row may still be in flight; expire it only once written.
    await Promise.all(claimed.map((c) => c.written));
    const expired = await this.db
      .update(agentApprovals)
      .set({ status: 'expired', response: why, resolvedAt: new Date() })
      .where(and(
        eq(agentApprovals.status, 'pending'),
        eq(agentApprovals.userId, userId),
        inSessions ? inArray(agentApprovals.sessionId, [...inSessions]) : undefined,
      ))
      .returning({ id: agentApprovals.id });
    return expired.length;
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
        sessionId: isUuid(approval.sessionId) ? approval.sessionId : null,
        agentId,
        bootId: BOOT_ID,
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

  /**
   * Conditional write of the answer: true if this call settled the row, false
   * if it was no longer pending, null if the DB failed twice. On null the agent
   * still proceeds in memory and the id goes into `unpersisted`, so later answers
   * in this process are refused without touching the row. The row itself stays
   * pending, and the next boot sweep marks this answered request expired (and
   * notifies) — a known gap.
   */
  private async markResolved(requestId: string, approved: boolean, response: string, resolvedBy?: string): Promise<boolean | null> {
    const status = approved ? 'approved' : 'denied';
    for (let attempt = 1; ; attempt++) {
      try {
        const rows = await this.db
          .update(agentApprovals)
          .set({ status, response, resolvedBy: resolvedBy && isUuid(resolvedBy) ? resolvedBy : null, resolvedAt: new Date() })
          .where(and(eq(agentApprovals.id, requestId), eq(agentApprovals.status, 'pending')))
          .returning({ id: agentApprovals.id });
        return rows.length > 0;
      } catch (err) {
        if (attempt < 2) continue;
        coreLogger.error({ err, requestId, status }, 'Could not record approval answer; resolving in memory, row left pending');
        return null;
      }
    }
  }

  /**
   * An answer for a request with no waiter in this process. A pending row
   * stamped with this boot id lost its waiter to a timeout whose expiry has
   * not landed yet; one from another boot lost it to a restart. Either way
   * expire it and say which, rather than the misleading "not found".
   */
  private async resolveWithoutWaiter(requestId: string, forUserId: string | null): Promise<ApprovalResolveOutcome> {
    if (!isUuid(requestId)) return { status: 'not_found' };
    const answered = this.unpersisted.get(requestId);
    if (answered) return forUserId !== null && answered.userId !== forUserId ? { status: 'not_found' } : { status: 'already_resolved' };
    try {
      const [row] = await this.db.select().from(agentApprovals).where(eq(agentApprovals.id, requestId)).limit(1);
      if (!row || (forUserId !== null && row.userId !== forUserId)) {
        coreLogger.warn({ requestId }, 'Approval request not found');
        return { status: 'not_found' };
      }

      let reason = row.status === 'expired' ? row.response : null;
      if (row.status === 'pending') {
        reason = row.bootId === BOOT_ID ? TIMED_OUT_APPROVAL_MESSAGE : ORPHANED_APPROVAL_MESSAGE;
        const [expired] = await expirePending([requestId], reason);
        // Lost a race with the timeout's own expiry: report what it recorded.
        if (!expired) return this.resolveWithoutWaiter(requestId, forUserId);
      }

      if (reason === TIMED_OUT_APPROVAL_MESSAGE) return { status: 'timed_out', message: reason };
      if (reason === ORPHANED_APPROVAL_MESSAGE) {
        coreLogger.warn({ requestId }, 'Answer arrived for an approval orphaned by a restart');
        return { status: 'orphaned', message: reason };
      }
      return { status: 'already_resolved' };
    } catch (err) {
      coreLogger.error({ err, requestId }, 'Could not look up approval request');
      return { status: 'not_found' };
    }
  }
}
