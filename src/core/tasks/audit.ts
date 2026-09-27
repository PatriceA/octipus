/**
 * Audit trail for task mutations (Paperclip-style): every create / update /
 * complete / delete records WHO did it (a user through the API, or an agent
 * through the tasks tool), WHICH run it belonged to, and which fields moved.
 * Field names only, never values: task titles and notes are user content.
 *
 * Best-effort by design: an audit write that fails is logged and swallowed,
 * so it can never fail the mutation it describes.
 */
import { isUuid } from '@/core/run-log';
import { auditRepository } from '@/db/repositories/audit-repository';
import { coreLogger } from '@/utils/logger';

export type TaskMutationOp = 'create' | 'update' | 'complete' | 'delete';

export interface TaskAuditActor {
  kind: 'user' | 'agent';
  id: string;
}

/** Row bookkeeping, not something a caller changes. */
const BOOKKEEPING_FIELDS = new Set(['id', 'userId', 'workspaceId', 'createdAt', 'updatedAt']);

const isEmpty = (value: unknown): boolean => value == null || (Array.isArray(value) && value.length === 0);

/**
 * Names of the fields `patch` actually changes on `existing` (every set field
 * when there is no `existing`, i.e. a create). `undefined` means "not
 * touched"; values compare by their JSON form so Dates and id arrays work.
 */
export function changedTaskFields(patch: object, existing?: object): string[] {
  const before = (existing ?? {}) as Record<string, unknown>;
  return Object.entries(patch)
    .filter(([key, value]) => {
      if (BOOKKEEPING_FIELDS.has(key)) return false;
      if (!existing) return !isEmpty(value);
      return value !== undefined && JSON.stringify(value) !== JSON.stringify(before[key]);
    })
    .map(([key]) => key);
}

export async function auditTaskMutation(input: {
  userId: string;
  taskId: string;
  op: TaskMutationOp;
  change: string[];
  actor: TaskAuditActor;
  /** Root session id for agents (what `run_events.run_id` holds); null for API calls. */
  runId: string | null;
}): Promise<void> {
  // Same rule as `toolCallEvent`: a synthetic, non-uuid session is not a run.
  const runId = input.runId && isUuid(input.runId) ? input.runId : null;
  try {
    await auditRepository.log({
      userId: input.userId,
      action: 'task_mutated',
      resourceType: 'task',
      resourceId: input.taskId,
      sessionId: runId,
      details: { taskId: input.taskId, op: input.op, change: input.change, actor: input.actor, runId },
    });
  } catch (err) {
    coreLogger.warn({ err, taskId: input.taskId, op: input.op }, 'Task audit write failed — mutation kept');
  }
}
