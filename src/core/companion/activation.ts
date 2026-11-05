import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { and, eq, inArray, or, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { companionActivations, companionGoals, companionSessionLinks, companionEvents, companionSettings, companionActions, companionWakes } from '@/db/schema/companion-supervision';
import { sessions, sessionGeneration } from '@/db/schema/sessions';
import { agents } from '@/db/schema/agents';
import { pipelines } from '@/db/schema/pipelines';
import type { AgentContext } from '@/core/types';
import { maintenanceRuntime, maintenanceDirectory } from './maintenance';
import { companionMaintenanceProfile } from './permissions';

const receiptFile = (id: string) => join(process.env.OCTIPUS_STATE_DIR ?? join(homedir(), '.octipus'), 'companion-activation', `${id}.json`);
export async function queueCompanionActivation(context: AgentContext, input: { requestKey: string; root: string }) {
  const scope = { userId: context.userId, workspaceId: context.workspaceId! };
  const runtime = maintenanceRuntime(scope);
  const delegation = await companionMaintenanceProfile(context);
  const root = maintenanceDirectory(scope,resolve(input.root));
  if (!delegation || !runtime.allowActivation || !existsSync(join(root, 'scripts/companion-activate.mjs')) || !existsSync(join(root, 'bin/octi.mjs')))
    throw new Error('Activation requires an approved installation directory and activation capability');
  await (await import('./maintenance-evidence')).assertMaintenanceAcceptance(context.sessionId, root, runtime.binding);
  const [existing] = await getDb().select().from(companionActivations).where(and(eq(companionActivations.goalId, delegation.goalId), eq(companionActivations.requestKey, input.requestKey)));
  if (existing) return existing;
  const [receipt] = await getDb().insert(companionActivations).values({ goalId: delegation.goalId, sessionId: context.sessionId, requestKey: input.requestKey,
    authorityRevision: delegation.revision, binding: runtime.binding, root }).onConflictDoNothing().returning();
  if (!receipt) {
    const [retry] = await getDb().select().from(companionActivations).where(and(eq(companionActivations.goalId, delegation.goalId), eq(companionActivations.requestKey, input.requestKey)));
    if (retry) return retry;
    throw new Error('Another activation is pending; inspect its receipt');
  }
  return receipt;
}

/** Restart is handed to an independent process only after its durable intent. */
export async function tickCompanionActivation() {
  const pending = await getDb().select({ receipt: companionActivations, goal: companionGoals }).from(companionActivations)
    .innerJoin(companionGoals, eq(companionGoals.id, companionActivations.goalId)).where(inArray(companionActivations.status, ['queued','launched'])).limit(1);
  for (const { receipt, goal } of pending) {
    const authority = await companionMaintenanceProfile({ userId: goal.userId, workspaceId: goal.workspaceId, sessionId: receipt.sessionId, trigger: 'monitor' });
    const authorized = authority?.revision === receipt.authorityRevision && authority?.goalId === goal.id;
    if (receipt.status === 'launched') {
      const file = receiptFile(receipt.id);
      let result: { id: string; status: string; result: string } | undefined;
      try { result = JSON.parse(readFileSync(file, 'utf8')); } catch { /* External launcher has no receipt yet. */ }
      if (result?.id !== receipt.id || !['restarted','failed'].includes(result.status)) {
        if (Date.now() - receipt.updatedAt.getTime() > 600000) await getDb().update(companionActivations).set({ status: 'unknown', updatedAt:new Date(), result: 'Activation receipt interrupted; inspect service state before any retry.' }).where(and(eq(companionActivations.id, receipt.id), eq(companionActivations.status, 'launched')));
        continue;
      }
      await getDb().transaction(async tx=>{
        const [closed]=await tx.update(companionActivations).set({status:result!.status as 'restarted'|'failed',result:result!.result.slice(0,2000),updatedAt:new Date()})
          .where(and(eq(companionActivations.id,receipt.id),eq(companionActivations.status,'launched'))).returning();
        if(!closed)return;
        await tx.insert(companionEvents).values({goalId:goal.id,sessionId:receipt.sessionId,kind:'activation',sourceId:receipt.id,state:result!.status==='restarted'?'completed':'failed'});
        if(!authorized||result!.status!=='restarted'||['paused','completed','cancelled'].includes(goal.state))return;
        const [settings]=await tx.select().from(companionSettings).where(and(eq(companionSettings.userId,goal.userId),eq(companionSettings.workspaceId,goal.workspaceId)));
        if(!settings?.enabled||settings.autonomy!=='repair'||settings.revision!==receipt.authorityRevision)return;
        for(const id of receipt.resumeIds){
          const [run]=await tx.select({pipeline:pipelines,session:sessions}).from(pipelines).innerJoin(sessions,eq(sessions.id,pipelines.sessionId)).where(and(eq(pipelines.id,id),eq(pipelines.userId,goal.userId),eq(pipelines.workspaceId,goal.workspaceId),eq(sessions.status,'active'),eq(pipelines.status,'paused')));
          if(!run||receipt.resumeGenerations[id]!==sessionGeneration(run.session.context))continue;
          const [owner]=await tx.select({id:companionSessionLinks.id}).from(companionSessionLinks).where(and(eq(companionSessionLinks.goalId,goal.id),eq(companionSessionLinks.sessionId,run.session.id),eq(companionSessionLinks.active,true),eq(companionSessionLinks.ownership,'owner'),or(eq(companionSessionLinks.pipelineId,id),isNull(companionSessionLinks.pipelineId))));
          if(!owner)continue;
          const h=createHash('sha256').update(`${receipt.id}:${id}`).digest('hex');const requestKey=`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
          await tx.insert(companionActions).values({goalId:goal.id,sessionId:run.session.id,pipelineId:id,requestKey,kind:'resume_pipeline',message:`Continue the captured pipeline checkpoint after activation ${receipt.id}; inspect current state and never repeat a completed run.`,
            generation:sessionGeneration(run.session.context),protectionLevel:Math.max(goal.protectionLevel,run.session.protectionLevel??1),flowLabel:{...goal.flowLabel,...run.session.flowLabel},authoritySettingsId:settings.id,authorityRevision:settings.revision}).onConflictDoNothing();
        }
      });
      continue;
    }
    let runtime;
    try { runtime = maintenanceRuntime({ userId: goal.userId, workspaceId: goal.workspaceId }); } catch {
      await getDb().update(companionActivations).set({status:'failed',result:'Maintenance runtime authority is unavailable or revoked.'}).where(and(eq(companionActivations.id,receipt.id),eq(companionActivations.status,'queued')));continue;
    }
    const [session] = await getDb().select().from(sessions).where(eq(sessions.id,receipt.sessionId));
    if (!authorized || runtime.binding !== receipt.binding || !runtime.allowActivation || session?.status !== 'active' || ['paused','completed','cancelled'].includes(goal.state)) {
      await getDb().update(companionActivations).set({ status:'failed', result:'Activation authorization was revoked or paused.' }).where(eq(companionActivations.id,receipt.id)); continue;
    }
    try { await (await import('./maintenance-evidence')).assertMaintenanceAcceptance(receipt.sessionId, receipt.root, runtime.binding); } catch {
      await getDb().update(companionActivations).set({status:'failed',result:'Source or acceptance evidence changed before activation.'}).where(eq(companionActivations.id,receipt.id)); continue;
    }
    const busy = await getDb().select({ id: agents.id }).from(agents).where(eq(agents.status,'running')).limit(1);
    const activeRuns = await getDb().select({ id: pipelines.id }).from(pipelines).where(inArray(pipelines.status,['running','awaiting_approval']));
    if (runtime.interruptionPolicy === 'wait' && (busy.length || activeRuns.length)) continue;
    const owned = await getDb().select({ id: pipelines.id,context:sessions.context }).from(pipelines).innerJoin(sessions,eq(sessions.id,pipelines.sessionId)).innerJoin(companionSessionLinks,and(eq(companionSessionLinks.sessionId,pipelines.sessionId),or(eq(companionSessionLinks.pipelineId,pipelines.id),isNull(companionSessionLinks.pipelineId))))
      .where(and(eq(pipelines.userId,goal.userId),eq(pipelines.workspaceId,goal.workspaceId),eq(companionSessionLinks.goalId,goal.id),eq(companionSessionLinks.active,true),eq(companionSessionLinks.ownership,'owner'),inArray(pipelines.status,['running','awaiting_approval'])));
    const claimed = await getDb().transaction(async tx=>{
      await tx.execute(sql`SELECT id FROM companion_admission_mutex WHERE id='activation' FOR UPDATE`);
      const [settings]=await tx.select().from(companionSettings).where(and(eq(companionSettings.userId,goal.userId),eq(companionSettings.workspaceId,goal.workspaceId))).for('share');
      const [liveGoal]=await tx.select().from(companionGoals).where(eq(companionGoals.id,goal.id)).for('share');
      if(!settings?.enabled||settings.autonomy!=='repair'||settings.revision!==receipt.authorityRevision||!liveGoal||['paused','completed','cancelled'].includes(liveGoal.state))return;
      if(runtime.interruptionPolicy==='wait'){
        const [worker]=await tx.select({id:agents.id}).from(agents).where(eq(agents.status,'running')).limit(1);
        const [run]=await tx.select({id:pipelines.id}).from(pipelines).where(inArray(pipelines.status,['running','awaiting_approval'])).limit(1);
        const [action]=await tx.select({id:companionActions.id}).from(companionActions).where(eq(companionActions.status,'running')).limit(1);
        const [wake]=await tx.select({id:companionWakes.id}).from(companionWakes).where(eq(companionWakes.status,'running')).limit(1);
        if(worker||run||action||wake)return;
      }
      return (await tx.update(companionActivations).set({status:'launched',resumeIds:[...new Set(owned.map(row=>row.id))],resumeGenerations:Object.fromEntries(owned.map(row=>[row.id,sessionGeneration(row.context)])),updatedAt:new Date()})
        .where(and(eq(companionActivations.id,receipt.id),eq(companionActivations.status,'queued'))).returning())[0];
    });
    if (!claimed) continue;
    const file=receiptFile(receipt.id); mkdirSync(join(file,'..'),{recursive:true,mode:0o700});
    writeFileSync(file,JSON.stringify({ id:receipt.id,root:receipt.root,status:'launched' }),{mode:0o600});
    // No shell or model-authored command: fixed external launcher, independent
    // process group, no inherited stdio or backend-owned child reaper.
    const child=spawn(process.execPath,[join(receipt.root,'scripts/companion-activate.mjs'),file],{cwd:receipt.root,env:{...process.env,OCTI_NO_BROWSER:'1'},detached:true,stdio:'ignore'});
    child.once('error',()=>{ void getDb().update(companionActivations).set({status:'failed',result:'External launcher could not start.'}).where(eq(companionActivations.id,receipt.id)); }); child.unref();
  }
}

export async function reconcileCompanionActivation(context: AgentContext, input: { activationId: string; evidenceId: string }) {
  const scope=await companionMaintenanceProfile(context);
  if(!scope) throw new Error('Current maintenance authority is required');
  const {verificationEvidence}=await import('@/db/schema/verification-evidence');
  const [receipt]=await getDb().select().from(companionActivations).where(and(eq(companionActivations.id,input.activationId),eq(companionActivations.goalId,scope.goalId)));
  const [evidence]=await getDb().select().from(verificationEvidence).where(and(eq(verificationEvidence.id,input.evidenceId),eq(verificationEvidence.sessionId,context.sessionId)));
  const detail=evidence?.detail as Record<string,unknown>|null;
  if(!receipt||receipt.status!=='unknown'||!evidence?.passed||evidence.createdAt<=receipt.updatedAt||detail?.checkScope!==`activation:${receipt.id}`)
    throw new Error('Inspect current service state with a fresh activation check before reconciling this unknown receipt');
  const [later]=await getDb().select({id:verificationEvidence.id}).from(verificationEvidence).where(and(eq(verificationEvidence.sessionId,context.sessionId),eq(verificationEvidence.passed,false),sql`${verificationEvidence.detail}->>'checkScope' = ${`activation:${receipt.id}`}`,sql`${verificationEvidence.createdAt} >= ${evidence.createdAt}`));
  if(later)throw new Error('A later failing check supersedes this activation pass');
  const [updated]=await getDb().update(companionActivations).set({status:'reconciled',result:`Current service inspected by ${evidence.id}; no restart replayed.`,updatedAt:new Date()})
    .where(and(eq(companionActivations.id,receipt.id),eq(companionActivations.status,'unknown'))).returning();
  return updated;
}
