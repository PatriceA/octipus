import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, gt, asc, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { companionActions, companionGoals, companionIncidents, companionSessionLinks, companionSettings } from '@/db/schema/companion-supervision';
import { pipelines } from '@/db/schema/pipelines';
import { users } from '@/db/schema/users';
import { workspaces } from '@/db/schema/organizations';
import { companionSettingsSchema, type CompanionSettingsInput } from '@/shared/companion-supervision';

/** Whether an hour of the owner's day (0–23, their timezone) is inside quiet hours. */
export function quietHour(settings:Pick<CompanionSettingsInput,'quietHoursStart'|'quietHoursEnd'>, hour:number) {
  if(settings.quietHoursStart===settings.quietHoursEnd)return false;
  return settings.quietHoursStart<settings.quietHoursEnd?hour>=settings.quietHoursStart&&hour<settings.quietHoursEnd:hour>=settings.quietHoursStart||hour<settings.quietHoursEnd;
}
export function ownerHour(timezone:string){const format=new Intl.DateTimeFormat('en',{hour:'numeric',hourCycle:'h23',timeZone:timezone});return (at:Date)=>Number(format.format(at));}
export function companionQuietHours(settings:Pick<CompanionSettingsInput,'quietHoursStart'|'quietHoursEnd'|'timezone'>, now=new Date()) {
  return quietHour(settings,ownerHour(settings.timezone)(now));
}
function notificationId(identity:string) {
  const h=createHash('sha256').update(`companion:${identity}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
}
/** The owner's linked private chats, as notification deliverTo targets. */
export async function ownerChatTargets(userId: string): Promise<string[]> {
  const { loadNotifyScope, ownerTargets } = await import('@/channels/ownership');
  return ownerTargets(await loadNotifyScope(userId)).map(target => `${target.channelType}:${target.channelId}`);
}
/**
 * One content-minimized notice through the notification service: stored once
 * per durable id (crash and sweep duplicates are dropped), shown live, and
 * sent to the owner's linked chats when they turned chat notices on.
 */
async function notice(settings: { userId: string; workspaceId: string }, targets: () => Promise<string[]>, identity: string, title: string, body: string, metadata: Record<string, unknown>) {
  const { getNotificationService } = await import('@/core/notification-service');
  const { notifications } = await import('@/db/schema/notifications');
  const id = notificationId(identity);
  // Already stored: skip before resolving chat targets on every sweep.
  if ((await getDb().select({ id: notifications.id }).from(notifications).where(eq(notifications.id, id))).length) return false;
  const deliverTo = await targets();
  return getNotificationService().notify(settings.userId, 'companion', title, body, { ...metadata, ...(deliverTo.length ? { deliverTo } : {}) },
    { workspaceId: settings.workspaceId, id });
}
let sweepCursor: string | undefined;
/** Content-minimized updates; durable IDs suppress crash duplicates. Quiet hours delay them until they end. */
export async function tickCompanionFeedback(now=new Date()) {
  await (await import('./reports')).deliverDeferredCompanionReports(now);
  const configs=await getDb().select({settings:companionSettings}).from(companionSettings)
    .innerJoin(users,eq(users.id,companionSettings.userId)).innerJoin(workspaces,eq(workspaces.id,companionSettings.workspaceId))
    .where(and(eq(companionSettings.enabled,true),eq(users.isActive,true),eq(workspaces.kind,'personal'),eq(workspaces.userId,companionSettings.userId),isNull(workspaces.archivedAt), ...(sweepCursor ? [gt(companionSettings.id,sweepCursor)] : []))).orderBy(asc(companionSettings.id)).limit(100);
  sweepCursor=configs.length===100?configs[configs.length-1].settings.id:undefined;
  for(const {settings}of configs) {
    const options=companionSettingsSchema.parse(settings.options);
    if(companionQuietHours(options,now))continue;
    let resolved:Promise<string[]>|undefined;
    const targets=()=>resolved??=(options.notifyChats?ownerChatTargets(settings.userId):Promise.resolve([]));
    const liveGoals=await getDb().select({id:companionGoals.id}).from(companionGoals)
      .where(and(eq(companionGoals.userId,settings.userId),eq(companionGoals.workspaceId,settings.workspaceId),inArray(companionGoals.state,['queued','active','waiting','needs_decision'])));
    const goals=await getDb().select({id:companionGoals.id,state:companionGoals.state}).from(companionGoals)
      .where(and(eq(companionGoals.userId,settings.userId),eq(companionGoals.workspaceId,settings.workspaceId),eq(companionGoals.state,'completed')));
    const incidents=await getDb().select({incident:companionIncidents}).from(companionIncidents).innerJoin(companionGoals,eq(companionGoals.id,companionIncidents.goalId))
      .where(and(eq(companionGoals.userId,settings.userId),eq(companionGoals.workspaceId,settings.workspaceId),inArray(companionIncidents.state,['resolved','escalated'])));
    // A budget gate can prevent model wake-ups too. Report a blocked queued
    // handoff deterministically; do not require another model call to notice it.
    const waiting = await getDb().select({ actionId:companionActions.id,goalId:companionGoals.id }).from(companionActions)
      .innerJoin(companionGoals,eq(companionGoals.id,companionActions.goalId))
      .where(and(eq(companionGoals.userId,settings.userId),eq(companionGoals.workspaceId,settings.workspaceId),
        inArray(companionGoals.state,['queued','active','waiting','needs_decision']),eq(companionActions.status,'queued'),sql`${companionActions.result} LIKE 'Waiting:%'`));
    for(const item of waiting) await notice(settings,targets,`waiting:${item.actionId}`,'Companion handoff has not started','A queued instruction is waiting on a prerequisite. Open Companion to see its delivery status and reason.',
      {goalId:item.goalId,actionId:item.actionId,href:`/companion?goal=${item.goalId}`});
    const failures = await getDb().select({ pipelineId:pipelines.id,attempt:sql<string>`coalesce((SELECT max(e.seq) FROM companion_events e WHERE e.goal_id=${companionGoals.id} AND e.source_id=${pipelines.id}::text AND e.kind='pipelines' AND e.state<>'failed'),0)::text`,goalId:companionGoals.id }).from(pipelines)
      .innerJoin(companionSessionLinks,eq(companionSessionLinks.sessionId,pipelines.sessionId))
      .innerJoin(companionGoals,eq(companionGoals.id,companionSessionLinks.goalId))
      .where(and(eq(pipelines.userId,settings.userId),eq(pipelines.workspaceId,settings.workspaceId),eq(pipelines.status,'failed'),
        eq(companionGoals.userId,settings.userId),eq(companionGoals.workspaceId,settings.workspaceId),eq(companionSessionLinks.active,true),
        inArray(companionGoals.state,['queued','active','waiting','needs_decision']),
        sql`(${companionSessionLinks.pipelineId}=${pipelines.id} OR (${companionSessionLinks.pipelineId} IS NULL AND NOT EXISTS(
          SELECT 1 FROM pipelines newer WHERE newer.session_id=${pipelines.sessionId} AND newer.user_id=${settings.userId}
            AND newer.workspace_id=${settings.workspaceId} AND (newer.created_at,newer.id)>(${pipelines.createdAt},${pipelines.id})
        )))`));
    for(const item of failures) await notice(settings,targets,`failed:${item.goalId}:${item.pipelineId}:${item.attempt}`,'Companion observed a failed pipeline','A supervised pipeline needs attention. Its latest recorded failure is available in Companion; no successful continuation is implied.',
      {goalId:item.goalId,pipelineId:item.pipelineId,href:`/companion?goal=${item.goalId}`});
    for(const item of [...goals.map(goal=>({id:goal.id,goalId:goal.id,state:goal.state})),...incidents.map(({incident})=>({id:incident.id,goalId:incident.goalId,state:incident.state}))]) {
      // An escalation is asked as an approval instead: answerable in the app, from a phone and from chat.
      if(item.state==='escalated')continue;
      await notice(settings,targets,`${item.id}:${item.state}`,'Companion progress verified',
        item.state==='completed'?'A supervised goal passed its acceptance checks.':'A supervised recovery passed its runtime check.',{goalId:item.goalId,href:'/companion'});
    }
    const { raiseIncidentDecisions } = await import('./decisions');
    await raiseIncidentDecisions({ userId: settings.userId, workspaceId: settings.workspaceId, supervisorSessionId: settings.supervisorSessionId },
      incidents.filter(({incident})=>incident.state==='escalated').map(({incident})=>incident), new Set(liveGoals.map(goal=>goal.id)));
  }
}
