import { delimiter } from 'node:path';
import { runtimePath } from './runtime-path';
import { buildHostChildEnv, isSensitiveEnvName } from './child-env';
import { markToolNotExecuted } from '@/core/tool-execution-error';
import type { AgentContext } from '@/core/types';
import { executionEnvironmentFor } from './execution-environments';
import { getVault } from './vault';
import { redactCredentialData } from './credential-redaction';
import type { ShellEnvOptions } from '@/tools/shell/operations';

/**
 * Host variables are masked because their NAME looks like a credential, which
 * also catches flags and counts (`…_KEYS_FACT=1`, `MAX_THINKING_TOKENS=31999`).
 * Masking such a value replaces that digit or word, and its hex and base64
 * forms, everywhere in the run's output, which corrupted paths and ids (an
 * Antigravity init event's hashed cwd failed its isolation check). A value
 * shorter than this is not a credential worth that; a vault binding the owner
 * chose is masked whatever its length.
 */
export const MIN_INHERITED_SECRET_LENGTH = 8;

/** Explicit owner-selected vault bindings are decrypted only inside the runtime consumer. */
export async function environmentCredentialOptions<T extends ShellEnvOptions & { env?: Record<string, string> }>(context: Pick<AgentContext, 'id' | 'userId' | 'workspaceId' | 'space' | 'metadata'> & { toolId?: string }, options: T) {
  const environment = executionEnvironmentFor(context);
  const values: string[] = environment?.backend === 'host' && environment.hostIdentity
    ? Object.entries(buildHostChildEnv()).filter(([name, value]) => isSensitiveEnvName(name) && value.length >= MIN_INHERITED_SECRET_LENGTH).map(([, value]) => value) : [];
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
