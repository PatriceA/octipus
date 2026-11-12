import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { agentEvents } from '@/db/schema/agent-events';
import { backgroundJobs } from '@/db/schema/background-jobs';
import { backgroundJobRepository } from '@/db/repositories/background-job-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { coreLogger } from '@/utils/logger';
import { reviewDue } from './triggers';
import { processLearningJob } from './processor';
import { canActInSession } from '@/core/rooms/access';
import { getConfig } from '@/config';
import { getModelRegistry } from '@/models/model-registry';
import { getRateLimitManager } from '@/models/rate-limiter';
import { resolveDataPolicy } from '@/models/decision';

/**
 * Plan completions are queued transactionally by workPlanRepository; this
 * covers the rest. A review is due once the session has run
 * `learning.reviewEveryToolCalls` tool calls since its last review (or since it
 * began), counted across turns: not once per turn.
 */
export async function enqueueTurnLearning(sessionId: string, userId: string, agentId: string): Promise<void> {
  const db = getDb();
  const [existing] = await db.select({ payload: backgroundJobs.payload, createdAt: backgroundJobs.createdAt }).from(backgroundJobs).where(and(
    eq(backgroundJobs.kind, 'learning'), eq(backgroundJobs.userId, userId),
    sql`${backgroundJobs.payload}->>'sessionId' = ${sessionId}`,
  )).orderBy(desc(backgroundJobs.seq)).limit(1);
  const since = existing ? new Date(String(existing.payload.through ?? existing.createdAt.toISOString())) : new Date(0);
  // One observation row carries every result of a parallel tool round: count the results, not the rows.
  const [count] = await db.select({ n: sql<number>`coalesce(sum(CASE WHEN jsonb_typeof(${agentEvents.data}->'results') = 'array'
    THEN jsonb_array_length(${agentEvents.data}->'results') ELSE 1 END), 0)::int` }).from(agentEvents).where(and(
    eq(agentEvents.sessionId, sessionId), eq(agentEvents.userId, userId),
    gte(agentEvents.createdAt, since), inArray(agentEvents.type, ['action', 'observation']),
    sql`(${agentEvents.data}->>'type' = 'cli_tool_result' OR ${agentEvents.data} ? 'results')`,
  ));
  if (!reviewDue(Number(count.n), getConfig().learning.reviewEveryToolCalls)) return;
  const session = await sessionRepository.findById(sessionId);
  if (!session || !(await canActInSession(session, userId, 'learning'))) throw new Error('Learning session not found');
  await backgroundJobRepository.create({ kind: 'learning', userId, workspaceId: session.workspaceId,
    title: 'Learning check: completed work', payload: { sessionId, trigger: 'substantial_turn',
      triggerKey: `turn:${agentId}`, through: new Date().toISOString() } });
}

/**
 * hermes's `defer: auto`: a review that would decode on a local model waits
 * until that provider has been idle for `learning.localIdleMs`, so it never
 * holds a single-slot GPU while a user's turn queues behind it.
 * ponytail: idleness is this process's own traffic to the provider; another
 * client on the same Ollama is invisible. Upgrade: ask Ollama (/api/ps) if
 * shared installs matter.
 */
async function localProviderBusy(): Promise<boolean> {
  const model = await getModelRegistry().getModelForTopic('background');
  if (!model || resolveDataPolicy(model, getConfig().ollama.url).hosting !== 'local') return false;
  const { idleMs } = getRateLimitManager().getProviderStats(model.provider);
  return idleMs !== null && idleMs < getConfig().learning.localIdleMs;
}

let draining = false;
let timer: ReturnType<typeof setInterval> | undefined;
export async function drainLearningQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      // Re-checked per job: a turn may have started while the last one ran.
      // ponytail: a manual check waits for idle too (hermes lets /refine skip it).
      if (await localProviderBusy()) break;
      const job = await backgroundJobRepository.claimNext('learning');
      if (!job) break;
      await processLearningJob(job);
    }
  } catch (err) {
    coreLogger.error({ err }, 'Learning queue failed; queued checks remain durable');
  } finally { draining = false; }
}
export function startLearningQueue(): void {
  if (timer) return;
  timer = setInterval(() => { void drainLearningQueue(); }, 15_000);
  timer.unref();
  void drainLearningQueue();
}
