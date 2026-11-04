import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import { permissionRequests, type PermissionRequest } from '../schema/permissions';
import { toolActions } from '../schema/tool-actions';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Only the immutable recovery request snapshot is authority, never a generic tool grant. */
export function recoveryActionIds(request: PermissionRequest): string[] {
  if (request.toolId !== 'action_recovery' || !['retry', 'replay_pipeline'].includes(request.action) || !request.sessionId) return [];
  const args = request.context?.toolArguments ?? {};
  if (args.recoveryActionIds !== undefined) {
    const ids = args.recoveryActionIds;
    return Array.isArray(ids) && ids.every(id => typeof id === 'string' && uuid.test(id)) ? [...new Set(ids.map(id => id.toLowerCase()))] : [];
  }
  // Compatibility with server-issued requests from before snapshots had IDs.
  // Read only describeActions record lines, never arbitrary UUIDs in prose.
  const text = request.action === 'retry' ? args.previousActions : args.warning;
  if (typeof text !== 'string') return [];
  return [...new Set([...text.matchAll(/^- [^\r\n]+ at [0-9TZ:.+-]+: [^\r\n]*; record ([0-9a-f-]{36})$/gim)]
    .map(match => match[1].toLowerCase()).filter(id => uuid.test(id)))];
}

/** Commit with the approval itself, before a waiter/worker can disconnect. Status stays uncertain. */
export async function acknowledgeRecoveryApproval(
  request: PermissionRequest,
  db: Pick<ReturnType<typeof getDb>, 'update'> = getDb(),
): Promise<number> {
  if (request.status !== 'approved') return 0;
  const ids = recoveryActionIds(request);
  if (!ids.length || !request.sessionId) return 0;
  const rows = await db.update(toolActions).set({ reviewedAt: request.resolvedAt ?? new Date(), reviewId: request.id })
    .where(and(eq(toolActions.userId, request.userId), eq(toolActions.sessionId, request.sessionId),
      inArray(toolActions.id, ids), isNull(toolActions.reviewedAt),
      // Keep microsecond ordering in the database: JS Date would truncate the
      // request timestamp and reject an action from earlier in the same ms.
      lte(toolActions.createdAt, sql`(SELECT ${permissionRequests.createdAt} FROM ${permissionRequests} WHERE ${permissionRequests.id} = ${request.id})`)))
    .returning({ id: toolActions.id });
  return rows.length;
}
