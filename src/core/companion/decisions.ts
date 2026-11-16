import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { companionIncidents, type CompanionIncident } from '@/db/schema/companion-supervision';
import type { AgentContext } from '@/core/types';
import { coreLogger } from '@/utils/logger';

export const COMPANION_RETRY_OPTION = 'Try another fix';
export const COMPANION_LEAVE_OPTION = 'Leave it';
/** How long an escalation stays answerable from chat or a phone; the Companion page keeps the decision after that. */
export const COMPANION_DECISION_TIMEOUT_MS = 24 * 3600_000;

/**
 * An escalated incident (repair strategies used up, or a repeated strategy)
 * needs the owner's decision. It is asked as an ordinary approval, so it shows
 * in the app, reaches a paired phone and is posted to the owner's linked chats,
 * where a typed reply answers it. The answer is bound to the incident revision
 * it was asked about: a reply after the incident changed retries nothing.
 */
export async function raiseIncidentDecisions(scope: { userId: string; workspaceId: string; supervisorSessionId: string | null },
  incidents: CompanionIncident[], liveGoals: ReadonlySet<string>) {
  if (!scope.supervisorSessionId) return;
  for (const incident of incidents) {
    if (!liveGoals.has(incident.goalId)) continue;
    // Claim the question for this revision once; a crash before it is asked
    // leaves the decision on the Companion page, never a second prompt.
    const [claimed] = await getDb().update(companionIncidents).set({ decisionRevision: incident.revision, decisionRequestId: null })
      .where(and(eq(companionIncidents.id, incident.id), eq(companionIncidents.state, 'escalated'), eq(companionIncidents.revision, incident.revision),
        or(isNull(companionIncidents.decisionRevision), ne(companionIncidents.decisionRevision, incident.revision)))).returning({ id: companionIncidents.id });
    if (!claimed) continue;
    void ask(scope as { userId: string; workspaceId: string; supervisorSessionId: string }, incident)
      .catch(error => coreLogger.error({ error, incidentId: incident.id }, 'Companion decision could not be asked'));
  }
}

async function ask(scope: { userId: string; workspaceId: string; supervisorSessionId: string }, incident: CompanionIncident) {
  const { getAgentService } = await import('@/core/agent/service');
  const context = { id: `companion-decision:${incident.id}`, userId: scope.userId, workspaceId: scope.workspaceId, sessionId: scope.supervisorSessionId,
    root: true, space: null, trigger: 'monitor', funding: 'own', role: 'general', topic: 'general', model: 'companion', status: 'running',
    createdAt: new Date(), updatedAt: new Date(), metadata: { approvalTimeoutMs: COMPANION_DECISION_TIMEOUT_MS } } as unknown as AgentContext;
  const summary = `Companion tried ${incident.strategies.length} fix${incident.strategies.length === 1 ? '' : 'es'} for a blocked goal and stopped: ${incident.summary.replace(/\s+/g, ' ').slice(0, 300)}`;
  const answer = await getAgentService().requestApproval(summary, `Should Companion try one more, different fix? (${COMPANION_RETRY_OPTION} / ${COMPANION_LEAVE_OPTION})`,
    context, [COMPANION_RETRY_OPTION, COMPANION_LEAVE_OPTION], 'question', async requestId => {
      await getDb().update(companionIncidents).set({ decisionRequestId: requestId })
        .where(and(eq(companionIncidents.id, incident.id), eq(companionIncidents.decisionRevision, incident.revision)));
    }) as { approved?: boolean; response?: string; requestId?: string };
  if (!answer?.approved || !answer.requestId || !retryAnswer(answer.response)) return;
  const { CompanionService } = await import('./service');
  await new CompanionService({ userId: scope.userId, workspaceId: scope.workspaceId })
    .reopenIncident(incident.goalId, incident.id, incident.revision, `approval:${answer.requestId}`)
    .catch(error => coreLogger.warn({ error, incidentId: incident.id }, 'Owner allowed another fix, but the incident changed first; nothing was retried'));
}

const RETRY_ANSWERS = new Set([COMPANION_RETRY_OPTION.toLowerCase(), 'yes', 'y', 'ok', 'okay', 'approve', 'approved', 'go ahead', 'try again']);
/** Only "Try another fix" or a plain yes retries. "Leave it", "no, leave it alone" or anything else retries nothing. */
export function retryAnswer(response: string | undefined): boolean {
  return RETRY_ANSWERS.has((response ?? '').trim().toLowerCase().replace(/[.!\s]+$/, ''));
}
