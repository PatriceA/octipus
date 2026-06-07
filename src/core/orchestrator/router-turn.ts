import { resolveRoleFromTopic, SPAWN_CHILD_ROLES } from '@/core/swarm/swarm-tool';
import type { AgentContext } from '@/core/types';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { coreLogger } from '@/utils/logger';
import { getRoleConfig } from './roles';
import type { MessageClassification } from './types';
import { spawnWorker, type WorkerSpawnerDeps } from './worker-spawner';

export interface RouterTurnOptions {
  workspaceId: string | null;
  /** Memory block + attached-file context, forwarded to the worker as input. */
  extraSystemContext: string;
  guardFlags: string[];
}

/**
 * Router mode — the small-model path. There is NO orchestrator LLM: we map the
 * pre-computed classification to a specialist role deterministically, spawn ONE
 * worker, and relay its output. The local model only ever runs as a single
 * role-scoped worker (the shape lighter assistants use), so it never has to
 * hold the full swarm-coordination prompt.
 *
 * Returns the same `{ response, agentId, sources }` contract as the full
 * orchestrator so `handleMessage` can persist + post-process identically.
 */
export async function runRouterTurn(
  sessionId: string,
  userId: string,
  message: string,
  classification: MessageClassification,
  deps: WorkerSpawnerDeps,
  opts: RouterTurnOptions,
): Promise<{ response: string; agentId: string; sources: string[] }> {
  // Workers don't persist the session user message (only the orchestrator
  // does). Router bypasses the orchestrator, so record the turn here.
  await messageRepository.create({ sessionId, role: 'user', content: message });
  await sessionRepository.incrementMessageCount(sessionId);

  // Resolve a specialist role from the classifier's topic using the same
  // ladder spawn_child validation uses. No topic / unresolvable → clarify
  // rather than guess; a wrong specialist is worse than one clarifying question.
  const topic = classification.topic;
  const role = topic ? resolveRoleFromTopic(undefined, topic) : undefined;

  if (classification.type === 'ambiguous' || !role) {
    coreLogger.info({ sessionId, topic, type: classification.type }, 'Router: clarifying (no confident role)');
    return { response: buildClarifyReply(), agentId: `router-clarify-${sessionId}`, sources: ['router(clarify)'] };
  }

  const roleConfig = getRoleConfig(role);
  const context: AgentContext = {
    id: `router-${sessionId}-${role}`,
    sessionId,
    userId,
    workspaceId: opts.workspaceId,
    model: '',
    topic: roleConfig.defaultTopic,
    role,
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: { router: true, originalRequest: message },
  };

  coreLogger.info({ sessionId, role, topic }, 'Router: spawning single specialist worker');

  // `spawnWorker` emits worker_spawned/worker_completed itself and, with no
  // swarmParent, skips all swarm-tree bookkeeping — exactly the single-agent
  // shape we want. The memory/attached-files block rides in as worker input.
  const result = await spawnWorker(role, message, opts.extraSystemContext, context, deps);
  const response = coerceWorkerResult(result);

  const sources = [`router`, `role(${role})`];
  if (opts.guardFlags.length > 0) sources.push(`guard(${opts.guardFlags.join(',')})`);

  return { response, agentId: context.id, sources };
}

/** Turn an opaque spawnWorker return into a user-facing string. */
function coerceWorkerResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'error' in result) {
    return String((result as { error: unknown }).error);
  }
  return String(result);
}

/**
 * Deterministic clarifying reply for vague / unroutable input. Router has no
 * LLM to ask a tailored question, so it offers the specialist surface and asks
 * the user to narrow down. This is the one capability router trades away.
 */
function buildClarifyReply(): string {
  const areas = SPAWN_CHILD_ROLES.join(', ');
  return (
    "I can help, but I need a bit more to route this. Tell me what you'd like to do — " +
    `for example coding, research, review, writing, data, design, devops, security, or general questions. ` +
    `(Available specialists: ${areas}.)`
  );
}
