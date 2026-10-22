/**
 * A role agent that works its tasks through a pipeline template.
 *
 * A role heartbeat (core/heartbeat.ts) normally works its ready tasks as one
 * agent turn. With `triggerConfig.pipelineTemplate` set (the Role agents
 * panel's "Work each task through" choice) it runs each task as a pipeline
 * run of that template instead — plan, plan loop, QA — one task per heartbeat
 * turn, so a big idea on the to-do list gets the full treatment without
 * anyone starting it.
 *
 * The board protocol is the role agent's, done by the server rather than by a
 * model: the task is checked out under the role agent's identity
 * (`<role>@<hook session>`) before the run, the claim is renewed while it
 * runs, a comment says which pipeline took it, and the run's outcome closes it:
 *
 *  - completed → a comment with the run's summary, and the task is done;
 *  - anything else (failed, paused at an approval nobody answered, stopped) →
 *    a comment saying where it stopped, the claim given back, and the task
 *    handed to its owner (assigned to them, so the role agent does not pick
 *    it up again on the next heartbeat and spend another run on it), with a
 *    notification.
 *
 * The run is unattended (`attended: false`): a step that asks for approval
 * waits for the owner — posted to their own chats (channels/approval-prompts)
 * and to the web app — unless the template lets it approve itself when no one
 * is watching (`autoApproveUnattended`).
 *
 * When more tasks are ready afterwards the hook is marked due again, so the
 * next cron tick takes the next one (through the full heartbeat gate: quiet
 * hours and the daily cap still apply).
 */
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { contentRepos } from '@/db/repositories/content';
import { hooks } from '@/db/schema/hooks';
import type { Task } from '@/db/schema/tasks';
import { coreLogger } from '@/utils/logger';
import { backgroundUserPrincipal } from './sourced';

/** How often the task's checkout is renewed while its pipeline runs (the lease lasts 30 minutes). */
const RENEW_EVERY_MS = 10 * 60_000;

export interface RoleTemplateChoice {
  id: string;
  name: string;
}

/**
 * The template `ref` (an id or a name) names among those `userId` may run, or
 * a reason it cannot be used unattended. A template with a required parameter
 * that has no default cannot: nobody is there to fill it in.
 */
export async function resolveRoleTemplate(userId: string, ref: string): Promise<RoleTemplateChoice | { error: string }> {
  const { listRecipes } = await import('@/core/agent/templates');
  const wanted = ref.trim().toLowerCase();
  const match = (await listRecipes(userId)).find((t) => t.id === ref || t.name.toLowerCase() === wanted);
  if (!match) return { error: `Unknown pipeline template "${ref}"` };
  const missing = match.parameters.filter((p) => p.requirement !== 'optional' && p.default === undefined);
  if (missing.length > 0) {
    return { error: `Pipeline template "${match.name}" needs ${missing.map((p) => `"${p.key}"`).join(', ')} filled in, which no one can do for a role agent` };
  }
  return { id: match.id, name: match.name };
}

/** What the pipeline is asked to do: the task as the owner wrote it. Pure. */
export function taskPipelineDescription(task: Pick<Task, 'id' | 'title' | 'notes'>): string {
  const parts = [task.title.trim()];
  if (task.notes?.trim()) parts.push('', task.notes.trim());
  parts.push('', `(Work-board task ${task.id}. Its owner reads the result in the task's comments.)`);
  return parts.join('\n');
}

export interface RolePipelineResult {
  success: boolean;
  error?: string;
  data?: { role: string; taskId?: string; pipelineId?: string; status?: string };
}

/**
 * One heartbeat turn of a pipeline role agent: check out the first ready task
 * it can claim and run it through the template. Awaited by the heartbeat, which
 * keeps the hook's turn lease for the whole run.
 */
export async function runRoleTaskPipeline(input: {
  hookId: string;
  role: string;
  templateRef: string;
  sessionId: string;
  userId: string;
}): Promise<RolePipelineResult> {
  const { hookId, role, templateRef, sessionId, userId } = input;
  const template = await resolveRoleTemplate(userId, templateRef);
  if ('error' in template) return { success: false, error: template.error };

  const { probeRoleWork } = await import('@/core/heartbeat');
  const ready = await probeRoleWork(userId, role);
  const actor = `${role}@${sessionId}`;

  // The first ready task this agent can claim; a refused checkout (someone
  // else got it first, it became blocked) moves on to the next.
  let task: Task | null = null;
  let repos: ReturnType<typeof contentRepos> | null = null;
  for (const candidate of ready) {
    const row = await contentRepos(backgroundUserPrincipal(userId)).tasks.findById(candidate.id);
    if (!row) continue;
    const scoped = contentRepos(backgroundUserPrincipal(userId, row.workspaceId ?? null));
    const claimed = await scoped.tasks.checkout(row.id, actor, null);
    if (claimed.ok) {
      task = claimed.task;
      repos = scoped;
      break;
    }
  }
  if (!task || !repos) return { success: true, data: { role } };

  const comment = (body: string) => repos!.tasks.addComment(task!.id, { authorKind: 'agent', authorRef: actor, body })
    .catch((err: unknown) => coreLogger.warn({ err, taskId: task!.id }, 'role pipeline: could not comment on the task'));
  const renew = setInterval(() => {
    repos!.tasks.checkout(task!.id, actor, null).catch((err: unknown) => coreLogger.warn({ err, taskId: task!.id }, 'role pipeline: checkout renewal failed'));
  }, RENEW_EVERY_MS);
  renew.unref?.();

  let pipelineId: string | undefined;
  let outcome: { status: string; summary: string };
  try {
    const context = await pipelineContext({ role, sessionId, userId, taskTitle: task.title });
    const { getAgentService } = await import('@/core/agent');
    const { withAgentUsage } = await import('@/core/agent/context');
    const result = await withAgentUsage(userId, context.scope, () => getAgentService().createAndRunPipeline(
      task!.title.slice(0, 100),
      template.name,
      taskPipelineDescription(task!),
      context,
      {
        onCreated: (id) => {
          pipelineId = id;
          void comment(`Started pipeline "${template.name}" (run ${id}) for this task. You can follow it on the Pipelines page.`);
        },
      },
    )) as { pipelineId?: string; result?: string };
    pipelineId ??= result?.pipelineId;
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    const row = pipelineId ? await pipelineRepository.findById(pipelineId) : null;
    outcome = { status: row?.status ?? 'failed', summary: (row?.summary || result?.result || '').trim() };
  } catch (err) {
    outcome = { status: 'failed', summary: (err as Error).message };
  } finally {
    clearInterval(renew);
  }

  if (outcome.status === 'completed') {
    await comment(`Pipeline "${template.name}" finished.${outcome.summary ? `\n\n${outcome.summary.slice(0, 4000)}` : ''}`);
    const done = await repos.tasks.update(task.id, { status: 'done', completedAt: new Date() }, { asActor: actor });
    if (!done) coreLogger.warn({ taskId: task.id }, 'role pipeline: the task could not be closed (taken over meanwhile)');
  } else {
    await handBack(repos, task, actor, userId, template.name, outcome, pipelineId);
  }
  await markDueIfMoreReady(hookId, userId, role);
  coreLogger.info({ userId, role, taskId: task.id, pipelineId, status: outcome.status }, 'Role pipeline finished');
  return { success: true, data: { role, taskId: task.id, pipelineId, status: outcome.status } };
}

/** The unattended root context the pipeline runs under, in the hook's session (created when missing). */
async function pipelineContext(input: { role: string; sessionId: string; userId: string; taskTitle: string }) {
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  const { buildAgentContext, resolveAgentScope } = await import('@/core/agent/context');
  const { ROOT_ROLE } = await import('@/core/agent/types');
  const { getModelRegistry } = await import('@/models/model-registry');
  let session = await sessionRepository.findById(input.sessionId);
  if (!session) {
    session = await sessionRepository.create({
      id: input.sessionId,
      userId: input.userId,
      channelType: 'heartbeat',
      channelId: input.userId,
      title: `${input.role} agent`,
    });
  }
  const scope = await resolveAgentScope({ session, userId: input.userId, trigger: 'schedule' });
  const model = await getModelRegistry().getDefaultModel();
  if (!model) throw new Error('No default model configured — bind one on the Models page first');
  const context = buildAgentContext({
    id: `heartbeat:${input.role}:${input.sessionId}`,
    sessionId: input.sessionId,
    userId: input.userId,
    scope,
    topic: 'general',
    model: model.modelId,
    role: ROOT_ROLE,
    root: true,
    // Nobody is watching: tool-level asks are refused, and a step's sign-off
    // waits for the owner (or approves itself where the template says so).
    attended: false,
    status: 'running',
  });
  return Object.assign(context, { scope });
}

/**
 * The run did not finish: say where it stopped, give the claim back and hand
 * the task to its owner, so the role agent does not start it over.
 */
async function handBack(
  repos: ReturnType<typeof contentRepos>,
  task: Task,
  actor: string,
  userId: string,
  templateName: string,
  outcome: { status: string; summary: string },
  pipelineId: string | undefined,
): Promise<void> {
  const where = outcome.status === 'paused' ? 'paused' : outcome.status === 'stopped' ? 'was stopped' : 'did not finish';
  await repos.tasks.addComment(task.id, {
    authorKind: 'agent',
    authorRef: actor,
    body: `Pipeline "${templateName}"${pipelineId ? ` (run ${pipelineId})` : ''} ${where}` +
      `${outcome.summary ? `: ${outcome.summary.slice(0, 2000)}` : '.'}\n\n` +
      'Handed back to you: resume the run on the Pipelines page, or assign the task to the role again to start over.',
  }).catch((err: unknown) => coreLogger.warn({ err, taskId: task.id }, 'role pipeline: could not comment on the task'));
  await repos.tasks.release(task.id, actor);
  await repos.tasks.update(task.id, { assigneeKind: 'user', assigneeRef: userId });
  const { getNotificationService } = await import('@/core/notification-service');
  await getNotificationService().notify(
    userId,
    'task_needs_you',
    `Task needs you: ${task.title.slice(0, 120)}`,
    `The ${templateName} pipeline ${where}. The task is back on your list.`,
    { taskId: task.id, ...(pipelineId ? { pipelineId } : {}) },
  );
}

/** More ready tasks: make the hook due now so the next tick takes the next one. */
async function markDueIfMoreReady(hookId: string, userId: string, role: string): Promise<void> {
  try {
    const { probeRoleWork } = await import('@/core/heartbeat');
    if ((await probeRoleWork(userId, role)).length === 0) return;
    await getDb().update(hooks).set({ nextRunAt: new Date(), updatedAt: new Date() }).where(eq(hooks.id, hookId));
  } catch (err) {
    coreLogger.warn({ err, hookId }, 'role pipeline: could not mark the hook due for the next task');
  }
}
