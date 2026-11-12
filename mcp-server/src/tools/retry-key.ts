/**
 * `clientRequestId` on tools that create work (chat turns, agents, tasks,
 * pipelines, hooks). Sent as the backend's `Idempotency-Key`: a retry with the
 * same id returns what the first call created instead of creating it again.
 *
 * The id must come from the model to help a model retry — a new tool call is a
 * new invocation here, so an id generated per call would differ between the
 * call and its retry. When the model gives none, the tool generates one and
 * names it in a timeout answer, so the retry can carry it.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, isClientTimeout } from '../client.js';

export const clientRequestIdSchema = z.string().min(1).max(200).optional().describe(
  'Optional retry key. Use a fresh unique value (e.g. a UUID) for each new request. If this call times out or ' +
  'its outcome is unclear, retry with the SAME clientRequestId: the work it already started is returned instead ' +
  'of being created twice.',
);

/** The caller's retry key, or a generated one for this call. */
export function retryKey(clientRequestId: string | undefined): string {
  return clientRequestId || randomUUID();
}

/**
 * What to tell the model when a creating call timed out on the client or is
 * still running on the server, or null for an ordinary failure.
 */
export function retryNotice(error: unknown, tool: string, key: string): string | null {
  const retry = `To get its result, call ${tool} again with the same arguments and clientRequestId "${key}"; do not send it as a new request.`;
  if (isClientTimeout(error)) {
    return `No answer within the client timeout, but Octipus may still be working on it (the request was not cancelled on the server). ${retry}`;
  }
  if (error instanceof ApiError && error.status === 409) {
    const body = (error.body ?? {}) as { code?: string; sessionId?: string };
    if (body.code === 'idempotency_in_progress') {
      const where = body.sessionId ? ` in session ${body.sessionId} (octipus_get_messages shows its progress)` : '';
      return `Octipus is still working on this request${where}. ${retry}`;
    }
  }
  return null;
}
