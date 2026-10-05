import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { agentEvents } from '@/db/schema/agent-events';
import { backgroundJobs } from '@/db/schema/background-jobs';
import { backgroundJobRepository } from '@/db/repositories/background-job-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { coreLogger } from '@/utils/logger';
import { isSubstantialTurn } from './triggers';
import { processLearningJob } from './processor';
import { canActInSession } from '@/core/rooms/access';

/** Milestones are queued transactionally by workPlanRepository; this covers unplanned work. */
export async function enqueueTurnLearning(sessionId: string, userId: string, agentId: string, startedAt: Date): Promise<void> {
  const db = getDb();
  const [existing] = await db.select({ payload: backgroundJobs.payload, createdAt: backgroundJobs.createdAt }).from(backgroundJobs).where(and(
    eq(backgroundJobs.kind, 'learning'), eq(backgroundJobs.userId, userId),
    sql`${backgroundJobs.payload}->>'sessionId' = ${sessionId}`,
    gte(backgroundJobs.createdAt, startedAt),
  )).orderBy(desc(backgroundJobs.seq)).limit(1);
  if (existing?.payload.triggerKey === `turn:${agentId}`) return;
  // A milestone covers preceding work, not substantial work done after it.
  const since = existing ? new Date(String(existing.payload.through ?? existing.createdAt.toISOString())) : startedAt;
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(agentEvents).where(and(
    eq(agentEvents.sessionId, sessionId), eq(agentEvents.userId, userId),
    gte(agentEvents.createdAt, since), inArray(agentEvents.type, ['action', 'observation']),
    sql`(${agentEvents.data}->>'type' = 'cli_tool_result' OR ${agentEvents.data} ? 'results')`,
  ));
  if (!isSubstantialTurn(Number(count.n), Date.now() - since.getTime())) return;
  const session = await sessionRepository.findById(sessionId);
  if (!session || !(await canActInSession(session, userId, 'learning'))) throw new Error('Learning session not found');
  await backgroundJobRepository.create({ kind: 'learning', userId, workspaceId: session.workspaceId,
    title: 'Learning check: completed work', payload: { sessionId, trigger: 'substantial_turn',
      triggerKey: `turn:${agentId}`, through: new Date().toISOString() } });
}

let draining = false;
let timer: ReturnType<typeof setInterval> | undefined;
export async function drainLearningQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
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
