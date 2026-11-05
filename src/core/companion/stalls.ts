import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { agents } from '@/db/schema/agents';
import { sessions } from '@/db/schema/sessions';
import { companionEvents, companionGoals, companionSessionLinks, companionSettings } from '@/db/schema/companion-supervision';

export const COMPANION_STALL_SILENCE_MS = 30 * 60_000;
export function companionStallSuspected(input: { now: number; lastProgressAt: number; commandRunning: boolean; awaitingApproval: boolean;
  localActivity?: { lastActivityAt: number; blockedSince: number | null } | null }) {
  if (input.commandRunning || input.awaitingApproval || input.localActivity?.blockedSince != null) return false;
  return input.now - Math.max(input.lastProgressAt, input.localActivity?.lastActivityAt ?? 0) > COMPANION_STALL_SILENCE_MS;
}
let lastSweep = 0;
/** A suspicion asks for inspection. It never kills a worker or resumes a pause. */
export async function scanCompanionStalls(now = Date.now(), force = false) {
  if (!force && now - lastSweep < 60_000) return;
  const candidates = await getDb().select({ agentId: agents.id, goalId: companionGoals.id, sessionId: sessions.id,
    progressAt: sql<string>`coalesce((SELECT max(e.created_at) FROM agent_events e WHERE e.agent_id=${agents.id} AND e.user_id=${agents.userId}), ${agents.createdAt})::text`,
    commandRunning: sql<boolean>`EXISTS (SELECT 1 FROM tool_actions t WHERE t.agent_id=${agents.id} AND t.user_id=${agents.userId} AND t.status='started' AND t.created_at>now()-interval '2 hours')`,
    staleCommand: sql<boolean>`EXISTS (SELECT 1 FROM tool_actions t WHERE t.agent_id=${agents.id} AND t.user_id=${agents.userId} AND t.status='started' AND t.created_at<=now()-interval '2 hours')`,
    awaitingApproval: sql<boolean>`EXISTS (SELECT 1 FROM permission_requests p WHERE p.agent_id=${agents.id} AND p.status='pending' AND (p.expires_at IS NULL OR p.expires_at>now()))`,
  }).from(agents).innerJoin(sessions, eq(sessions.id, agents.sessionId)).innerJoin(companionSessionLinks, eq(companionSessionLinks.sessionId, sessions.id))
    .innerJoin(companionGoals, eq(companionGoals.id, companionSessionLinks.goalId))
    .innerJoin(companionSettings, and(eq(companionSettings.userId, companionGoals.userId), eq(companionSettings.workspaceId, companionGoals.workspaceId)))
    .where(and(eq(agents.status, 'running'), lt(agents.createdAt, new Date(now - COMPANION_STALL_SILENCE_MS)), isNull(agents.parentAgentId),
      eq(sessions.status, 'active'), eq(companionGoals.state, 'active'), eq(companionSessionLinks.active, true), eq(companionSessionLinks.ownership, 'owner'),
      eq(companionSettings.enabled, true), eq(agents.userId, sql`${companionGoals.userId}::text`), eq(agents.workspaceId, companionGoals.workspaceId),
      eq(sessions.userId, companionGoals.userId), eq(sessions.workspaceId, companionGoals.workspaceId))).orderBy(agents.createdAt).limit(100);
  lastSweep = now;
  if (!candidates.length) return;
  const { getAgentManager } = await import('@/core/agent-manager');
  for (const candidate of candidates) {
    const worker = getAgentManager().get(candidate.agentId);
    // A live CLI process without a heartbeat is unknown, not proof of fresh
    // progress. Persisted output/receipts still protect healthy commands; a
    // silent process may request inspection but is never stopped here.
    const localActivity = worker && 'getActivity' in worker && typeof worker.getActivity === 'function' ? worker.getActivity() : null;
    const lastProgressAt = Date.parse(candidate.progressAt);
    if (!Number.isFinite(lastProgressAt) || !companionStallSuspected({ ...candidate, now, lastProgressAt, localActivity })) continue;
    await getDb().insert(companionEvents).values({ goalId: candidate.goalId, sessionId: candidate.sessionId, kind: 'stall',
      sourceId: `${candidate.agentId}:${lastProgressAt}`, state: candidate.staleCommand ? 'suspected_command_outcome' : 'suspected_stall' }).onConflictDoNothing();
  }
}
