/**
 * The run view (docs/MISSION-CONTROL.md, "Run detail"): why one agent run
 * exists — what started its tree, the hook, heartbeat decision, pipeline or
 * Companion goal behind it, its parent — its children, and the prompt it was
 * given (sizes stored on its row or its user message, text while in memory).
 *
 * Reads go through the principal's scoped repositories: another user's run
 * reads as not found.
 */
import { contentRepos } from '@/db/repositories/content';
import { scopedRepos } from '@/db/repositories/scoped';
import type { Principal } from '@/security/principal';
import { AGENT_SOURCE_LABEL, type MissionRun, type RunDetailResponse } from '@/shared/agent-origin';
import type { PromptComposition } from '@/shared/prompt-composition';
import { getAgentManager } from './agent-manager';
import { getAgentComposition, getLatestComposition } from './agent/prompt-composition';
import { readRunOutcome } from './run-outcome';

function isComposition(value: unknown): value is PromptComposition {
  const v = value as Partial<PromptComposition> | null;
  return !!v && v.version === 1 && Array.isArray(v.sections) && typeof v.totals?.tokens === 'number';
}

export async function readRunDetail(principal: Principal, agentId: string): Promise<RunDetailResponse | null> {
  const repos = contentRepos(principal);
  const agent = await repos.agents.findById(agentId);
  if (!agent) return null;
  const scoped = scopedRepos(principal);
  const root = agent.metadata?.root === true;
  const origin = agent.origin ?? null;

  const [sessionRow, siblings, parent] = await Promise.all([
    repos.sessions.findById(agent.sessionId),
    repos.agents.findBySession(agent.sessionId, 200),
    agent.parentAgentId ? repos.agents.findById(agent.parentAgentId) : Promise.resolve(null),
  ]);
  const live = (id: string, stored: string) => (getAgentManager().get(id)?.getContext().status ?? stored) as MissionRun['status'];

  // The chain, outermost first.
  const chain: RunDetailResponse['chain'] = [];
  if (origin) {
    chain.push({ kind: 'source', label: AGENT_SOURCE_LABEL[origin.source], detail: origin.channel ?? null, href: null });
    if (origin.hookId) {
      const hook = await scoped.hooks.findById(origin.hookId);
      chain.push({ kind: 'hook', label: hook?.name ?? origin.hookName ?? 'A hook since removed', detail: hook ? hook.trigger : null, href: '/agents/triggers' });
      if (hook?.trigger === 'heartbeat') {
        // The decision that started this tree: the last check that ran at or before it.
        const checks = await scoped.hooks.heartbeatChecksSince([hook.id], new Date(agent.createdAt.getTime() - 6 * 3_600_000));
        const decision = checks.filter((c) => c.ran && c.checkedAt <= agent.createdAt).at(-1);
        if (decision) chain.push({ kind: 'heartbeat', label: 'Heartbeat check passed', detail: decision.readyTasks ? `${decision.readyTasks} ready to-do${decision.readyTasks === 1 ? '' : 's'}` : null, href: '/agents/triggers' });
      }
    }
    if (origin.pipelineId) {
      const pipeline = await scoped.pipelines.findById(origin.pipelineId);
      chain.push({ kind: 'pipeline', label: pipeline?.title ?? 'A pipeline since removed', detail: pipeline?.status ?? null, href: '/pipelines' });
    }
    if (origin.goalId) {
      const goal = (await scoped.hooks.companionGoalsOwn(200)).find((g) => g.id === origin.goalId);
      chain.push({ kind: 'goal', label: goal?.title ?? 'A Companion goal', detail: goal?.state ?? null, href: '/companion' });
    }
  }
  if (parent) chain.push({ kind: 'parent', label: parent.metadata?.root === true ? 'Octipus' : parent.role, detail: 'spawned this run', href: `/agents/view?id=${encodeURIComponent(parent.id)}` });

  // The prompt: text while this process holds it, else stored sizes.
  let prompt: RunDetailResponse['prompt'] = null;
  if (root) {
    const latest = getLatestComposition(agent.sessionId);
    if (latest?.agentId === agent.id) prompt = { ...latest.composition, textAvailable: true };
    else {
      const stored = await repos.messages.promptCompositionOf(agent.sessionId, agent.id);
      if (isComposition(stored)) prompt = { ...stored, textAvailable: false };
    }
  } else {
    const inMemory = getAgentComposition(agent.id);
    if (inMemory) prompt = { ...inMemory, textAvailable: true };
    else if (isComposition(agent.metadata?.promptComposition)) prompt = { ...(agent.metadata.promptComposition as PromptComposition), textAvailable: false };
  }

  const status = live(agent.id, agent.status);
  const cost = (await repos.agents.costByAgent([agent.id])).get(agent.id) ?? null;
  const outcome = await readRunOutcome(agent, root, status, cost);

  return {
    id: agent.id,
    role: agent.role,
    root,
    status,
    sessionId: agent.sessionId,
    sessionTitle: sessionRow?.title ?? null,
    createdAt: agent.createdAt.toISOString(),
    origin,
    chain,
    parent: parent ? { id: parent.id, role: parent.role, root: parent.metadata?.root === true } : null,
    children: siblings
      .filter((a) => a.parentAgentId === agent.id)
      .map((a) => ({ id: a.id, role: a.role, status: live(a.id, a.status), totalTokens: a.totalTokens ?? 0 })),
    outcome,
    prompt,
  };
}
