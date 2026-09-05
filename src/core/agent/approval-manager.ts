import { getNotificationService } from '@/core/notification-service';
import type { AgentContext } from '@/core/types';
import { generateId } from '@/utils/crypto';
import { coreLogger } from '@/utils/logger';
import type { TurnEvent } from './service';

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

export class ApprovalManager {
  private pendingApprovals: Map<string, ApprovalRequest> = new Map();

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
    const requestId = generateId();

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
      { requestId },
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

      this.pendingApprovals.set(requestId, approval);

      // Auto-timeout after 1 hour unless the context overrides it. Use ?? so an
      // explicit 0 (schema-valid: immediate/disabled) isn't coerced back to 1h.
      const timeoutMs = (context.metadata?.approvalTimeoutMs as number) ?? 3600000;
      const timeout = setTimeout(() => {
        if (this.pendingApprovals.has(requestId)) {
          this.pendingApprovals.delete(requestId);
          resolve({ approved: false, reason: 'Approval timed out', requestId });
        }
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
   */
  resolveApproval(requestId: string, approved: boolean, response?: string): boolean {
    const approval = this.pendingApprovals.get(requestId);
    if (!approval) {
      coreLogger.warn({ requestId }, 'Approval request not found');
      return false;
    }

    if (approved) {
      approval.resolve(response || 'approved');
    } else {
      approval.reject(response || 'denied');
    }

    return true;
  }

  /**
   * Try to resolve a pending approval from a chat message (e.g. "yes", "approve").
   */
  tryResolveFromMessage(message: string, forUserId?: string): boolean {
    const approvals = this.getPendingApprovals(forUserId);
    if (approvals.length !== 1) return false;

    const approval = approvals[0];
    const normalized = message.trim().toLowerCase();

    const approvePatterns = /^(approve|yes|go\s*ahead|proceed|confirm|accept|lgtm|ship\s*it)\b/i;
    const denyPatterns = /^(deny|reject|no|stop|cancel|abort|don'?t)\b/i;

    if (approvePatterns.test(normalized)) {
      approval.resolve(message);
      return true;
    } else if (denyPatterns.test(normalized)) {
      approval.reject(message);
      return true;
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

  /**
   * Look up a single pending approval by id without resolving it.
   * Used by the chat route to verify the principal owns the request
   * before forwarding the approve/deny decision to `resolveApproval`.
   */
  peek(requestId: string): ApprovalRequest | null {
    return this.pendingApprovals.get(requestId) ?? null;
  }
}
