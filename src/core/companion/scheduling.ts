import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { and, eq, inArray, sql, or, isNull, ne } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { companionActions, companionActivations, companionClaimMutex, companionClaims, companionGoals, companionSessionLinks, companionSettings, companionStageReservations } from '@/db/schema/companion-supervision';
import { sessions } from '@/db/schema/sessions';
import { isInside } from '@/security/workspace-fs';
import { maintenanceRuntime } from './maintenance';
import { workspaces } from '@/db/schema/organizations';
import { companionSettingsSchema, type CompanionScope } from '@/shared/companion-supervision';
const rowsOf=<T>(value:unknown):T[]=>Array.isArray(value)?value:(value as {rows:T[]}).rows;
type Transaction=Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

export function companionCheckout(path:string) {
  let current=realpathSync(path);
  while(dirname(current)!==current) {if(existsSync(join(current,'.git')))return current;current=dirname(current);}
  return realpathSync(path);
}

export async function companionSpend(scope:CompanionScope,goalId?:string,tx:Transaction|ReturnType<typeof getDb>=getDb()) {
  if(!goalId){
    const daily=await tx.execute<{spent:string}>(sql`SELECT coalesce(sum(used),0)::text AS spent FROM (
      SELECT greatest(c.input_tokens+c.output_tokens-coalesce(c.cached_input_tokens,0),0) AS used FROM cost_log c WHERE c.user_id=${scope.userId} AND c.workspace_id=${scope.workspaceId}
        AND c.created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND (EXISTS(SELECT 1 FROM companion_session_links l WHERE l.session_id=c.session_id) OR EXISTS(SELECT 1 FROM companion_settings s WHERE s.supervisor_session_id=c.session_id))
      UNION ALL SELECT coalesce(a.billable_tokens,a.total_tokens,0) AS used FROM agents a WHERE a.user_id=${scope.userId} AND a.workspace_id=${scope.workspaceId}
        AND (a.created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' OR a.status='running' OR a.completed_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
        AND NOT EXISTS(SELECT 1 FROM cost_log c WHERE c.agent_id=a.id AND c.user_id=${scope.userId})
        AND (EXISTS(SELECT 1 FROM companion_session_links l WHERE l.session_id=a.session_id) OR EXISTS(SELECT 1 FROM companion_settings s WHERE s.supervisor_session_id=a.session_id))
    ) usage`);
    return Number(rowsOf<{spent:string}>(daily)[0]?.spent??0);
  }
  const result=await tx.execute<{spent:string}>(sql`SELECT coalesce(sum(coalesce(a.billable_tokens,a.total_tokens,0)),0)::text AS spent FROM agents a
    WHERE a.user_id=${scope.userId} AND a.workspace_id=${scope.workspaceId} AND
    (${goalId??null}::uuid IS NULL AND a.created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      OR ${goalId??null}::uuid IS NOT NULL) AND (
      EXISTS(SELECT 1 FROM companion_session_links l JOIN companion_goals g ON g.id=l.goal_id WHERE l.session_id=a.session_id AND g.user_id=${scope.userId} AND g.workspace_id=${scope.workspaceId} AND (${goalId??null}::uuid IS NULL OR g.id=${goalId??null}::uuid))
      OR ${goalId??null}::uuid IS NULL AND EXISTS(SELECT 1 FROM companion_settings c WHERE c.supervisor_session_id=a.session_id AND c.user_id=${scope.userId} AND c.workspace_id=${scope.workspaceId}))`);
  return Number(rowsOf<{spent:string}>(result)[0]?.spent??0);
}

/** Serialized under workspace lock; reservations and checkout claims survive crashes. */
export async function prepareCompanionDispatch(tx:Transaction,action:typeof companionActions.$inferSelect,scope:CompanionScope) {
  await tx.select({id:workspaces.id}).from(workspaces).where(and(eq(workspaces.id,scope.workspaceId),eq(workspaces.userId,scope.userId))).for('update');
  await tx.execute(sql`SELECT id FROM companion_admission_mutex WHERE id='activation' FOR SHARE`);
  const [activation]=await tx.select({id:companionActivations.id}).from(companionActivations).where(eq(companionActivations.status,'launched')).limit(1);
  if(activation)return;
  const [goal]=await tx.select().from(companionGoals).where(eq(companionGoals.id,action.goalId));
  const [settings]=await tx.select().from(companionSettings).where(and(eq(companionSettings.userId,scope.userId),eq(companionSettings.workspaceId,scope.workspaceId)));
  const limits=companionSettingsSchema.parse(settings?.options??{});
  const wait=async(reason:string)=>{await tx.update(companionActions).set({result:`Waiting: ${reason}`}).where(and(eq(companionActions.id,action.id),eq(companionActions.status,'queued')));return undefined;};
  if(!goal)return;
  if(goal.dependencies.length) {
    const dependencies=await tx.select({id:companionGoals.id,state:companionGoals.state}).from(companionGoals).where(and(inArray(companionGoals.id,goal.dependencies),eq(companionGoals.userId,scope.userId),eq(companionGoals.workspaceId,scope.workspaceId)));
    if(dependencies.length!==goal.dependencies.length||dependencies.some(g=>g.state!=='completed'))return wait('a prerequisite goal is not verified complete');
  }
  const busy=await tx.execute<{sessions:string}>(sql`SELECT count(DISTINCT session_id)::text AS sessions FROM (
    SELECT a.session_id FROM companion_actions a JOIN companion_goals g ON g.id=a.goal_id WHERE g.user_id=${scope.userId} AND g.workspace_id=${scope.workspaceId} AND a.status IN ('running','unknown') AND a.kind<>'steer_session'
    UNION SELECT a.session_id FROM agents a WHERE a.user_id=${scope.userId} AND a.workspace_id=${scope.workspaceId} AND a.status='running' AND EXISTS(SELECT 1 FROM companion_session_links l WHERE l.session_id=a.session_id AND l.active AND l.ownership='owner')
  ) busy`);
  if(Number(rowsOf<{sessions:string}>(busy)[0]?.sessions??0)>=limits.maxConcurrent)return wait('supervised concurrency limit');
  const reserved=await tx.execute<{tokens:string}>(sql`SELECT coalesce(sum(a.token_cap),0)::text AS tokens FROM companion_actions a JOIN companion_goals g ON g.id=a.goal_id WHERE g.user_id=${scope.userId} AND g.workspace_id=${scope.workspaceId} AND a.status IN ('running','unknown')`);
  const daily=limits.dailyTokenBudget-await companionSpend(scope,undefined,tx)-Number(rowsOf<{tokens:string}>(reserved)[0]?.tokens??0);
  const goalReservations=await tx.select({cap:companionActions.tokenCap}).from(companionActions).where(and(eq(companionActions.goalId,goal.id),inArray(companionActions.status,['running','unknown'])));
  const remaining=goal.tokenBudget===null?Infinity:goal.tokenBudget-await companionSpend(scope,goal.id,tx)-goalReservations.reduce((sum,row)=>sum+(row.cap??0),0);
  const wakeReservation=await tx.execute<{tokens:string}>(sql`SELECT coalesce(sum(w.token_cap),0)::text AS tokens FROM companion_wakes w JOIN companion_settings s ON s.id=w.settings_id WHERE s.user_id=${scope.userId} AND s.workspace_id=${scope.workspaceId} AND w.status IN ('running','unknown')`);
  const stages=await tx.select({tokens:companionStageReservations.tokens,goalId:companionStageReservations.goalId}).from(companionStageReservations).innerJoin(companionGoals,eq(companionGoals.id,companionStageReservations.goalId)).where(and(eq(companionGoals.userId,scope.userId),eq(companionGoals.workspaceId,scope.workspaceId)));
  const cap=Math.min(limits.turnTokenBudget,daily-Number(rowsOf<{tokens:string}>(wakeReservation)[0]?.tokens??0)-stages.reduce((sum,row)=>sum+row.tokens,0),remaining-stages.filter(row=>row.goalId===goal.id).reduce((sum,row)=>sum+row.tokens,0));
  if(cap<1000)return wait('token budget exhausted; state is preserved. Raise the budget or wait for the next UTC day');
  if(!await reserveCompanionPaths(tx,action,scope))return wait('another supervised execution owns this checkout or maintenance runtime');
  return {tokenCap:cap};
}

async function reserveCompanionPaths(tx:Transaction,action:typeof companionActions.$inferSelect,scope:CompanionScope){
 await tx.select().from(companionClaimMutex).where(eq(companionClaimMutex.id,'dispatch')).for('update');
 const [session]=await tx.select({context:sessions.context}).from(sessions).where(eq(sessions.id,action.sessionId));
 const resources:string[]=[];
 if(session?.context?.companionMaintenance){
   resources.push(`maintenance:${scope.userId}`,...maintenanceRuntime(scope).roots.map(root=>`maintenance-root:${root}`));
 }else if(session?.context?.projectPath){try{resources.push(`checkout:${companionCheckout(session.context.projectPath)}`);}catch{return false;}}
 if(!resources.length)return true;
 const overlaps=(a:string,b:string)=>{
   if(a===b)return true;
   const path=(s:string)=>s.startsWith('checkout:')?s.slice(9):s.startsWith('maintenance-root:')?s.slice(17):null;
   const x=path(a),y=path(b);return !!x&&!!y&&(isInside(x,y)||isInside(y,x));
 };
 const claims=await tx.select({resource:companionClaims.resource,sessionId:companionActions.sessionId}).from(companionClaims).innerJoin(companionActions,eq(companionActions.id,companionClaims.actionId));
 if(claims.some(c=>c.sessionId!==action.sessionId&&resources.some(resource=>overlaps(resource,c.resource))))return false;
 const peers=await tx.select({id:sessions.id,context:sessions.context}).from(sessions).where(and(ne(sessions.id,action.sessionId),
   sql`EXISTS(SELECT 1 FROM companion_session_links l WHERE l.session_id=${sessions.id} AND l.active AND l.ownership='owner')`,
   sql`(EXISTS(SELECT 1 FROM agents a WHERE a.session_id=${sessions.id} AND a.status='running') OR EXISTS(SELECT 1 FROM pipelines p WHERE p.session_id=${sessions.id} AND p.status IN ('running','awaiting_approval')))`));
 for(const peer of peers){
   if(peer.context?.companionMaintenance){if(resources.some(r=>r.startsWith('maintenance:')))return false;}
   if(peer.context?.projectPath)try{const key=`checkout:${companionCheckout(peer.context.projectPath)}`;if(resources.some(r=>overlaps(r,key)))return false;}catch{continue;}
 }
 for(const resource of resources)await tx.insert(companionClaims).values({resource,actionId:action.id}).onConflictDoUpdate({target:companionClaims.resource,set:{actionId:action.id}});
 return true;
}

export async function reserveMaintenancePaths(scope:CompanionScope,sessionId:string){
 return getDb().transaction(async tx=>{
  await tx.select({id:workspaces.id}).from(workspaces).where(eq(workspaces.id,scope.workspaceId)).for('update');
  const [action]=await tx.select().from(companionActions).where(eq(companionActions.sessionId,sessionId)).orderBy(sql`${companionActions.createdAt} DESC`).limit(1);
  if(!action||!await reserveCompanionPaths(tx,action,scope))throw new Error('Another supervised execution owns an overlapping maintenance directory');
 });
}

export async function releaseCompanionClaims() {
  await getDb().execute(sql`DELETE FROM companion_stage_reservations r USING pipelines p WHERE p.id=r.pipeline_id AND p.status NOT IN ('running','awaiting_approval')`);
  await getDb().execute(sql`DELETE FROM companion_claims c USING companion_actions a WHERE a.id=c.action_id AND a.status IN ('completed','failed','cancelled')
    AND NOT EXISTS(SELECT 1 FROM agents worker WHERE worker.session_id=a.session_id AND worker.status='running')
    AND NOT EXISTS(SELECT 1 FROM pipelines p WHERE p.session_id=a.session_id AND p.status IN ('running','awaiting_approval'))`);
}

export async function companionRemainingBudget(scope:CompanionScope,goalId?:string) {
 const [settings]=await getDb().select().from(companionSettings).where(and(eq(companionSettings.userId,scope.userId),eq(companionSettings.workspaceId,scope.workspaceId)));
 const options=companionSettingsSchema.parse(settings?.options??{});
 const daily=options.dailyTokenBudget-await companionSpend(scope);
 if(!goalId)return Math.max(0,daily);
 const [goal]=await getDb().select({budget:companionGoals.tokenBudget}).from(companionGoals).where(and(eq(companionGoals.id,goalId),eq(companionGoals.userId,scope.userId),eq(companionGoals.workspaceId,scope.workspaceId)));
 return Math.max(0,Math.min(daily,goal?.budget==null?Infinity:goal.budget-await companionSpend(scope,goalId)));
}

/** Reserve a stage slice under the same workspace lock as turns and wakes. */
export async function reserveCompanionStage(scope:CompanionScope,sessionId:string,pipelineId:string,requested?:number){
 return getDb().transaction(async tx=>{
  await tx.select({id:workspaces.id}).from(workspaces).where(eq(workspaces.id,scope.workspaceId)).for('update');
  const [goal]=await tx.select({goal:companionGoals}).from(companionGoals).innerJoin(companionSessionLinks,eq(companionSessionLinks.goalId,companionGoals.id)).where(and(eq(companionSessionLinks.sessionId,sessionId),or(isNull(companionSessionLinks.pipelineId),eq(companionSessionLinks.pipelineId,pipelineId)),eq(companionSessionLinks.active,true),eq(companionSessionLinks.ownership,'owner'),eq(companionGoals.userId,scope.userId),eq(companionGoals.workspaceId,scope.workspaceId),inArray(companionGoals.state,['active','queued','waiting'])));
  if(!goal)return undefined;
  const [settings]=await tx.select().from(companionSettings).where(and(eq(companionSettings.userId,scope.userId),eq(companionSettings.workspaceId,scope.workspaceId)));
  const limits=companionSettingsSchema.parse(settings?.options??{});
  const stages=await tx.select({goalId:companionStageReservations.goalId,tokens:companionStageReservations.tokens}).from(companionStageReservations).innerJoin(companionGoals,eq(companionGoals.id,companionStageReservations.goalId)).where(and(eq(companionGoals.userId,scope.userId),eq(companionGoals.workspaceId,scope.workspaceId),ne(companionStageReservations.pipelineId,pipelineId)));
  const actions=await tx.select({goalId:companionActions.goalId,cap:companionActions.tokenCap}).from(companionActions).innerJoin(companionGoals,eq(companionGoals.id,companionActions.goalId)).where(and(eq(companionGoals.userId,scope.userId),eq(companionGoals.workspaceId,scope.workspaceId),ne(companionActions.sessionId,sessionId),inArray(companionActions.status,['running','unknown'])));
  const wakes=await tx.execute<{tokens:string}>(sql`SELECT coalesce(sum(w.token_cap),0)::text AS tokens FROM companion_wakes w JOIN companion_settings s ON s.id=w.settings_id WHERE s.user_id=${scope.userId} AND s.workspace_id=${scope.workspaceId} AND w.status IN ('running','unknown')`);
  const cap=Math.max(0,Math.min(requested??limits.turnTokenBudget,limits.dailyTokenBudget-await companionSpend(scope,undefined,tx)-stages.reduce((sum,row)=>sum+row.tokens,0)-actions.reduce((sum,row)=>sum+(row.cap??0),0)-Number(rowsOf<{tokens:string}>(wakes)[0]?.tokens??0),goal.goal.tokenBudget===null?Infinity:goal.goal.tokenBudget-await companionSpend(scope,goal.goal.id,tx)-stages.filter(row=>row.goalId===goal.goal.id).reduce((sum,row)=>sum+row.tokens,0)-actions.filter(row=>row.goalId===goal.goal.id).reduce((sum,row)=>sum+(row.cap??0),0)));
  if(cap<1000)throw new CompanionBudgetWaitError();
  await tx.insert(companionStageReservations).values({pipelineId,goalId:goal.goal.id,tokens:cap}).onConflictDoUpdate({target:companionStageReservations.pipelineId,set:{tokens:cap,createdAt:new Date()}});
  return cap;
 });
}
export async function releaseCompanionStage(pipelineId:string){await getDb().delete(companionStageReservations).where(eq(companionStageReservations.pipelineId,pipelineId));}

export class CompanionBudgetWaitError extends Error {
 constructor(){super('Companion stage token budget is reserved or exhausted; checkpoint preserved.');this.name='CompanionBudgetWaitError';}
}
