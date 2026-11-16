import { createHash } from 'node:crypto';
import { z } from 'zod';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { companionGoals, companionReports, type CompanionReport } from '@/db/schema/companion-supervision';
import { sessionGeneration, sessions } from '@/db/schema/sessions';

/**
 * Background check-ins keep their own text private. To tell the owner
 * something they file a structured report, and code decides whether it is
 * worth an interruption: strong evidence, real impact, and either a new matter
 * or a material change since the owner was last told. Nothing nags: an
 * unanswered report is never repeated because time passed.
 */
export const companionReportSchema = z.object({
  goalId: z.uuid().nullable().default(null),
  matter: z.string().trim().min(1).max(120).describe('Stable short key for the thing being reported, e.g. "deploy-blocked" or "review-ready". Reuse it for later news about the same thing.'),
  impact: z.enum(['low', 'normal', 'high']),
  evidence: z.enum(['strong', 'uncertain']).describe('strong: you read fresh records (receipts, session state, verification) that show it. uncertain: anything else.'),
  materialChange: z.enum(['none', 'condition_changed', 'new_option', 'deadline_advanced', 'resolved']).default('none')
    .describe('For a matter already reported: what changed since then. none means nothing the owner needs.'),
  deadline: z.iso.datetime({ offset: true }).optional().describe('When the owner must act by, if there is a real deadline.'),
  message: z.string().trim().min(1).max(1200).describe('What the owner needs to know, in plain everyday language, with the one decision needed if any.'),
}).strict();
export type CompanionReportInput = z.infer<typeof companionReportSchema>;

/** Delivered reports per owner per UTC day, across their workspaces; beyond it only high-impact reports are sent. */
export const COMPANION_REPORT_DAILY_CAP = 12;

type Previous = Pick<CompanionReport, 'deadline' | 'textHash'> | undefined;

/** Pure gate, so the rules are testable without a database. */
export function decideCompanionReport(input: Pick<CompanionReportInput, 'impact' | 'evidence' | 'materialChange'> & { deadline?: Date | null; textHash: string },
  previous: Previous, deliveredToday: number): { deliver: boolean; reason: string } {
  if (input.evidence !== 'strong') return { deliver: false, reason: 'Evidence is uncertain; recorded for the Companion page only.' };
  if (input.impact === 'low') return { deliver: false, reason: 'Low impact; recorded for the Companion page only.' };
  if (previous) {
    if (previous.textHash === input.textHash) return { deliver: false, reason: 'The owner already has this exact report.' };
    const earlier = input.deadline && (!previous.deadline || input.deadline < previous.deadline);
    const material = input.materialChange === 'condition_changed' || input.materialChange === 'new_option' || input.materialChange === 'resolved'
      || (input.materialChange === 'deadline_advanced' && !!earlier);
    if (!material) return { deliver: false, reason: 'Already reported and nothing material changed.' };
  }
  if (deliveredToday >= COMPANION_REPORT_DAILY_CAP && input.impact !== 'high') return { deliver: false, reason: 'Daily report limit reached; recorded for the Companion page only.' };
  return { deliver: true, reason: previous ? 'Material change to a reported matter.' : 'New matter with strong evidence.' };
}

const normalized = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * File a background report for the owner's Companion conversation. Delivered
 * reports become a visible message there and a presence update; recorded ones
 * stay on the Companion page. Concurrent wakes of one owner are serialized on
 * the supervisor session row.
 */
export async function fileCompanionReport(scope: { userId: string; workspaceId: string }, supervisorSessionId: string, raw: unknown) {
  const input = companionReportSchema.parse(raw);
  const deadline = input.deadline ? new Date(input.deadline) : null;
  const matterKey = `${input.goalId ?? 'workspace'}:${normalized(input.matter).replace(/[^\p{L}\p{N}:_-]+/gu, '-')}`;
  const textHash = createHash('sha256').update(normalized(input.message)).digest('hex');
  const outcome = await getDb().transaction(async tx => {
    const [session] = await tx.select({ id: sessions.id, context: sessions.context, userId: sessions.userId, workspaceId: sessions.workspaceId }).from(sessions)
      .where(eq(sessions.id, supervisorSessionId)).for('update');
    if (!session || session.userId !== scope.userId || session.workspaceId !== scope.workspaceId || !session.context?.companionSupervisor)
      throw new Error('Reports go to the owner\'s Companion conversation only');
    if (input.goalId) {
      const [goal] = await tx.select({ id: companionGoals.id }).from(companionGoals)
        .where(and(eq(companionGoals.id, input.goalId), eq(companionGoals.userId, scope.userId), eq(companionGoals.workspaceId, scope.workspaceId)));
      if (!goal) throw new Error('Goal not found in this workspace');
    }
    const [previous] = await tx.select({ deadline: companionReports.deadline, textHash: companionReports.textHash }).from(companionReports)
      .where(and(eq(companionReports.userId, scope.userId), eq(companionReports.workspaceId, scope.workspaceId), eq(companionReports.matterKey, matterKey), eq(companionReports.decision, 'delivered')))
      .orderBy(desc(companionReports.createdAt)).limit(1);
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(companionReports)
      .where(and(eq(companionReports.userId, scope.userId), eq(companionReports.decision, 'delivered'), gt(companionReports.createdAt, dayStart)));
    const decision = decideCompanionReport({ ...input, deadline, textHash }, previous, count);
    // A report to send is saved as recorded until its message is posted, so a
    // failed or interrupted post never counts as telling the owner.
    const [report] = await tx.insert(companionReports).values({ ...scope, goalId: input.goalId, matterKey, impact: input.impact, evidence: input.evidence,
      materialChange: input.materialChange, deadline, message: input.message, textHash, decision: 'recorded', reason: decision.deliver ? 'Not sent: posting did not complete.' : decision.reason }).returning();
    return { report, generation: sessionGeneration(session.context), deliver: decision.deliver, reason: decision.reason };
  });
  if (!outcome.deliver) return { delivered: false, reason: outcome.reason, reportId: outcome.report.id };
  const { messageRepository } = await import('@/db/repositories/message-repository');
  const posted = await messageRepository.createForGeneration({ sessionId: supervisorSessionId, role: 'assistant', content: input.message,
    metadata: { companionReport: { id: outcome.report.id, ...(input.goalId ? { goalId: input.goalId } : {}) } } }, outcome.generation);
  if (!posted) {
    const reason = 'The Companion conversation was cleared; the report stays on the Companion page.';
    await getDb().update(companionReports).set({ reason }).where(eq(companionReports.id, outcome.report.id));
    return { delivered: false, reason, reportId: outcome.report.id };
  }
  await getDb().update(companionReports).set({ decision: 'delivered', reason: outcome.reason, messageId: posted.id }).where(eq(companionReports.id, outcome.report.id));
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  await sessionRepository.incrementMessageCount(supervisorSessionId);
  const { getAgentService } = await import('@/core/agent/service');
  getAgentService().publishResponse(supervisorSessionId, scope.userId, { response: input.message, sessionId: supervisorSessionId, classification: { type: 'casual', confidence: 1 } });
  return { delivered: true, reason: outcome.reason, reportId: outcome.report.id };
}
