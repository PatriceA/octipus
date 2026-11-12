/**
 * Is a lane's model usable right now — asked BEFORE a child is spawned on it.
 *
 * Without this a child bound to a dead model spends a run, a provider retry
 * and a backup attempt finding out: the provider_error path in
 * `runChildAttempts` is the first place the failure shows, minutes in. The
 * signals here are the ones the process already holds and can read in
 * microseconds — the provider's circuit breaker and whether a CLI model's
 * executable is on PATH. Nothing is spawned and nothing is billed; a model this
 * cannot judge is treated as available (fail open), because a wrong "down"
 * would block delegation that would have worked.
 *
 * Not a model picker. Lanes stay admin-bound (`core/agent/lane-intent.ts`);
 * the only alternative this ever offers is the lane's own backup binding.
 */
import { getCircuitBreakerRegistry } from '@/models/circuit-breaker';
import { getCLIToolConfig, isCLIProvider } from '@/core/cli-agent-factory';
import { configuredCliBinary } from '@/core/cli-executable';
import { getExtensionRoute, isExtensionModelName } from '@/models/extension-models';
import { cliRateLimitKey } from '@/models/cli-rate-limit-key';

export type ModelAvailability = { available: true } | { available: false; reason: string };

/** The fields of a registry row this needs; `provider` unknown ⇒ only the CLI-pattern checks run. */
export interface AvailabilityTarget {
  modelId: string;
  name?: string;
  provider?: string | null;
}

/** An install or uninstall is rare; a stat per spawn is cheap but not free. */
const BINARY_CHECK_TTL_MS = 60_000;
const binaryChecks = new Map<string, { at: number; error: string | null }>();

/** Test seam: forget cached executable lookups. */
export function __resetAvailabilityCacheForTests(): void {
  binaryChecks.clear();
}

function binaryError(binary: string): string | null {
  const cached = binaryChecks.get(binary);
  if (cached && Date.now() - cached.at < BINARY_CHECK_TTL_MS) return cached.error;
  let error: string | null = null;
  try {
    configuredCliBinary(binary);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  binaryChecks.set(binary, { at: Date.now(), error });
  return error;
}

/**
 * The circuit-breaker key the provider router uses for this model — the same
 * derivation as `resolveRateLimitKey` (models/providers/index.ts), without
 * importing every provider client into the spawner.
 */
export function circuitKeyFor(target: AvailabilityTarget, cli: boolean): string | null {
  const extName = [target.name, target.modelId].find((n): n is string => !!n && isExtensionModelName(n));
  if (extName) {
    const route = getExtensionRoute(extName);
    if (route) return route.providerKey;
  }
  if (cli) return cliRateLimitKey(target.modelId);
  return target.provider || null;
}

/** Cheap, cached, never throws. */
export function checkModelAvailability(target: AvailabilityTarget): ModelAvailability {
  try {
    const tool = getCLIToolConfig(target.modelId);
    const cli = target.provider ? isCLIProvider(target.provider) : !!tool;

    const key = circuitKeyFor(target, cli);
    if (key) {
      // `getAllStatuses`, not `getStatus`: the latter creates a breaker for a
      // provider that has never been called.
      const status = getCircuitBreakerRegistry().getAllStatuses().find((s) => s.provider === key);
      if (status?.state === 'open') {
        const since = status.openedAt ? new Date(status.openedAt).toISOString() : 'recently';
        const retry = status.nextRetryAt ? `, retry after ${new Date(status.nextRetryAt).toISOString()}` : '';
        return { available: false, reason: `circuit breaker for '${key}' open since ${since}${retry}` };
      }
    }

    if (cli && tool) {
      const missing = binaryError(tool.binaryPath);
      if (missing) return { available: false, reason: `CLI '${tool.binaryPath}' not installed: ${missing}` };
    }
    return { available: true };
  } catch {
    return { available: true };
  }
}

/** A bound model as `name (modelId)`, or the id alone when they agree. */
export function describeModel(row: { modelId: string; name?: string } | null | undefined): string {
  if (!row) return 'none';
  return row.name && row.name !== row.modelId ? `${row.name} (${row.modelId})` : row.modelId;
}

/**
 * The `routePolicy.primaryModel` denial. Names what the lane IS bound to, so
 * the agent can repeat the right name or drop the field instead of guessing —
 * it still cannot pick a model: the only value that passes is the binding.
 */
export function routeMismatchMessage(requested: string, lane: string, modelId: string, modelName: string): string {
  return `Requested primaryModel '${requested}' does not match the configured route. No child was started. ` +
    `The '${lane}' lane is bound to '${modelName || modelId}'${modelName && modelName !== modelId ? ` (model id '${modelId}')` : ''}; ` +
    'pass that, omit routePolicy.primaryModel, or ask the user to change the binding.';
}

export type PreSpawnRoute =
  | { route: 'primary' }
  | { route: 'backup'; modelId: string; modelName: string; reason: string }
  | { route: 'deny'; reason: string };

/**
 * Decide where a child goes when its resolved model may be down. Only the
 * lane's own backup binding is ever offered — never a model of the agent's
 * choosing — and only when the caller allows a backup.
 */
export async function routeAroundUnavailable(input: {
  lane: string;
  primary: AvailabilityTarget;
  allowBackup: boolean;
  /** The lane's backup binding for the requester; called only when needed. */
  resolveBackup: () => Promise<{ modelId: string; name: string; provider?: string | null } | null>;
}): Promise<PreSpawnRoute> {
  const primary = checkModelAvailability(input.primary);
  if (primary.available) return { route: 'primary' };
  const label = `lane '${input.lane}' model ${describeModel(input.primary)} unavailable: ${primary.reason}`;
  if (!input.allowBackup) return { route: 'deny', reason: `${label}; backup disabled by routePolicy` };
  const backup = await input.resolveBackup().catch(() => null);
  if (!backup || (backup.modelId === input.primary.modelId && (!backup.name || backup.name === input.primary.name))) {
    return { route: 'deny', reason: `${label}; no backup bound` };
  }
  const backupCheck = checkModelAvailability(backup);
  if (!backupCheck.available) {
    return { route: 'deny', reason: `${label}; backup ${describeModel(backup)} also unavailable: ${backupCheck.reason}` };
  }
  return { route: 'backup', modelId: backup.modelId, modelName: backup.name, reason: label };
}
