import { homedir } from 'node:os';
import { posix, resolve } from 'node:path';
import type { AgentContext } from '@/core/types';
import { ToolNotExecutedError } from '@/core/tool-execution-error';
import { executionEnvironmentFor, pathInEnvironment, type EnvironmentCaller } from './execution-environments';
import type { ExecutionEnvironment } from '@/shared/execution-environment';
import { WorkspaceFS } from './workspace-fs';
import { LocalShellOperations } from '@/tools/shell/local-operations';
import { tokenizeSafe } from '@/tools/shell/policy';
import type { ShellEnvOptions, ShellOperations } from '@/tools/shell/operations';

export const quoteRuntimeArg = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Environment values travel over SSH stdin, never argv or a persisted command. */
export const REMOTE_COMMAND_PROGRAM = String.raw`const f=require('node:fs'),c=require('node:child_process');
const q=JSON.parse(f.readFileSync(0,'utf8'));const child=c.spawn('sh',['-c',q.command],{cwd:q.cwd,env:{...process.env,...q.env},stdio:['pipe','inherit','inherit']});
child.on('error',e=>{process.stderr.write(e.message);process.exitCode=127});
child.stdin.on('error',()=>{});child.stdin.end(q.input??'');
child.on('exit',(code,signal)=>{process.exitCode=code??1});
for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>child.kill(signal));`;

export function environmentShellOptions(caller: EnvironmentCaller): ShellEnvOptions & { allowNetwork?: boolean } {
  const profile = executionEnvironmentFor(caller);
  if (!profile) return {};
  return { environmentId: profile.id, sandboxMode: profile.backend === 'sandbox' ? 'required' : 'off',
    inheritHostIdentity: profile.backend === 'host' && profile.hostIdentity,
    allowHostSshAgent: profile.backend === 'host' && profile.hostIdentity,
    allowNetwork: profile.network, allowHostUsb: profile.hostServices,
    extraReadWrite: [...profile.roots, ...(profile.hostServices ? ['/var/run/docker.sock'] : [])] };
}

export function environmentCwd(profile: ExecutionEnvironment, requested?: string): string {
  const cwd = profile.backend === 'ssh' ? posix.resolve(profile.roots[0], requested || '.') : resolve(profile.roots[0], requested || '.');
  if (!profile.roots.some(root => pathInEnvironment(root, cwd))) throw new ToolNotExecutedError('shell', 'Working directory is outside this environment’s approved folders. Open Settings → Environments & Access.');
  return cwd;
}

/** The SSH process is a transport. Command execution and login happen on the selected host. */
export class SshShellOperations implements ShellOperations {
  private readonly local = new LocalShellOperations();
  constructor(private readonly profile: ExecutionEnvironment) {}
  private transport() {
    const remote = this.profile.ssh!;
    const payload = `node -e ${quoteRuntimeArg(REMOTE_COMMAND_PROGRAM)}`;
    return ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-p', String(remote.port), '--', `${remote.user}@${remote.host}`, payload].map(quoteRuntimeArg).join(' ');
  }
  async exec(command: string, cwd: string, options: Parameters<ShellOperations['exec']>[2] = {}) {
    if (!options.unsafe) {
      const argv = tokenizeSafe(command);
      if (!argv) throw new ToolNotExecutedError('shell', 'This command needs useShell:true for shell operators');
      command = argv.map(quoteRuntimeArg).join(' ');
    }
    return this.local.exec(this.transport(), homedir(), {
      timeout: options.timeout, input: JSON.stringify({ command, cwd: environmentCwd(this.profile, cwd), env: options.env, input: options.input }), signal: options.signal, onData: options.onData,
      unsafe: false, allowNetwork: true, allowHostSshAgent: true, sandboxMode: 'off',
    });
  }
  async spawnBackground(command: string, cwd: string, options: Parameters<ShellOperations['spawnBackground']>[2] = {}) {
    if (!options?.unsafe) {
      const argv = tokenizeSafe(command);
      if (!argv) throw new ToolNotExecutedError('shell', 'This command needs useShell:true for shell operators');
      command = argv.map(quoteRuntimeArg).join(' ');
    }
    return this.local.spawnBackground(this.transport(), homedir(), { input: JSON.stringify({ command, cwd: environmentCwd(this.profile, cwd), env: options?.env }), unsafe: false, allowNetwork: true, allowHostSshAgent: true, sandboxMode: 'off', onExit: options?.onExit });
  }
  async which(command: string) {
    if (!/^[a-zA-Z0-9_.+-]+$/.test(command)) throw new ToolNotExecutedError('shell', 'Use an executable name');
    const result = await this.exec(`command -v ${quoteRuntimeArg(command)}`, this.profile.roots[0], { timeout: 15000 });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }
  async getEnv(): Promise<Record<string, string>> { throw new ToolNotExecutedError('shell', 'Remote environment values may contain credentials. Use a specific non-secret readiness check.'); }
}

export function shellOperationsFor(context: AgentContext, legacy: ShellOperations): ShellOperations {
  const profile = executionEnvironmentFor(context);
  return profile?.backend === 'ssh' ? new SshShellOperations(profile) : legacy;
}

export function resolveEnvironmentCwd(requested: unknown, context: AgentContext): string | undefined {
  const profile = executionEnvironmentFor(context);
  if (!profile) return undefined;
  if (requested !== undefined && typeof requested !== 'string') throw new ToolNotExecutedError('shell', 'cwd must be a string');
  const project = typeof context.metadata.projectPath === 'string' ? context.metadata.projectPath : profile.roots[0];
  const cwd = environmentCwd(profile, requested ? (profile.backend === 'ssh' ? posix.resolve(project, requested as string) : resolve(project, requested as string)) : project);
  // Local file and shell tools must use the same symlink-aware resolver.
  return profile.backend === 'ssh' ? cwd : WorkspaceFS.forAgent(context).resolve(cwd);
}
