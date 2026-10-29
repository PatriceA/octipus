import { redactAgentDiagnostics } from '@/security/credential-redaction';
import { getCLIToolConfig, resolveCliModelEntry } from '@/core/cli-agent-factory';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { agents } from '@/db/schema/agents';
import { redactedCommand } from '@/utils/command-log';

export interface DelegationAttempt {
  executionId: string;
  sequence: number;
  appliedRoutePolicy?: { primaryModel: string; backupAllowed: boolean };
  dispatchId: string;
  agentId: string;
  uiAgentId: string;
  requestedModel: string;
  selectedModel: string;
  selectedModelName: string;
  route: 'primary' | 'backup';
  selectedProvider?: string;
  adapter?: string;
  accountIdentity: 'not_reported' | 'operator_cli' | 'personal_cli';
  credentialOwnerId?: string | null;
  quotaProvider?: string;
  fallbackReason?: string;
  startedAt: string;
  providerStartedAt?: string | null;
  endedAt?: string;
  status: string;
  error?: string;
  exitCode?: number | null;
  signal?: string | null;
  stderr?: string;
}

/** One durable execution record per worker.run, including same-worker retries.
 * Metadata updates append/replace only this execution id, preserving all other
 * agent metadata and concurrent completion updates. No raw error is persisted.
 */
async function persist(attempt: DelegationAttempt): Promise<void> {
  const recorded = await getDb().update(agents).set({ metadata: sql`
    jsonb_set(coalesce(${agents.metadata}, '{}'::jsonb), '{delegationAttempts}',
      coalesce((SELECT jsonb_agg(entry) FROM jsonb_array_elements(
        coalesce(${agents.metadata}->'delegationAttempts', '[]'::jsonb)) entry
        WHERE entry->>'executionId' <> ${attempt.executionId}), '[]'::jsonb)
      || ${JSON.stringify([attempt])}::jsonb)`
  }).where(eq(agents.id, attempt.agentId)).returning({ id: agents.id });
  if (!recorded.length) throw new Error('Agent execution could not be recorded; no worker execution is authorized');
}

export async function runDelegationAttempt<T>(
  input: Omit<DelegationAttempt, 'executionId' | 'startedAt' | 'status' | 'accountIdentity' | 'sequence'>,
  history: DelegationAttempt[], run: () => Promise<T>,
  owner: { userId: string; workspaceId?: string | null },
  diagnostics?: () => { providerStartedAt: string | null; credentialSource: 'operator_cli' | 'personal_cli'; credentialOwnerId: string | null; quotaProvider: string; exitCode?: number | null; signal?: string | null } | null,
): Promise<T> {
  const cli = getCLIToolConfig(input.selectedModel);
  const entry = cli ? null : await resolveCliModelEntry(input.selectedModel, { modelName: input.selectedModelName, userId: owner.userId }).catch(() => null);
  const attempt: DelegationAttempt = { ...input, selectedProvider: cli?.modelProvider ?? entry?.provider ?? 'not_reported', adapter: cli?.name, accountIdentity: 'not_reported', executionId: randomUUID(), sequence: history.length + 1, startedAt: new Date().toISOString(), status: 'running' };
  history.push(attempt);
  let primaryError: unknown;
  let executionStarted = false;
  try {
    await persist(attempt);
    executionStarted = true;
    const result = await run();
    attempt.status = 'completed';
    return result;
  } catch (error) {
    primaryError = error;
    attempt.status = executionStarted ? 'failed' : 'not_started';
    attempt.error = redactedCommand(error instanceof Error ? error.message : String(error)).slice(0, 16_000);
    const diagnostics = (error as { cliDiagnostics?: { exitCode?: number | null; signal?: string | null; stderr?: string; credentialSource?: 'operator_cli' | 'personal_cli'; credentialOwnerId?: string | null; quotaProvider?: string } } | null)?.cliDiagnostics;
    if (diagnostics) {
      attempt.accountIdentity = diagnostics.credentialSource ?? 'not_reported';
      attempt.credentialOwnerId = diagnostics.credentialOwnerId;
      attempt.quotaProvider = diagnostics.quotaProvider;
      attempt.exitCode = diagnostics.exitCode;
      attempt.signal = diagnostics.signal;
      attempt.stderr = redactedCommand(diagnostics.stderr ?? '').slice(-8000);
    }
    throw error;
  } finally {
    const observed = diagnostics?.();
    if (observed) { const { credentialSource, ...fields } = observed; Object.assign(attempt, fields, { accountIdentity: credentialSource }); }
    attempt.endedAt = new Date().toISOString();
    const safe = await redactAgentDiagnostics(owner.userId, owner.workspaceId ?? null, {
      attempt,
      failure: primaryError instanceof Error ? { name: primaryError.name, message: primaryError.message,
        stack: primaryError.stack, fields: { ...primaryError } } : undefined,
    }).catch(() => ({
      attempt: { ...attempt, error: 'Failure details withheld: credential redaction unavailable', stderr: undefined },
      failure: { name: 'Error', message: 'Failure details withheld: credential redaction unavailable', stack: undefined, fields: {} },
    })) as { attempt: DelegationAttempt; failure?: { name: string; message: string; stack?: string; fields: Record<string, unknown> } };
    Object.assign(attempt, safe.attempt);
    let propagated: Error | undefined;
    if (primaryError) {
      const failure = safe.failure;
      propagated = new Error(failure?.message ?? attempt.error ?? 'Delegated execution failed');
      if (primaryError instanceof Error) Object.setPrototypeOf(propagated, Object.getPrototypeOf(primaryError));
      propagated.name = failure?.name ?? 'Error';
      propagated.stack = failure?.stack ?? `${propagated.name}: ${propagated.message}`;
      for (const [key, value] of Object.entries(failure?.fields ?? {})) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
        Object.defineProperty(propagated, key, { value, writable: true, configurable: true, enumerable: true });
      }
    }
    try { await persist(attempt); }
    catch (persistenceError) { if (!propagated) throw persistenceError; }
    if (propagated) throw propagated;
  }
}

export function formatAttemptHistory(result: { dispatchId?: string; attempts?: DelegationAttempt[]; appliedRoutePolicy?: unknown }): string {
  return result.attempts?.length ? `\n<delegationHistory>${JSON.stringify({ dispatchId: result.dispatchId, appliedRoutePolicy: result.appliedRoutePolicy, attempts: result.attempts })}</delegationHistory>` : '';
}
