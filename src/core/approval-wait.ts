/**
 * Reasons a CLI worker ends a run whose tool call was still waiting on a human.
 * Nobody answered, nobody said no: the caller parks the work until the user
 * answers instead of treating it as a crash, a stop or a denial. Matched by
 * substring because worker-spawner wraps them as `Worker "x" failed: …`.
 */
export const APPROVAL_TIMEOUT_REASON = 'Approval was not received within 5 minutes. The command was not run; retry after reviewing permissions.';
export const APPROVAL_DISCONNECT_REASON = 'The CLI disconnected while waiting for approval. The command was not run.';
export const APPROVAL_UNFINISHED_REASON = 'CLI finished while a tool was still waiting for approval. The command was not run.';

const REASONS = [APPROVAL_TIMEOUT_REASON, APPROVAL_DISCONNECT_REASON, APPROVAL_UNFINISHED_REASON];

export function isApprovalWaitEnded(message: string): boolean {
  return REASONS.some(reason => message.includes(reason));
}

/** `reason` naming the request the worker was waiting on, so its caller answers that request and no other. */
export function approvalWaitReason(reason: string, requestId: string | undefined): string {
  return requestId ? `${reason} [approval-request:${requestId}]` : reason;
}

export function approvalWaitRequestId(message: string): string | undefined {
  return /\[approval-request:([0-9a-f-]{36})\]/i.exec(message)?.[1];
}
