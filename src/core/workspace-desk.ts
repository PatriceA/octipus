import { contentRepos } from '@/db/repositories/content';
import type { Session } from '@/db/schema/sessions';
import type { AgentRecord } from '@/db/schema/agents';
import type { Pipeline } from '@/db/schema/pipelines';
import type { Principal } from '@/security/principal';
import { workPlanStateSchema, type WorkPlan } from '@/shared/work-plan';
import type { DeskSession, WorkspaceDesk } from '@/shared/workspace-desk';
import { coreLogger } from '@/utils/logger';
import { getAgentManager } from './agent-manager';

/** Projection uses explicit live state and recorded outcomes, never a percentage of a changing plan. */
export function projectDeskSession(session: Pick<Session, 'id' | 'title' | 'status' | 'updatedAt'>, plan: WorkPlan | null,
  runs: AgentRecord[], live: boolean, pending: boolean, pipeline: Pipeline | null, available: boolean): DeskSession {
  const latest = [...runs].sort((a, b) => (b.completedAt ?? b.createdAt).getTime() - (a.completedAt ?? a.createdAt).getTime())[0];
  const current = plan?.steps.find(step => step.status === 'working');
  const blocked = plan?.steps.find(step => step.status === 'blocked');
  const next = plan?.steps.find(step => step.status === 'pending');
  const done = plan?.steps.filter(step => step.status === 'done').at(-1);
  let state: DeskSession['state'] = 'idle';
  let activity = 'No active run is recorded.';
  if (session.status === 'paused') { state = 'paused'; activity = 'This session is paused.'; }
  else if (pending || pipeline?.status === 'awaiting_approval') { state = 'needs_you'; activity = 'A pending request needs your answer.'; }
  else if (live) { state = 'working'; activity = current?.title ?? 'An agent is working in this session.'; }
  else if (!available) { state = 'unknown'; activity = 'Current activity could not be confirmed.'; }
  else if (pipeline?.status === 'paused' || pipeline?.status === 'stopped') { state = 'paused'; activity = 'The saved pipeline is paused or stopped.'; }
  else if (pipeline?.status === 'failed' || session.status === 'failed' || blocked || latest?.status === 'failed') {
    state = 'blocked'; activity = blocked?.title ?? 'The last recorded work needs investigation.';
  } else if (latest?.status === 'running' || pipeline?.status === 'running' || pipeline?.status === 'planning') {
    state = 'unknown'; activity = 'Saved work says running, but no live worker was confirmed.';
  } else if (latest?.status === 'stopped') { state = 'paused'; activity = 'The last run stopped. Open the session for its reason.'; }
  else if (latest?.status === 'completed' || session.status === 'completed') { state = 'updated'; activity = 'The last run finished. Its result is in the session.'; }
  const events = runs.slice(0, 4).map(run => ({ at: (run.completedAt ?? run.createdAt).toISOString(),
    text: run.status === 'completed' ? `${run.role} run finished` : run.status === 'failed' ? `${run.role} run failed` : run.status === 'stopped' ? `${run.role} run stopped` : `${run.role} run started` }));
  return { id: session.id, title: session.title || 'Untitled session', state, activity,
    outcome: done ? `Recorded in plan: ${done.title}` : null,
    next: state === 'needs_you' ? 'Open the session to review the request and its impact.' : state === 'paused' ? 'Review the checkpoint when you are ready to continue.' : next?.title ?? null,
    updatedAt: session.updatedAt.toISOString(), pipelineId: pipeline?.id ?? null,
    plan: plan ? { title: plan.title, revision: plan.revision, updatedAt: plan.updatedAt,
      changes: plan.history.slice(-3).reverse().map(change => ({ at: change.at, summary: change.summary })) } : null,
    events: events.sort((a, b) => b.at.localeCompare(a.at)) };
}

/** The personal desk never uses an admin-wide list or returns private work in a shared workspace. */
export async function readWorkspaceDesk(principal: Principal): Promise<WorkspaceDesk> {
  const repos = contentRepos(principal);
  const now = new Date();
  if (repos.kind !== 'personal') return { observedAt: now.toISOString(), sessions: [], total: 0, warnings: [] };
  const warnings: string[] = [];
  const [recent, total, requestResults] = await Promise.all([
    repos.sessions.listOwn(30), repos.sessions.countOwn(),
    Promise.allSettled([(async () => {
      const [{ getAgentService }, { getPermissionManager }] = await Promise.all([import('./agent/service'), import('@/security/permissions')]);
      return [...getAgentService().getPendingApprovals(principal.userId).map(request => request.sessionId),
        ...(await getPermissionManager().getPendingRequests(principal.userId)).map(request => request.sessionId)];
    })()]),
  ]);
  const requests = requestResults[0];
  if (requests.status === 'rejected') { warnings.push('Pending requests could not be checked.'); coreLogger.warn({ err: requests.reason }, 'Workspace desk: requests unavailable'); }
  const pending = new Set((requests.status === 'fulfilled' ? requests.value : []).filter((id): id is string => typeof id === 'string'));
  const manager = getAgentManager();
  const live = manager.list().filter(agent => agent.userId === principal.userId && agent.status === 'running'
    && manager.get(agent.id)?.getContext().metadata?.companionBriefing !== true);
  // Include old actionable sessions, rather than letting recently edited idle chats crowd them out.
  const ids = new Set(recent.map(session => session.id));
  const candidates = new Set([...pending].slice(0, 30).concat(live.slice(0, 30).map(agent => agent.sessionId)));
  if (pending.size > 30) warnings.push('More pending sessions are available in Activity.');
  const older = await Promise.all([...candidates].filter(id => !ids.has(id)).map(id => repos.sessions.findById(id)));
  for (const session of older) {
    if (session && session.userId === principal.userId && (session.workspaceId == null || session.workspaceId === principal.workspaceId)) {
      recent.push(session); ids.add(session.id);
    }
  }
  // A bounded window for EACH session prevents a busy swarm from consuming the whole history budget.
  const histories = await Promise.allSettled(recent.map(session => repos.agents.findBySession(session.id, 4)));
  const sessions = await Promise.all(recent.map(async (session, index) => {
    const parsed = session.metadata?.workPlan === undefined ? null : workPlanStateSchema.safeParse(session.metadata.workPlan);
    const plan = parsed?.success ? parsed.data.current : null;
    if (parsed && !parsed.success) warnings.push(`Plan unavailable for ${session.title || 'a session'}.`);
    const history = histories[index];
    if (history.status === 'rejected') { warnings.push('Run history is unavailable.'); coreLogger.warn({ err: history.reason, sessionId: session.id }, 'Workspace desk: history unavailable'); }
    const ownRuns = history.status === 'fulfilled' ? history.value.filter(run => run.sessionId === session.id && run.userId === principal.userId && (run.workspaceId ?? null) === (session.workspaceId ?? null)) : [];
    const pipelineId = plan?.sourcePipelineId ?? ownRuns.find(run => run.origin?.pipelineId)?.origin?.pipelineId;
    let pipeline: Pipeline | null = null;
    let available = history.status === 'fulfilled' && requests.status === 'fulfilled' && (!parsed || parsed.success);
    if (pipelineId) {
      try { pipeline = await repos.pipelines.findById(pipelineId);
        if (!pipeline) { available = false; warnings.push('A saved pipeline state is unavailable.'); }
        if (pipeline && (pipeline.userId !== session.userId || pipeline.sessionId !== session.id || (pipeline.workspaceId ?? null) !== (session.workspaceId ?? null))) {
          pipeline = null; available = false; warnings.push('A saved pipeline reference does not belong to this session.');
        }
      }
      catch (error) { available = false; warnings.push('A pipeline state could not be checked.'); coreLogger.warn({ err: error, pipelineId }, 'Workspace desk: pipeline unavailable'); }
    }
    return projectDeskSession(session, plan, ownRuns, live.some(agent => agent.sessionId === session.id), pending.has(session.id), pipeline, available);
  }));
  const rank = { needs_you: 0, working: 1, blocked: 2, paused: 3, unknown: 4, updated: 5, idle: 6 };
  sessions.sort((a, b) => rank[a.state] - rank[b.state] || b.updatedAt.localeCompare(a.updatedAt));
  return { observedAt: now.toISOString(), total, sessions, warnings: [...new Set(warnings)] };
}
