import { generateId } from '@/utils/crypto';
import { coreLogger } from '@/utils/logger';
import { getNotificationService } from '@/core/notification-service';
import type { AgentContext } from '@/core/types';
import type { OrchestratorEvent } from './service';

export interface ApprovalRequest {
  id: string;
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
    emitFn: (event: OrchestratorEvent) => void,
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

      // Auto-timeout after 1 hour
      const timeout = setTimeout(() => {
        if (this.pendingApprovals.has(requestId)) {
          this.pendingApprovals.delete(requestId);
          resolve({ approved: false, reason: 'Approval timed out', requestId });
        }
      }, 3600000);

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
  tryResolveFromMessage(message: string): boolean {
    if (this.pendingApprovals.size !== 1) return false;

    const [, approval] = [...this.pendingApprovals.entries()][0];
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
   * Get all pending approvals.
   */
  getPendingApprovals(): ApprovalRequest[] {
    return [...this.pendingApprovals.values()];
  }
}
