/**
 * Is a lane's model usable right now — asked BEFORE a child is spawned on it.
 *
 * Without this a child bound to a dead model spends a run, a provider retry
 * and a backup attempt finding out: the provider_error path in
 * `runChildAttempts` is the first place the failure shows, minutes in. The
 * signals here are ones the process already holds and reads without a
 * network call or a subprocess:
 *
 * - a DIRECT provider's circuit breaker (key = the provider name, or an
 *   extension row's own key). The provider router trips it on transport
 *   failures (5xx, 429, network, timeout) against that same provider client.
 *   A child's own calls neither consult nor feed it, so an open breaker is a
 *   provider-health signal from other traffic, not the gate the child hits.
 * - NOT the `litellm` breaker: only the router's LiteLLM fallback trips it,
 *   so it says nothing about a LiteLLM-row child's proxy route.
 * - NOT the `cli-*` breakers: only one-shot router calls trip them; a CLI
 *   agent child runs through `cli-agent-worker`, which never touches them.
 *   A CLI child is judged by its executable alone (the cached lookup the CLI
 *   provider's health check uses).
 *
 * A model this cannot judge is treated as available (fail open): a wrong
 * "down" would block delegation that would have worked.
 *
 * Not a model picker. Lanes stay admin-bound (`core/agent/lane-intent.ts`);
 * the only alternative this ever offers is the lane's own backup binding.
 */
import { getCircuitBreakerRegistry } from '@/models/circuit-breaker';
import { getCLIToolConfig, isCLIProvider } from '@/core/cli-agent-factory';
import { getExtensionRoute, isExtensionModelName } from '@/models/extension-models';
import { cliToolAvailable } from '@/models/providers/cli-provider';

export type ModelAvailability = { available: true } | { available: false; reason: string };

/** The fields of a registry row this needs; `provider` unknown ⇒ only the CLI-pattern check runs. */
export interface AvailabilityTarget {
  modelId: string;
  name?: string;
  provider?: string | null;
}

/** Reasons travel into denials, attempt history and `list_lanes`: keep them short. */
export const MAX_REASON_CHARS = 500;
const cap = (s: string): string => (s.length > MAX_REASON_CHARS ? `${s.slice(0, MAX_REASON_CHARS - 1)}…` : s);

/**
 * The breaker a child on this model could be judged by, or null when no
 * breaker reflects its route (CLI, LiteLLM, unknown provider).
 */
export function breakerKeyFor(target: AvailabilityTarget): string | null {
  const extName = [target.name, target.modelId].find((n): n is string => !!n && isExtensionModelName(n));
  if (extName) {
    const route = getExtensionRoute(extName);
    if (route) return route.providerKey;
  }
  if (!target.provider || target.provider === 'litellm' || isCLIProvider(target.provider)) return null;
  return target.provider;
}

/** Cheap, cached, never throws. Reasons name no paths or credentials. */
export async function checkModelAvailability(target: AvailabilityTarget): Promise<ModelAvailability> {
  try {
    const tool = getCLIToolConfig(target.modelId);
    const cli = target.provider ? isCLIProvider(target.provider) : !!tool;
    if (cli) {
      if (tool && !(await cliToolAvailable(tool))) return { available: false, reason: `CLI '${tool.binaryPath}' not installed` };
      return { available: true };
    }
    const key = breakerKeyFor(target);
    if (key) {
      // `getAllStatuses`, not `getStatus`: the latter creates a breaker for a
      // provider that has never been called.
      const status = getCircuitBreakerRegistry().getAllStatuses().find((s) => s.provider === key);
      if (status?.state === 'open') {
        const since = status.openedAt ? new Date(status.openedAt).toISOString() : 'recently';
        const retry = status.nextRetryAt ? `, retry after ${new Date(status.nextRetryAt).toISOString()}` : '';
        return { available: false, reason: cap(`circuit breaker for '${key}' open since ${since}${retry}`) };
      }
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
 * The `routePolicy.primaryModel` denial. Names what the route IS — the lane's
 * primary, or for a planned child the executor it runs on — so the agent can
 * repeat the right name or drop the field instead of guessing. It still cannot
 * pick a model: the only value that passes is the binding.
 */
export function routeMismatchMessage(input: {
  requested: string;
  lane: string;
  /** What the child resolved to (the executor for a planned child). */
  resolved: { modelId: string; name: string };
  /** Set when `resolved` is the lane's executorModel: the lane's primary, if any. */
  executorOf?: { primary: { modelId: string; name: string } | null };
}): string {
  const bound = input.executorOf
    ? `Planned children of the '${input.lane}' lane run on its executor '${describeModel(input.resolved)}' (primary '${describeModel(input.executorOf.primary)}')`
    : `The '${input.lane}' lane is bound to '${describeModel(input.resolved)}'`;
  return cap(`Requested primaryModel '${input.requested}' does not match the configured route. No child was started. ` +
    `${bound}; pass that, omit routePolicy.primaryModel, or ask the user to change the binding.`);
}

export type PreSpawnRoute =
  | { route: 'primary' }
  | { route: 'backup'; modelId: string; modelName: string; provider?: string | null; reason: string }
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
  const primary = await checkModelAvailability(input.primary);
  if (primary.available) return { route: 'primary' };
  const label = `lane '${input.lane}' model ${describeModel(input.primary)} unavailable: ${primary.reason}`;
  if (!input.allowBackup) return { route: 'deny', reason: cap(`${label}; backup disabled by routePolicy`) };
  const backup = await input.resolveBackup().catch(() => null);
  if (!backup || (backup.modelId === input.primary.modelId && (!backup.name || backup.name === input.primary.name))) {
    return { route: 'deny', reason: cap(`${label}; no backup bound`) };
  }
  const backupCheck = await checkModelAvailability(backup);
  if (!backupCheck.available) {
    return { route: 'deny', reason: cap(`${label}; backup ${describeModel(backup)} also unavailable: ${backupCheck.reason}`) };
  }
  return { route: 'backup', modelId: backup.modelId, modelName: backup.name, provider: backup.provider, reason: cap(label) };
}
