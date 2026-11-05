import { maintenanceRuntime as maintenanceRuntimeForCallImpl } from './maintenance';
import { WorkspaceFS as WorkspaceFSForCall } from '@/security/workspace-fs';
const maintenanceRuntimeForCall = (caller: ApprovalCaller) => maintenanceRuntimeForCallImpl({ userId: caller.userId, workspaceId: caller.workspaceId! });
import { and, eq, isNull, inArray } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { companionGoals, companionIncidents, companionSessionLinks, companionSettings } from '@/db/schema/companion-supervision';
import { users } from '@/db/schema/users';
import { workspaces } from '@/db/schema/organizations';
import { sessions } from '@/db/schema/sessions';
import type { ApprovalCaller } from '@/security/approval-route';
import type { SpaceToolCall } from '@/security/space-tools';
import { pipelinePermissionProfileSchema } from '@/shared/pipeline-permissions';
import { companionControllerTools } from './tool-policy';

async function companionScopeAvailable(caller: ApprovalCaller) {
  if(!caller.workspaceId)return false;
  const [scope]=await getDb().select({id:workspaces.id}).from(workspaces).innerJoin(users,eq(users.id,workspaces.userId)).where(and(
    eq(workspaces.id,caller.workspaceId),eq(workspaces.userId,caller.userId),eq(workspaces.kind,'personal'),isNull(workspaces.archivedAt),eq(users.isActive,true),eq(users.kind,'local')));
  return !!scope;
}

export async function companionGoalProfile(caller: ApprovalCaller) {
  if (!caller.sessionId || !caller.workspaceId || caller.space || caller.trigger === 'remote') return;
  if(!await companionScopeAvailable(caller))return;
  const [row] = await getDb().select({ goal: companionGoals }).from(companionGoals)
    .innerJoin(companionSessionLinks, eq(companionSessionLinks.goalId, companionGoals.id))
    .innerJoin(sessions, eq(sessions.id, companionSessionLinks.sessionId))
    .where(and(eq(companionGoals.userId, caller.userId), eq(companionGoals.workspaceId, caller.workspaceId),
      inArray(companionGoals.state, ['active','queued','waiting']), eq(companionSessionLinks.sessionId, caller.sessionId),
      isNull(companionSessionLinks.pipelineId), eq(companionSessionLinks.active, true), eq(companionSessionLinks.ownership, 'owner'),
      eq(sessions.userId, caller.userId), eq(sessions.workspaceId, caller.workspaceId), eq(sessions.status, 'active'), isNull(sessions.groupChannelId)));
  const policy = row?.goal.executionPolicy;
  const parsed = pipelinePermissionProfileSchema.safeParse(policy?.profile);
  if (policy?.approvedBy === caller.userId && parsed.success && parsed.data.executionScope === 'run') return { goalId: row.goal.id, profile: parsed.data, approvedAt: policy.approvedAt };
}

/** Owner-enabled coordination covers only scoped controller operations. */
export async function companionCoordinationAllowed(caller: ApprovalCaller, call: SpaceToolCall) {
  if (call.toolId !== 'companion' || !caller.sessionId || !caller.workspaceId || caller.space || caller.trigger === 'remote') return false;
  if(!await companionScopeAvailable(caller))return false;
  const [settings] = await getDb().select().from(companionSettings).innerJoin(sessions, eq(sessions.id, companionSettings.supervisorSessionId))
    .where(and(eq(companionSettings.userId, caller.userId), eq(companionSettings.workspaceId, caller.workspaceId),
      eq(companionSettings.supervisorSessionId, caller.sessionId), eq(companionSettings.enabled, true), eq(sessions.status, 'active'),
      eq(sessions.userId, caller.userId), eq(sessions.workspaceId, caller.workspaceId), isNull(sessions.groupChannelId)));
  if (!settings) return false;
  const live = settings.companion_settings;
  return live.autonomy !== 'observe' && companionControllerTools(live.autonomy, true, caller.trigger === 'user').has(`companion__${call.toolName}`);
}

export function companionExecutionCall(call: SpaceToolCall): SpaceToolCall {
  if (call.toolId === 'companion' && ['verify_incident','maintenance_run','maintenance_check'].includes(call.toolName ?? '')) {
    const { command, cwd, timeout, network, useShell, root } = call.args ?? {};
    return { toolId: 'shell', action: 'execute', toolName: 'run', args: { command, cwd: cwd ?? root, timeout, network, useShell } };
  }
  return call;
}

export async function companionMaintenanceProfile(caller: ApprovalCaller) {
  if (!caller.sessionId || !caller.workspaceId || caller.space || caller.trigger === 'remote') return;
  if(!await companionScopeAvailable(caller))return;
  const [session] = await getDb().select().from(sessions).where(and(eq(sessions.id, caller.sessionId), eq(sessions.userId, caller.userId), eq(sessions.workspaceId, caller.workspaceId), eq(sessions.status, 'active'),eq(sessions.kind,'chat'),isNull(sessions.groupChannelId)));
  if (!session?.context?.companionMaintenance) return;
  const { maintenanceRuntime } = await import('./maintenance');
  let runtime;
  try { runtime = maintenanceRuntime({ userId: caller.userId, workspaceId: caller.workspaceId }); } catch { return; }
  if (runtime.binding !== session.context.companionMaintenance.binding) return;
  const [settings] = await getDb().select().from(companionSettings).where(and(eq(companionSettings.userId, caller.userId), eq(companionSettings.workspaceId, caller.workspaceId), eq(companionSettings.enabled, true), eq(companionSettings.autonomy, 'repair')));
  if (!settings || settings.revision !== session.context.companionMaintenance.authorityRevision) return;
  const repair=session.context.companionMaintenance;
  if(repair.incidentId){const [incident]=await getDb().select().from(companionIncidents).where(eq(companionIncidents.id,repair.incidentId));if(incident?.state!=='repairing'||incident.strategies.length!==repair.strategyIndex)return;const [affected]=await getDb().select({status:sessions.status}).from(sessions).where(and(eq(sessions.id,incident.sessionId),eq(sessions.userId,caller.userId),eq(sessions.workspaceId,caller.workspaceId)));if(affected?.status!=='active')return;}
  const [goal] = await getDb().select({ id: companionGoals.id }).from(companionGoals).innerJoin(companionSessionLinks, eq(companionSessionLinks.goalId, companionGoals.id)).where(and(
    eq(companionSessionLinks.sessionId, caller.sessionId), eq(companionSessionLinks.active, true), eq(companionSessionLinks.ownership, 'owner'),
    eq(companionGoals.userId, caller.userId), eq(companionGoals.workspaceId, caller.workspaceId), inArray(companionGoals.state, ['active','queued','waiting'])));
  if (!goal) return;
  return { goalId: goal.id, revision: settings.revision, maintenance: true as const, profile: pipelinePermissionProfileSchema.parse({ executionScope: 'run', repoPath: runtime.roots[0], repoPaths: runtime.roots.slice(1), hostServices: runtime.hostServices, overnight: true }) };
}

export async function companionActivationAllowed(caller: ApprovalCaller, call: SpaceToolCall) {
  if (call.toolId !== 'companion' || !['activate','maintenance_review','reconcile_activation'].includes(call.toolName ?? '')) return false;
  if (!await companionMaintenanceProfile(caller)) return false;
  if (call.toolName !== 'activate') return true;
  return (await import('./maintenance')).maintenanceRuntime({ userId: caller.userId, workspaceId: caller.workspaceId! }).allowActivation;
}

export function companionProfileCall(caller: ApprovalCaller, call: SpaceToolCall, maintenance = false): SpaceToolCall {
  const normalized=companionExecutionCall(call);
  if(!maintenance)return normalized;
  const {roots}=maintenanceRuntimeForCall(caller);
  const cwd=WorkspaceFSForCall.withRoot(roots[0],{extraAllowedPrefixes:roots.slice(1)}).resolve(typeof normalized.args?.cwd==='string'?normalized.args.cwd:roots[0]);
  return {...normalized,args:{...normalized.args,cwd}};
}
