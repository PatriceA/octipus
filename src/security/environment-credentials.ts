import { delimiter } from 'node:path';
import { runtimePath } from './runtime-path';
import { buildHostChildEnv, isSensitiveEnvName } from './child-env';
import { markToolNotExecuted } from '@/core/tool-execution-error';
import type { AgentContext } from '@/core/types';
import { executionEnvironmentFor } from './execution-environments';
import { getVault } from './vault';
import { redactCredentialData } from './credential-redaction';
import type { ShellEnvOptions } from '@/tools/shell/operations';

/** Explicit owner-selected vault bindings are decrypted only inside the runtime consumer. */
export async function environmentCredentialOptions<T extends ShellEnvOptions & { env?: Record<string, string> }>(context: Pick<AgentContext, 'id' | 'userId' | 'workspaceId' | 'space' | 'metadata'> & { toolId?: string }, options: T) {
  const environment = executionEnvironmentFor(context);
  const values: string[] = environment?.backend === 'host' && environment.hostIdentity
    ? Object.entries(buildHostChildEnv()).filter(([name]) => isSensitiveEnvName(name)).map(([, value]) => value) : [];
  const env = { ...options.env };
  if (environment && environment.backend !== 'ssh' && environment.pathDirectories.length > 0) env.PATH = runtimePath([...environment.pathDirectories, env.PATH ?? process.env.PATH ?? ''].join(delimiter));
  for (const binding of environment?.credentials ?? []) {
    const value = await getVault().getByNameAuthorized({ userId: context.userId, workspaceId: context.workspaceId,
      toolId: 'execution-environment', agentId: context.id }, binding.secret);
    if (!value) throw markToolNotExecuted(context.toolId ?? 'shell', new Error(`Credential ${binding.secret} is unavailable, expired or not permitted for execution environments. Connect it in Secrets and test readiness again.`));
    env[binding.variable] = value; values.push(value);
  }
  return { options: { ...options, env }, maskError: (error: unknown) => {
    if (error instanceof Error && values.length) { error.message = redactCredentialData(error.message, values) as string; if (error.stack) error.stack = redactCredentialData(error.stack, values) as string; if (error.cause) error.cause = redactCredentialData(error.cause, values); }
    return error;
  }, mask: <R>(result: R): R => values.length ? redactCredentialData(result, values) as R : result };
}
