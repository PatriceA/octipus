import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { getConfig } from '@/config';
import { executionEnvironmentsSchema, type ExecutionEnvironment } from '@/shared/execution-environment';

export interface EnvironmentCaller {
  userId: string; workspaceId?: string | null; space?: unknown; trigger?: string;
  metadata?: Record<string, unknown> | null;
}

export function configuredExecutionEnvironments(): ExecutionEnvironment[] {
  return executionEnvironmentsSchema.parse(getConfig().security?.executionEnvironments ?? []);
}

export function pathInEnvironment(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel));
}

/** Resolve on every call: revocation and edits must affect already running agents. */
export function executionEnvironmentFor(caller: EnvironmentCaller): ExecutionEnvironment | undefined {
  // Existing shared-space identity and membership enforcement remains authoritative.
  if (caller.space || !caller.userId) return undefined;
  const entries = configuredExecutionEnvironments().filter(entry => entry.userId === caller.userId && (entry.workspaceId === null || entry.workspaceId === caller.workspaceId));
  const requested = caller.metadata?.executionEnvironmentId;
  if (typeof requested === 'string') {
    const selected = entries.find(entry => entry.id === requested);
    if (!selected?.enabled) throw new Error('Execution environment was removed, disabled or is unavailable for this account/workspace. Open Settings → Environments & Access.');
    return selected;
  }
  const project = caller.metadata?.projectPath;
  if (typeof project === 'string' && isAbsolute(project)) {
    const matching = entries.filter(entry => entry.enabled && entry.roots.some(root => pathInEnvironment(root, project)))
      .sort((a, b) => Math.max(...b.roots.filter(root => pathInEnvironment(root, project)).map(root => root.length)) - Math.max(...a.roots.filter(root => pathInEnvironment(root, project)).map(root => root.length)));
    const specificity = (entry: ExecutionEnvironment) => Math.max(...entry.roots.filter(root => pathInEnvironment(root, project)).map(root => root.length));
    if (matching.length > 1 && specificity(matching[0]) === specificity(matching[1])) throw new Error('Multiple execution environments match this project. Select its environment explicitly.');
    if (matching[0]) return matching[0];
    if (entries.some(entry => !entry.enabled && entry.roots.some(root => pathInEnvironment(root, project)))) throw new Error('This project’s execution environment is disabled. Choose an enabled environment in Settings → Environments & Access.');
  }
  const selected = entries.find(entry => entry.enabled && entry.isDefault && entry.workspaceId === caller.workspaceId)
    ?? entries.find(entry => entry.enabled && entry.isDefault && entry.workspaceId === null);
  if (!selected && entries.some(entry => entry.isDefault && !entry.enabled)) throw new Error('The default execution environment is disabled. Choose an enabled environment in Settings → Environments & Access.');
  return selected;
}

export function executionEnvironmentDescription(caller: EnvironmentCaller) {
  const profile = executionEnvironmentFor(caller);
  return profile ? { id: profile.id, name: profile.name, backend: profile.backend, roots: profile.roots,
    machine: profile.backend === 'ssh' ? profile.ssh!.host : hostname(),
    account: profile.backend === 'ssh' ? profile.ssh!.user : userInfo().username,
    hostIdentity: profile.hostIdentity, network: profile.network, hostServices: profile.hostServices,
    authority: profile.authority, pipelineAutonomy: profile.pipelineAutonomy, approval: profile.approval, background: profile.background,
    note: profile.backend === 'host' ? profile.authority === 'account' ? 'Commands and files use the workstation account’s access, including its installed tools and SSH logins. Project folders select the starting location.' : 'Host commands are not a process sandbox. File tools and working directories remain restricted to the configured folders.'
      : profile.backend === 'sandbox' ? 'Commands require a process sandbox. Approved folders and runtimes are exposed; host login files are not inherited.'
        : 'Commands, Git and filesystem tools run on this SSH host. Host API integrations remain separate connections. Remote filesystem tools require Node.js.' }
    : { backend: 'legacy', note: 'No environment selected. Existing sandbox, CLI and credential settings apply. Configure Settings → Environments & Access for a consistent runtime.' };
}

const activeEnvironmentCaller = new AsyncLocalStorage<EnvironmentCaller>();
export function withExecutionEnvironment<T>(caller: EnvironmentCaller, run: () => T): T { return activeEnvironmentCaller.run(caller, run); }
export function activeHostServiceEnvironment(userId: string): ExecutionEnvironment | undefined {
  const caller = activeEnvironmentCaller.getStore();
  if (!caller || caller.userId !== userId || caller.space) return undefined;
  const environment = executionEnvironmentFor(caller);
  return environment?.backend === 'host' && environment.hostServices ? environment : undefined;
}

/** Broad owner consent, re-resolved on every call; never inherited into a space. */
export function hasAccountAuthority(caller: EnvironmentCaller): boolean {
  return caller.trigger !== 'remote' && executionEnvironmentFor(caller)?.authority === 'account';
}

/** Routine pipeline consent is separate from merely allowing shell commands. */
export function hasPipelineAutonomy(caller: EnvironmentCaller): boolean {
  const profile = caller.trigger !== 'remote' ? executionEnvironmentFor(caller) : undefined;
  return profile?.authority === 'account' && profile.pipelineAutonomy && profile.background === 'automatic' || false;
}

/** Account authority matches unsandboxed command access; roots still select the project start location. */
export function accountFileRoots(profile: ExecutionEnvironment): string[] {
  if (profile.backend === 'ssh' || process.platform !== 'win32') return ['/'];
  return Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`).filter(existsSync);
}
