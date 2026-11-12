/** Actual to-do work, separate from the deterministic personal heartbeat check. */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { contentRepos } from '@/db/repositories/content';
import { notInSharedWorkspace } from '@/db/repositories/scoped';
import { hooks, type Hook } from '@/db/schema/hooks';
import type { ActionResult } from '@/hooks/actions';
import { boardWritesAllowed, findStandingNote, type HeartbeatTaskDispatch, probeRoleWork, renderRoleHeartbeatMessage } from '@/core/heartbeat';
import { backgroundUserPrincipal } from './sourced';
import { persistHeartbeatTaskProvenance, taskProvenance } from './provenance';
import { coreLogger } from '@/utils/logger';
import { ACTIVE_TASK_STATUSES } from './status';

/** Claim before reading task text into a worker; a fresh execution scope never reuses a check-in chat. */
export async function runHeartbeatTask(
  hook: Pick<Hook, 'id' | 'userId'>,
  dispatch: HeartbeatTaskDispatch,
  work: (sessionId: string, message: string, signal: AbortSignal) => Promise<ActionResult>,
  signal?: AbortSignal,
): Promise<ActionResult> {
  // Settings may have changed since the gate. Any explicit role configuration,
  // including a paused one, takes precedence over personal fallback dispatch.
  if (!await boardWritesAllowed(hook.userId)) return { success: false, error: 'Task board write permission is no longer allowed' };
  const allHooks = await getDb().select({ config: hooks.triggerConfig }).from(hooks).where(and(
    eq(hooks.userId, hook.userId), eq(hooks.trigger, 'heartbeat'), notInSharedWorkspace(hooks.workspaceId),
  ));
  if (allHooks.some((h) => h.config.role === dispatch.role)) return { success: true, data: { skipped: 'role_configured' } };
  if (!(await probeRoleWork(hook.userId, dispatch.role)).some((t) => t.id === dispatch.taskId)) {
    return { success: true, data: { skipped: 'task_changed' } };
  }
  const row = await contentRepos(backgroundUserPrincipal(hook.userId)).tasks.findById(dispatch.taskId);
  if (!row) return { success: true, data: { skipped: 'task_deleted' } };
  const repos = contentRepos(backgroundUserPrincipal(hook.userId, row.workspaceId ?? null));
  const sessionId = randomUUID();
  const actor = `${dispatch.role}@${sessionId}`;
  signal?.throwIfAborted();
  const claim = await repos.tasks.checkout(row.id, actor, null);
  if (!claim.ok) return { success: true, data: { skipped: 'task_not_claimed' } };
  const task = claim.task;
  const controller = new AbortController();
  const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const renew = setInterval(() => {
    void repos.tasks.checkout(task.id, actor, null).then((renewed) => {
      if (!renewed.ok) controller.abort(new Error('Heartbeat task checkout lost'));
    }).catch((err: unknown) => {
      coreLogger.error({ err, taskId: task.id }, 'Heartbeat task checkout renewal failed');
      controller.abort(err);
    });
  }, 10 * 60_000);
  renew.unref?.();
  let contextCreated = false;
  let succeeded = false;
  try {
    if (task.assigneeKind !== 'role' || task.assigneeRef !== dispatch.role) {
      return { success: true, data: { skipped: 'task_reassigned' } };
    }
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    await sessionRepository.createAutomation({ id: sessionId, userId: hook.userId, workspaceId: task.workspaceId,
      channelType: 'heartbeat', channelId: hook.userId, title: task.title.slice(0, 100) });
    contextCreated = true;
    await persistHeartbeatTaskProvenance(hook.userId, sessionId, await taskProvenance(hook.userId, [task]));
    const standing = await findStandingNote(hook.userId);
    const message = [standing?.body, renderRoleHeartbeatMessage(dispatch.role, [task]), task.notes].filter(Boolean).join('\n\n');
    active.throwIfAborted();
    const result = await work(sessionId, message, active);
    active.throwIfAborted();
    const response = result.data && typeof result.data === 'object' && 'response' in result.data && typeof result.data.response === 'string' ? result.data.response : '';
    await repos.tasks.addComment(task.id, {
      authorKind: 'agent', authorRef: actor,
      body: result.success ? (response.slice(0, 8000) || 'Heartbeat worker finished. See its task comments for the outcome.') : `Heartbeat worker stopped: ${result.error ?? 'unknown error'}`,
    });
    succeeded = result.success;
    return result;
  } catch (err) {
    await repos.tasks.addComment(task.id, { authorKind: 'agent', authorRef: actor, body: `Heartbeat work stopped: ${err instanceof Error ? err.message : String(err)}` });
    throw err;
  } finally {
    clearInterval(renew);
    try {
      const current = await repos.tasks.findById(task.id);
      if (current && ACTIVE_TASK_STATUSES.some((status) => status === current.status) && current.assigneeKind === 'role' && current.assigneeRef === dispatch.role && (!current.checkedOutBy || current.checkedOutBy === actor)) {
        await repos.tasks.addComment(task.id, { authorKind: 'agent', authorRef: actor,
          body: 'Work remains unfinished. Returned to your list so heartbeat does not repeat it automatically. Assign it to the role again when ready.' });
        await repos.tasks.update(task.id, { assigneeKind: 'user', assigneeRef: hook.userId }, { asActor: actor });
      }
    } finally {
      await repos.tasks.release(task.id, actor);
      if (contextCreated) {
        const { sessionRepository } = await import('@/db/repositories/session-repository');
        await sessionRepository.update(sessionId, { status: succeeded ? 'completed' : 'failed' });
      }
    }
  }
}
