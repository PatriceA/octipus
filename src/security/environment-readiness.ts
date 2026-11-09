import { hostname, userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ExecutionEnvironment, EnvironmentReadiness } from '@/shared/execution-environment';
import { buildAgentContext } from '@/core/agent/context';
import { LocalShellOperations } from '@/tools/shell/local-operations';
import { environmentShellOptions, quoteRuntimeArg, SshShellOperations } from './environment-runtime';
import { environmentToolHome } from './environment-identity';
import { environmentCredentialOptions } from './environment-credentials';
import { withToolHome, HOST_IDENTITY_ENV } from './space-tool-env';

/** Checks run in the actual environment with the same credentials as tools. */
export async function checkEnvironmentReadiness(profile: ExecutionEnvironment, command?: string): Promise<EnvironmentReadiness> {
  const checks: EnvironmentReadiness['checks'] = [];
  let maskError: (error: unknown) => unknown = error => error;
  try {
    const caller = buildAgentContext({ id: `readiness-${profile.id}`, userId: profile.userId, sessionId: '', role: 'general', topic: 'general', model: 'readiness', status: 'running',
      scope: { workspaceId: profile.workspaceId, space: null, trigger: 'user', funding: 'own' }, metadata: { executionEnvironmentId: profile.id } });
    const ops = profile.backend === 'ssh' ? new SshShellOperations(profile) : new LocalShellOperations();
    const home = environmentToolHome(caller);
    const runtime = environmentShellOptions(caller);
    const credentials = await environmentCredentialOptions(caller, { ...runtime, timeout: 15000, extraReadOnly: profile.backend === 'ssh' ? [] : [process.execPath],
      ...(home ? { env: withToolHome({}, home), unsetEnv: HOST_IDENTITY_ENV, extraReadWrite: [...(runtime.extraReadWrite ?? []), home.dir] } : {}) });
    maskError = credentials.maskError;
    const options = credentials.options;
    checks.push({ name: 'Connected credentials', passed: true, detail: profile.credentials.length ? 'All configured credentials are available to this runtime.' : 'No encrypted credential bindings configured.' });
    const node = profile.backend === 'ssh' ? 'node' : quoteRuntimeArg(process.execPath);
    const result = await ops.exec(`${node} -e "process.stdout.write(process.version)"`, profile.roots[0], options);
    checks.push({ name: 'Execution', passed: result.exitCode === 0 && !result.killed,
      detail: result.exitCode === 0 ? `${profile.backend === 'ssh' ? profile.ssh!.user : userInfo().username}@${profile.backend === 'ssh' ? profile.ssh!.host : hostname()}` : 'Runtime did not launch. Check executable, sandbox runner, SSH trust and account access.' });
    if (result.exitCode !== 0 || result.killed) return { status: profile.backend === 'ssh' ? 'not_connected' : 'not_installed', summary: checks.at(-1)!.detail, checks };
    const code = `const f=require('node:fs');const p=require('node:path').join(process.cwd(),'.octipus-probe-${randomUUID()}');f.writeFileSync(p,'probe',{flag:'wx',mode:384});f.unlinkSync(p);process.stdout.write('write-ok')`;
    const write = await ops.exec(`${node} -e ${quoteRuntimeArg(code)}`, profile.roots[0], options);
    const writable = write.exitCode === 0 && !write.killed && write.stdout === 'write-ok';
    checks.push({ name: 'Project files', passed: writable, detail: writable ? 'The runtime can write to its approved project folder.' : 'The runtime cannot write to its project folder.' });
    try {
      const identity = await ops.exec('gh auth status', profile.roots[0], options);
      checks.push({ name: 'GitHub login (optional)', passed: identity.exitCode === 0, detail: identity.exitCode === 0 ? 'GitHub CLI authentication works in this environment.' : 'GitHub CLI is absent or has no usable login here. API connection authentication is separate.' });
    } catch (error) {
      const masked = credentials.maskError(error);
      checks.push({ name: 'GitHub login (optional)', passed: false, detail: `Optional CLI check could not run: ${masked instanceof Error ? masked.message : 'unknown runtime failure'}` });
    }
    const custom = command ? credentials.mask(await ops.exec(command, profile.roots[0], options)) : undefined;
    if (custom) checks.push({ name: 'Your runtime check', passed: custom.exitCode === 0 && !custom.killed, detail: custom.exitCode === 0 ? 'Command succeeded in this environment.' : 'Command failed in this environment; see its redacted output.' });
    return { status: !writable ? 'not_authorized' : custom && (custom.exitCode !== 0 || custom.killed) ? 'check_failed' : 'ready', summary: writable ? 'Execution and project access work. Account and runtime checks are listed below.' : 'Fix folder access before starting work.', checks,
      ...(custom ? { result: { exitCode: custom.exitCode, stdout: custom.stdout.slice(0, 8000), stderr: custom.stderr.slice(0, 8000), timedOut: custom.timedOut } } : {}) };
  } catch (error) {
    const masked = maskError(error);
    return { status: 'unreachable', summary: masked instanceof Error ? masked.message : 'Environment check failed', checks };
  }
}
