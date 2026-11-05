import { randomUUID } from 'node:crypto';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { companionActions, companionGoals, companionSessionLinks } from '@/db/schema/companion-supervision';
import { users } from '@/db/schema/users';
import { workspaces } from '@/db/schema/organizations';
import { sessions, sessionGeneration } from '@/db/schema/sessions';
import { agents } from '@/db/schema/agents';
import { raiseSessionLevel } from '@/core/protection/session-level';
import { observeFlow } from '@/security/flow-guard';
import { persistCompanionSource } from './provenance';
import { CompanionService } from './service';
import { coreLogger } from '@/utils/logger';

/** A journal entry is claimed once; expired executions require inspection, never blind replay. */
export class CompanionDispatcher {
  private running = new Set<string>();
  async tick() {
    await (await import('./observation')).tickCompanionObservation();
    // Every server stops its own workers after an owner's durable pause,
    // including when the control request reached a different server instance.
    const paused = await getDb().select({ sessionId: sessions.id, userId: companionGoals.userId }).from(sessions)
      .innerJoin(companionSessionLinks, eq(companionSessionLinks.sessionId, sessions.id))
      .innerJoin(companionGoals, eq(companionGoals.id, companionSessionLinks.goalId))
      .where(and(eq(sessions.status, 'paused'), eq(companionSessionLinks.active, true), eq(companionSessionLinks.ownership, 'owner'),
        sql`${companionSessionLinks.pipelineId} IS NULL`, eq(sessions.userId, companionGoals.userId), eq(sessions.workspaceId, companionGoals.workspaceId))).limit(100);
    if (paused.length) {
      const { getAgentManager } = await import('@/core/agent-manager');
      for (const session of paused) getAgentManager().stopSession(session.sessionId, session.userId);
    }
    await getDb().update(companionActions).set({ status: 'unknown', leaseToken: null, leaseUntil: null,
      result: 'Execution receipt was interrupted. Inspect the linked session before retrying.', updatedAt: new Date() })
      .where(and(eq(companionActions.status, 'running'), lte(companionActions.leaseUntil, new Date())));
    await this.steerPending();
    if (this.running.size >= 2) return;
    const candidates = await getDb().select({ action: companionActions, userId: companionGoals.userId, workspaceId: companionGoals.workspaceId })
      .from(companionActions).innerJoin(companionGoals, eq(companionGoals.id, companionActions.goalId))
      .innerJoin(users, eq(users.id, companionGoals.userId)).innerJoin(workspaces, eq(workspaces.id, companionGoals.workspaceId))
      .where(and(eq(companionActions.status, 'queued'), sql`${companionActions.kind} <> 'steer_session'`, inArray(companionGoals.state, ['active', 'queued', 'waiting']), eq(users.isActive, true),
        eq(workspaces.kind, 'personal'), eq(workspaces.userId, companionGoals.userId), sql`${workspaces.archivedAt} IS NULL`,
        sql`(${companionActions.kind} = 'steer_session' OR NOT EXISTS (SELECT 1 FROM companion_actions earlier WHERE earlier.session_id = ${companionActions.sessionId}
          AND earlier.id <> ${companionActions.id} AND (earlier.status IN ('running','unknown')
          OR (earlier.status = 'queued' AND (earlier.created_at, earlier.id) < (${companionActions.createdAt}, ${companionActions.id})))))`))
      .orderBy(companionActions.createdAt).limit(2 - this.running.size);
    for (const candidate of candidates) {
      const token = randomUUID();
      const claimed = await getDb().transaction(async tx => {
        await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, candidate.action.sessionId)).for('update');
        const [busy] = await tx.select({ id: companionActions.id }).from(companionActions).where(and(eq(companionActions.sessionId, candidate.action.sessionId), inArray(companionActions.status, ['running', 'unknown']), sql`${companionActions.kind} <> 'steer_session'`));
        if (busy) return undefined;
        return (await tx.update(companionActions).set({ status: 'running', leaseToken: token, leaseUntil: new Date(Date.now() + 90_000), updatedAt: new Date() })
          .where(and(eq(companionActions.id, candidate.action.id), eq(companionActions.status, 'queued'))).returning())[0];
      });
      if (!claimed) continue;
      this.running.add(claimed.id);
      void this.run(claimed, candidate, token).catch(error => coreLogger.error({ error, actionId: claimed.id }, 'Companion action receipt could not be saved')).finally(() => this.running.delete(claimed.id));
    }
  }
  private async steerPending() {
    const candidates = await getDb().select({ action: companionActions, userId: companionGoals.userId, workspaceId: companionGoals.workspaceId })
      .from(companionActions).innerJoin(companionGoals, eq(companionGoals.id, companionActions.goalId))
      .innerJoin(users, eq(users.id, companionGoals.userId)).innerJoin(workspaces, eq(workspaces.id, companionGoals.workspaceId))
      .where(and(eq(companionActions.status, 'queued'), eq(companionActions.kind, 'steer_session'), inArray(companionGoals.state, ['active', 'queued', 'waiting']),
        eq(users.isActive, true), eq(workspaces.kind, 'personal'), eq(workspaces.userId, companionGoals.userId), sql`${workspaces.archivedAt} IS NULL`))
      .orderBy(companionActions.updatedAt).limit(20);
    for (const candidate of candidates) {
      try {
        const { getAgentService } = await import('@/core/agent/service');
        if (getAgentService().canSteer(candidate.action.sessionId)) {
          await this.deliverSteering(candidate);
        } else {
          const [busy] = await getDb().select({ id: agents.id }).from(agents).where(and(eq(agents.sessionId, candidate.action.sessionId), eq(agents.status, 'running'))).limit(1);
          if (!busy) await getDb().update(companionActions).set({ kind: 'message_session' }).where(and(eq(companionActions.id, candidate.action.id), eq(companionActions.status, 'queued')));
        }
        await getDb().update(companionActions).set({ updatedAt: new Date() }).where(and(eq(companionActions.id, candidate.action.id), eq(companionActions.status, 'queued')));
      } catch (error) { coreLogger.error({ error, actionId: candidate.action.id }, 'Companion steering failed'); }
    }
  }
  private async deliverSteering(candidate: { action: typeof companionActions.$inferSelect; userId: string; workspaceId: string }) {
    const { action } = candidate;
    const detail = await new CompanionService({ userId: candidate.userId, workspaceId: candidate.workspaceId }).readGoal(action.goalId);
    const [session] = await getDb().select({ context: sessions.context, status: sessions.status, userId: sessions.userId, workspaceId: sessions.workspaceId,
      protectionLevel: sessions.protectionLevel, flowLabel: sessions.flowLabel }).from(sessions).where(eq(sessions.id, action.sessionId));
    if (!session || session.status !== 'active' || session.userId !== candidate.userId || session.workspaceId !== candidate.workspaceId
      || sessionGeneration(session.context) !== action.generation || !['active', 'queued', 'waiting'].includes(detail.goal.state)
      || !detail.links.some(link => link.active && link.ownership === 'owner' && !link.pipelineId && link.sessionId === action.sessionId)) return;
    const token = randomUUID();
    const [claimed] = await getDb().update(companionActions).set({ status: 'running', leaseToken: token, leaseUntil: new Date(Date.now() + 90_000) })
      .where(and(eq(companionActions.id, action.id), eq(companionActions.status, 'queued'))).returning();
    if (!claimed) return;
    raiseSessionLevel(action.sessionId, session.protectionLevel ?? 1);
    observeFlow(action.sessionId, { toolId: 'companion', action: 'steer' }, { taints: (['private', 'secret', 'suspicious'] as const).filter(flag => !!session.flowLabel?.[flag]) });
    const { getAgentService } = await import('@/core/agent/service');
    let delivered = false;
    try {
      const { getAgentManager } = await import('@/core/agent-manager');
      const root = getAgentManager().getBySession(action.sessionId).find(worker => worker.getStatus() === 'running' && worker.getContext().root);
      if (!root) throw new Error('The running session no longer has a root');
      const { resolveModel } = await import('@/models/resolve-model');
      const row = await resolveModel({ userId: candidate.userId, name: root.getContext().modelName ?? root.getContext().model });
      if (!row) throw new Error('The running model is no longer available');
      const { assertMayLeave } = await import('@/core/protection/routing');
      await assertMayLeave(row, action.sessionId);
      delivered = getAgentService().steer(action.sessionId, { role: 'user', content: action.message, timestamp: new Date() });
    } catch (error) {
      await getDb().update(companionActions).set({ status: 'failed', result: (error as Error).message.slice(0, 1000), leaseToken: null, leaseUntil: null, updatedAt: new Date() })
        .where(and(eq(companionActions.id, action.id), eq(companionActions.leaseToken, token)));
      return;
    }
    await getDb().update(companionActions).set({ status: delivered ? 'completed' : 'queued', leaseToken: null, leaseUntil: null,
      result: delivered ? 'Instructions delivered to the running session.' : null, updatedAt: new Date() })
      .where(and(eq(companionActions.id, action.id), eq(companionActions.leaseToken, token)));
  }
  private async run(action: typeof companionActions.$inferSelect, scope: { userId: string; workspaceId: string }, token: string) {
    const heartbeat = setInterval(() => { void getDb().update(companionActions).set({ leaseUntil: new Date(Date.now() + 90_000) })
      .where(and(eq(companionActions.id, action.id), eq(companionActions.leaseToken, token), eq(companionActions.status, 'running')))
      .catch(error => coreLogger.error({ error, actionId: action.id }, 'Companion lease renewal failed')); }, 20_000);
    heartbeat.unref();
    let started = false;
    try {
      const { getAgentService } = await import('@/core/agent/service');
      const service = new CompanionService({ userId: scope.userId, workspaceId: scope.workspaceId });
      const result = await getAgentService().handleMessage(action.sessionId, scope.userId, action.message, 'monitor', [], undefined, async () => {
        const { goal, links } = await service.readGoal(action.goalId);
        const [live] = await getDb().select({ id: companionActions.id }).from(companionActions).where(and(eq(companionActions.id, action.id), eq(companionActions.leaseToken, token), eq(companionActions.status, 'running')));
        const [session] = await getDb().select({ status: sessions.status, userId: sessions.userId, workspaceId: sessions.workspaceId, context: sessions.context }).from(sessions).where(eq(sessions.id, action.sessionId));
        if (!live || !['queued', 'active', 'waiting'].includes(goal.state) || !links.some(link => link.sessionId === action.sessionId && link.active && link.ownership === 'owner' && !link.pipelineId)
          || session?.status !== 'active' || session.userId !== scope.userId || session.workspaceId !== scope.workspaceId || sessionGeneration(session.context) !== action.generation) throw new Error('Companion dispatch is no longer authorized, or the session was paused or cleared');
        started = true;
      });
      getAgentService().publishResponse(action.sessionId, scope.userId, result);
      const provenance = await persistCompanionSource(scope, action.sessionId);
      await getDb().update(companionActions).set({ status: result.outcome === 'success' ? 'completed' : 'failed',
        protectionLevel: provenance.protectionLevel ?? action.protectionLevel, flowLabel: provenance.flowLabel ?? action.flowLabel,
        result: result.response.slice(0, 8000), leaseToken: null, leaseUntil: null, updatedAt: new Date() })
        .where(and(eq(companionActions.id, action.id), eq(companionActions.leaseToken, token), eq(companionActions.status, 'running')));
    } catch (error) {
      await getDb().update(companionActions).set({ status: started ? 'unknown' : 'cancelled', result: (error as Error).message.slice(0, 1000),
        leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(and(eq(companionActions.id, action.id), eq(companionActions.leaseToken, token), eq(companionActions.status, 'running')));
    } finally { clearInterval(heartbeat); }
  }
}
export const companionDispatcher = new CompanionDispatcher();
let timer: ReturnType<typeof setInterval> | undefined;
let ticking = false;
export function startCompanion() {
  if (timer) return;
  const tick = async () => { if (ticking) return; ticking = true; try { await companionDispatcher.tick(); } catch (error) { coreLogger.error({ error }, 'Companion dispatch failed'); } finally { ticking = false; } };
  timer = setInterval(() => void tick(), 5000); timer.unref(); void tick();
}
export function stopCompanion() { clearInterval(timer); timer = undefined; }
