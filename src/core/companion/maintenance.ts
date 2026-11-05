import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { WorkspaceFS } from '@/security/workspace-fs';
import { getConfig } from '@/config';
import type { CompanionScope } from '@/shared/companion-supervision';
import { companionMaintenanceSchema } from '@/shared/companion-maintenance';

export function maintenanceRuntime(scope: CompanionScope) {
  const config = companionMaintenanceSchema.parse(getConfig().security.companionMaintenance);
  if (!config.enabled || config.userId !== scope.userId || !config.roots.length) throw new Error('Configure your maintenance runtime in Settings → CLI tools');
  const roots = config.roots.map(root => {
    const path = realpathSync(root);
    if (!statSync(path).isDirectory()) throw new Error('A maintenance directory is unavailable');
    if (root !== path) throw new Error('Maintenance directory target changed; save the resolved directory in Settings');
    return path;
  });
  return { ...config, roots, binding: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
}

export async function runMaintenance(context: import('@/core/types').AgentContext, input: { command: string; cwd: string; timeout?: number; network?: boolean; useShell?: boolean }) {
  const scope = { userId: context.userId, workspaceId: context.workspaceId! };
  const runtime = maintenanceRuntime(scope);
  const { companionMaintenanceProfile } = await import('./permissions');
  if (!await companionMaintenanceProfile(context)) throw new Error('Maintenance binding was revoked, paused or changed');
  const { WorkspaceFS } = await import('@/security/workspace-fs');
  const cwd = WorkspaceFS.withRoot(runtime.roots[0], { extraAllowedPrefixes: runtime.roots.slice(1) }).resolve(input.cwd);
  const { commandPolicyViolation, matchDestructiveCommand, matchElevatedCommand } = await import('@/tools/shell/policy');
  const violation = commandPolicyViolation(input.command);
  if (violation) throw new Error(violation);
  const action = matchElevatedCommand(input.command) ? 'execute_elevated' : matchDestructiveCommand(input.command) ? 'execute_destructive' : 'execute';
  const { getPermissionManager } = await import('@/security/permissions');
  const { routeApprovalFor } = await import('@/security/approval-route');
  const args = { ...input, cwd };
  const checked = await getPermissionManager().check(context.userId, 'shell', action, args, context, { revalidate: true });
  const decision = await routeApprovalFor(context, { toolId: 'shell', action, toolName: 'run', args }, checked);
  if (decision.route !== 'execute') throw new Error(decision.reason ?? 'Shell operation is outside maintenance authority');
  const { LocalShellOperations } = await import('@/tools/shell/local-operations');
  const { getExecutionSignal } = await import('@/core/execution-scope');
  await (await import('./scheduling')).reserveMaintenancePaths(scope,context.sessionId);
  if(maintenanceRuntime(scope).binding!==runtime.binding||!await companionMaintenanceProfile(context))throw new Error('Maintenance authority changed before dispatch');
  return new LocalShellOperations().exec(input.command, cwd, {
    timeout: input.timeout ?? 120000, signal: getExecutionSignal(context), unsafe: input.useShell === true,
    allowNetwork: input.network === true || runtime.hostServices, allowHostUsb: runtime.hostServices,
    allowHostSshAgent: runtime.sshAgent, allowedCwdRoots: runtime.roots,
    extraReadWrite: [...runtime.roots, ...(runtime.hostServices ? ['/var/run/docker.sock'] : [])],
  });
}

export function maintenanceDirectory(scope: CompanionScope, root: string) {
  const runtime=maintenanceRuntime(scope);
  return WorkspaceFS.withRoot(runtime.roots[0],{extraAllowedPrefixes:runtime.roots.slice(1)}).resolve(root);
}

export async function inspectMaintenance(context: import('@/core/types').AgentContext,input:{path:string;offset?:number}) {
  if(!await (await import('./permissions')).companionMaintenanceProfile(context))throw new Error('Maintenance authority is unavailable');
  const path=maintenanceDirectory({userId:context.userId,workspaceId:context.workspaceId!},input.path);
  const fs=await import('node:fs');
  const stat=fs.statSync(path);
  if(stat.isDirectory())return {path,entries:fs.readdirSync(path).sort().slice(0,200)};
  if(!stat.isFile()||stat.size>2*1024*1024)throw new Error('Choose a text file smaller than 2 MiB');
  const {observeFlow}=await import('@/security/flow-guard');
  observeFlow(context.sessionId,{toolId:'companion',action:'read'},{taints:['private','suspicious',...(/(?:\.env|credential|kubeconfig|id_rsa|id_ed25519)/i.test(path)?['secret' as const]:[])]});
  const content=fs.readFileSync(path,'utf8'); const offset=input.offset??0;
  return {path,offset,content:content.slice(offset,offset+16000),nextOffset:offset+16000<content.length?offset+16000:null};
}
