import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, gt, asc } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { companionGoals, companionIncidents, companionSettings } from '@/db/schema/companion-supervision';
import { notifications } from '@/db/schema/notifications';
import { users } from '@/db/schema/users';
import { workspaces } from '@/db/schema/organizations';
import { companionSettingsSchema, type CompanionSettingsInput } from '@/shared/companion-supervision';

export function companionQuietHours(settings:Pick<CompanionSettingsInput,'quietHoursStart'|'quietHoursEnd'|'timezone'>, now=new Date()) {
  if(settings.quietHoursStart===settings.quietHoursEnd)return false;
  const hour=Number(new Intl.DateTimeFormat('en',{hour:'numeric',hourCycle:'h23',timeZone:settings.timezone}).format(now));
  return settings.quietHoursStart<settings.quietHoursEnd?hour>=settings.quietHoursStart&&hour<settings.quietHoursEnd:hour>=settings.quietHoursStart||hour<settings.quietHoursEnd;
}
function notificationId(identity:string) {
  const h=createHash('sha256').update(`companion:${identity}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
}
let sweepCursor: string | undefined;
/** App-only, content-minimized updates; durable IDs suppress crash duplicates. */
export async function tickCompanionFeedback(now=new Date()) {
  const configs=await getDb().select({settings:companionSettings}).from(companionSettings)
    .innerJoin(users,eq(users.id,companionSettings.userId)).innerJoin(workspaces,eq(workspaces.id,companionSettings.workspaceId))
    .where(and(eq(companionSettings.enabled,true),eq(users.isActive,true),eq(workspaces.kind,'personal'),eq(workspaces.userId,companionSettings.userId),isNull(workspaces.archivedAt), ...(sweepCursor ? [gt(companionSettings.id,sweepCursor)] : []))).orderBy(asc(companionSettings.id)).limit(100);
  sweepCursor=configs.length===100?configs[configs.length-1].settings.id:undefined;
  for(const {settings}of configs) {
    const options=companionSettingsSchema.parse(settings.options);
    if(companionQuietHours(options,now))continue;
    const goals=await getDb().select({id:companionGoals.id,state:companionGoals.state}).from(companionGoals)
      .where(and(eq(companionGoals.userId,settings.userId),eq(companionGoals.workspaceId,settings.workspaceId),eq(companionGoals.state,'completed')));
    const incidents=await getDb().select({incident:companionIncidents}).from(companionIncidents).innerJoin(companionGoals,eq(companionGoals.id,companionIncidents.goalId))
      .where(and(eq(companionGoals.userId,settings.userId),eq(companionGoals.workspaceId,settings.workspaceId),inArray(companionIncidents.state,['resolved','escalated'])));
    for(const item of [...goals.map(goal=>({id:goal.id,goalId:goal.id,state:goal.state})),...incidents.map(({incident})=>({id:incident.id,goalId:incident.goalId,state:incident.state}))]) {
      await getDb().insert(notifications).values({id:notificationId(`${item.id}:${item.state}`),userId:settings.userId,workspaceId:settings.workspaceId,type:'companion',
        title:item.state==='escalated'?'Companion needs a decision':'Companion progress verified',
        body:item.state==='completed'?'A supervised goal passed its acceptance checks.':item.state==='resolved'?'A supervised recovery passed its runtime check.':'A repair reached its limit. Evidence and the next decision are available in Companion.',
        metadata:{goalId:item.goalId,href:'/companion'}}).onConflictDoNothing();
    }
  }
}
