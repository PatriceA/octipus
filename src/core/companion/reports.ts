import { createHash } from 'node:crypto';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { companionGoals, companionReports, companionSettings, type CompanionReport } from '@/db/schema/companion-supervision';
import { sessionGeneration, sessions } from '@/db/schema/sessions';
import { companionSettingsSchema, type CompanionSettingsInput } from '@/shared/companion-supervision';
import { coreLogger } from '@/utils/logger';
import { ownerHour, quietHour } from './feedback';

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

/** When the owner's quiet hours end, to five minutes; null outside quiet hours. */
export function quietHoursEnd(settings: Pick<CompanionSettingsInput, 'quietHoursStart' | 'quietHoursEnd' | 'timezone'>, now = new Date()): Date | null {
  const hourAt = ownerHour(settings.timezone);
  if (!quietHour(settings, hourAt(now))) return null;
  for (let step = 5; step <= 24 * 60; step += 5) {
    const at = new Date(now.getTime() + step * 60_000);
    if (!quietHour(settings, hourAt(at))) return at;
  }
  return null;
}

type Scope = { userId: string; workspaceId: string };

/**
 * Reports go to linked chats (third-party services) only for work that may
 * leave the machine: not secret-labelled, below protection level 3. They are
 * still posted in the Companion conversation.
 */
export function externalChatsAllowed(source: { protectionLevel?: number | null; flowLabel?: Partial<Record<string, unknown>> | null }) {
  return (source.protectionLevel ?? 1) < 3 && !source.flowLabel?.secret;
}
type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

/** A report being posted right now counts as told, so a concurrent filing cannot slip past the gate; a stuck one stops counting after ten minutes. */
const SENDING_GRACE_MS = 10 * 60_000;

async function gate(tx: Tx, scope: Scope, report: { matterKey: string; impact: CompanionReport['impact']; evidence: CompanionReport['evidence'];
  materialChange: CompanionReport['materialChange']; deadline: Date | null; textHash: string }, now: Date) {
  const told = or(eq(companionReports.decision, 'delivered'), and(eq(companionReports.decision, 'sending'), gte(companionReports.createdAt, new Date(now.getTime() - SENDING_GRACE_MS))));
  const [previous] = await tx.select({ deadline: companionReports.deadline, textHash: companionReports.textHash }).from(companionReports)
    .where(and(eq(companionReports.userId, scope.userId), eq(companionReports.workspaceId, scope.workspaceId), eq(companionReports.matterKey, report.matterKey), told))
    .orderBy(desc(companionReports.createdAt)).limit(1);
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(companionReports)
    .where(and(eq(companionReports.userId, scope.userId), or(and(eq(companionReports.decision, 'delivered'), gte(companionReports.deliveredAt, dayStart)),
      and(inArray(companionReports.decision, ['sending']), gte(companionReports.createdAt, new Date(now.getTime() - SENDING_GRACE_MS))))));
  return decideCompanionReport(report, previous, count);
}

async function supervisor(tx: Tx, scope: Scope, sessionId: string) {
  const [session] = await tx.select({ id: sessions.id, context: sessions.context }).from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, scope.userId), eq(sessions.workspaceId, scope.workspaceId))).for('update');
  if (!session?.context?.companionSupervisor)
    throw new Error('Reports go to the owner\'s Companion conversation only');
  const [settings] = await tx.select({ options: companionSettings.options }).from(companionSettings)
    .where(and(eq(companionSettings.userId, scope.userId), eq(companionSettings.workspaceId, scope.workspaceId)));
  return { generation: sessionGeneration(session.context), options: companionSettingsSchema.parse(settings?.options ?? {}) };
}

/**
 * Post a report the gate let through. It counts as delivered only once its
 * message exists, so a failed or interrupted post never counts as telling the
 * owner. With chat notices on, it also goes to the owner's linked chats.
 */
async function post(scope: Scope, sessionId: string, report: CompanionReport, generation: string, reason: string, notifyChats: boolean) {
  try { return await postNow(scope, sessionId, report, generation, reason, notifyChats); }
  catch (error) {
    await getDb().update(companionReports).set({ decision: 'recorded', reason: 'Not sent: posting failed.' }).where(and(eq(companionReports.id, report.id), eq(companionReports.decision, 'sending')));
    throw error;
  }
}

async function postNow(scope: Scope, sessionId: string, report: CompanionReport, generation: string, reason: string, notifyChats: boolean) {
  const unsent = (why: string) => getDb().update(companionReports).set({ decision: 'recorded', reason: why }).where(eq(companionReports.id, report.id));
  const { messageRepository } = await import('@/db/repositories/message-repository');
  const posted = await messageRepository.createForGeneration({ sessionId, role: 'assistant', content: report.message,
    metadata: { companionReport: { id: report.id, ...(report.goalId ? { goalId: report.goalId } : {}) } } }, generation);
  if (!posted) {
    const cleared = 'The Companion conversation was cleared; the report stays on the Companion page.';
    await unsent(cleared);
    return { delivered: false, reason: cleared, reportId: report.id };
  }
  await getDb().update(companionReports).set({ decision: 'delivered', deliveredAt: new Date(), reason, messageId: posted.id }).where(eq(companionReports.id, report.id));
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  await sessionRepository.incrementMessageCount(sessionId);
  const { getAgentService } = await import('@/core/agent/service');
  getAgentService().publishResponse(sessionId, scope.userId, { response: report.message, sessionId, classification: { type: 'casual', confidence: 1 } });
  if (notifyChats) {
    const { ownerChatTargets } = await import('./feedback');
    const deliverTo = await ownerChatTargets(scope.userId);
    if (deliverTo.length) await (await import('@/core/notification-service')).getNotificationService().notify(scope.userId, 'companion', 'Companion', report.message,
      { deliverTo, href: '/companion', ...(report.goalId ? { goalId: report.goalId } : {}) }, { workspaceId: scope.workspaceId, id: report.id });
  }
  return { delivered: true, reason, reportId: report.id };
}

/**
 * File a background report for the owner's Companion conversation. Delivered
 * reports become a visible message there and a presence update; recorded ones
 * stay on the Companion page. During quiet hours a report is held until they
 * end, unless it is high impact with a deadline before then. Concurrent wakes
 * of one owner are serialized on the supervisor session row.
 */
export async function fileCompanionReport(scope: Scope, supervisorSessionId: string, raw: unknown, now = new Date(), opts: { externalChats?: boolean } = {}) {
  const input = companionReportSchema.parse(raw);
  const deadline = input.deadline ? new Date(input.deadline) : null;
  const matterKey = `${input.goalId ?? 'workspace'}:${normalized(input.matter).replace(/[^\p{L}\p{N}:_-]+/gu, '-')}`;
  const textHash = createHash('sha256').update(normalized(input.message)).digest('hex');
  const outcome = await getDb().transaction(async tx => {
    const target = await supervisor(tx, scope, supervisorSessionId);
    let goalAllowsChats = true;
    if (input.goalId) {
      const [goal] = await tx.select({ id: companionGoals.id, protectionLevel: companionGoals.protectionLevel, flowLabel: companionGoals.flowLabel }).from(companionGoals)
        .where(and(eq(companionGoals.id, input.goalId), eq(companionGoals.userId, scope.userId), eq(companionGoals.workspaceId, scope.workspaceId)));
      if (!goal) throw new Error('Goal not found in this workspace');
      goalAllowsChats = externalChatsAllowed(goal);
    }
    const fields = { matterKey, impact: input.impact, evidence: input.evidence, materialChange: input.materialChange, deadline, textHash };
    const decision = await gate(tx, scope, fields, now);
    const quietEnd = decision.deliver ? quietHoursEnd(target.options, now) : null;
    const urgent = input.impact === 'high' && !!deadline && !!quietEnd && deadline <= quietEnd;
    const held = !!quietEnd && !urgent;
    const sending = decision.deliver && !held;
    const reason = held ? 'Held for quiet hours; it is sent when they end if nothing replaced it.' : sending ? 'Sending.' : decision.reason;
    const [report] = await tx.insert(companionReports).values({ ...scope, sessionId: supervisorSessionId, goalId: input.goalId, ...fields, message: input.message, decision: sending ? 'sending' : 'recorded', reason,
      deferredUntil: held ? quietEnd : null }).returning();
    return { report, generation: target.generation, notifyChats: target.options.notifyChats && goalAllowsChats && opts.externalChats !== false, deliver: sending, reason: held ? reason : decision.reason };
  });
  if (!outcome.deliver) return { delivered: false, reason: outcome.reason, reportId: outcome.report.id };
  return post(scope, supervisorSessionId, outcome.report, outcome.generation, outcome.reason, outcome.notifyChats);
}

/** Send reports held for quiet hours once they end, re-checking the gate (a newer report may have covered the matter). */
export async function deliverDeferredCompanionReports(now = new Date()) {
  const due = await getDb().select({ id: companionReports.id }).from(companionReports)
    .where(and(isNotNull(companionReports.deferredUntil), lte(companionReports.deferredUntil, now), eq(companionReports.decision, 'recorded'))).orderBy(companionReports.createdAt).limit(50);
  for (const { id } of due) {
    try {
      const claimed = await getDb().transaction(async tx => {
        const [report] = await tx.select().from(companionReports).where(and(eq(companionReports.id, id), isNotNull(companionReports.deferredUntil))).for('update');
        if (!report) return null;
        const scope = { userId: report.userId, workspaceId: report.workspaceId };
        await tx.update(companionReports).set({ deferredUntil: null }).where(eq(companionReports.id, id));
        if (!report.sessionId) { await tx.update(companionReports).set({ reason: 'Companion has no conversation to report to.' }).where(eq(companionReports.id, id)); return null; }
        const target = await supervisor(tx, scope, report.sessionId);
        if (quietHoursEnd(target.options, now)) { await tx.update(companionReports).set({ deferredUntil: quietHoursEnd(target.options, now) }).where(eq(companionReports.id, id)); return null; }
        const decision = await gate(tx, scope, report, now);
        if (!decision.deliver) { await tx.update(companionReports).set({ reason: decision.reason }).where(eq(companionReports.id, id)); return null; }
        await tx.update(companionReports).set({ decision: 'sending', reason: 'Sending.' }).where(eq(companionReports.id, id));
        const [goal] = report.goalId ? await tx.select({ protectionLevel: companionGoals.protectionLevel, flowLabel: companionGoals.flowLabel }).from(companionGoals).where(eq(companionGoals.id, report.goalId)) : [];
        return { report, scope, sessionId: report.sessionId, generation: target.generation, reason: decision.reason, notifyChats: target.options.notifyChats && (!goal || externalChatsAllowed(goal)) };
      });
      if (claimed) await post(claimed.scope, claimed.sessionId, claimed.report, claimed.generation, claimed.reason, claimed.notifyChats);
    } catch (error) { coreLogger.error({ error, reportId: id }, 'Held Companion report could not be sent'); }
  }
}
