/**
 * `agent:run` of the plugin host API (docs/PLUGIN-PACKAGES.md#host-api): a
 * package starts a background agent run as the calling user, with a prompt
 * and a role, and reads its status and result by its id.
 *
 * Work that outlives a call's 30-second token never gets a longer token. The
 * run is the host's own: a worker of the role (`spawnWorker`, as a role
 * heartbeat runs one) in a session of its own, owned by the user, unattended
 * (an ASK is refused, nothing is asked of anyone), under the user's own
 * permission rules, budgets and protection routing. The package holds only
 * the run id; what it gets back is the run's status and final text.
 *
 * What bounds a run:
 *
 * - **Who and where.** Only a call the user started holds the scope (as every
 *   scope); starting needs a `write` or `external` tool (the page asks the
 *   user first). Personal workspaces only: a run in a space is refused
 *   (`409 space`). The role is one of the host's (not `general`, the root),
 *   and its tools are narrowed to `PLUGIN_RUN_TOOL_IDS`: search, fetch and
 *   read, never a shell, a message, a mail or another plugin.
 * - **Cost.** At most `RUNS_PER_HOUR` starts an hour (a burst of
 *   `RUN_BURST`) and `MAX_RUNS_IN_FLIGHT` running per package and user;
 *   `plugins.hostAgentRunTokens` tokens a run (the worker's own budget; 0
 *   turns `agent:run` off); its tokens count in the same per-user daily
 *   allowance as `model:complete` (`plugins.hostModelDailyTokens`, checked
 *   before the start with the whole run budget); the user's spend budgets
 *   are checked before it starts, and by the agent's own model calls as it runs.
 * - **Time.** `RUN_TIMEOUT_MS`, then the worker is stopped. Disabling,
 *   upgrading or uninstalling the package, or changing its approval, stops its
 *   runs (`revokePluginTokens`). A restart marks a running row `interrupted`
 *   (the boot sweep); a run does not resume.
 * - **No tokens inside.** A tool call made inside the run gets no host token
 *   (`isPluginRunSession`): nobody started that call by hand.
 * - **Protection.** The run's session raises its level as its agent reads, and
 *   its model calls are routed by it like any turn's. A result above the
 *   package's `maxProtection` is withheld (`withheld`), and a result handed
 *   over raises the calling session's level.
 *
 * The run is a `background_jobs` row (`kind: 'agent'`), payload `{ plugin,
 * tool, role, sessionId }`, read back only by the same package for the same
 * user.
 */
import { checkRateLimit } from '@/core/artifacts/rate-limit';
import { raiseSessionLevel } from '@/core/protection/session-level';
import { backgroundJobRepository } from '@/db/repositories/background-job-repository';
import type { BackgroundJob } from '@/db/schema/background-jobs';
import type { Principal } from '@/security/principal';
import { coreLogger } from '@/utils/logger';
import { type HostTokenGrant, noteHostRead, stopPluginRun, trackPluginRun, untrackPluginRun } from './host-api';
import { estimateTokens, PLUGIN_RUN_CHANNEL, pluginTokensToday } from './host-model';

/** The role a run gets when the package names none. */
export const DEFAULT_RUN_ROLE = 'research';
/**
 * The tool groups a run's worker may hold, whatever its role has: searching
 * and fetching the web, the user's knowledge and documents, its own task
 * state and artifacts. Never a shell, a messaging or mail tool, git, the
 * filesystem or MCP (another plugin).
 */
export const PLUGIN_RUN_TOOL_IDS: readonly string[] = ['websearch', 'knowledge', 'documents', 'task_state', 'artifacts', 'artifacts_toolbox', 'profiles'];
/** Starts per package and user: a burst of `RUN_BURST`, refilled at `RUNS_PER_HOUR`. */
export const RUN_BURST = 3;
export const RUNS_PER_HOUR = 6;
/** Runs of one package for one user running at once. */
export const MAX_RUNS_IN_FLIGHT = 2;
/** How long a run may take before its worker is stopped. */
export const RUN_TIMEOUT_MS = 20 * 60_000;
/** The most characters of a run's final text that are kept and handed back. */
export const MAX_RUN_OUTPUT_CHARS = 100_000;
/** The longest prompt a package may start a run with. */
export const MAX_RUN_PROMPT_CHARS = 20_000;
/** The default of `plugins.hostAgentRunTokens`. */
export const DEFAULT_RUN_TOKENS = 150_000;

export interface HostAgentRunRequest {
  prompt: string;
  role?: string;
  /** What a person would call the run (shown with the job); default: the prompt's start. */
  title?: string;
}

/** A run as the package reads it. */
export interface HostAgentRunView {
  id: string;
  status: 'running' | 'done' | 'error' | 'interrupted';
  role: string;
  title: string;
  stage: string | null;
  /** The worker's final text, when done (cut at MAX_RUN_OUTPUT_CHARS); null when withheld or not done. */
  output: string | null;
  /** The output is above the package's maxProtection, so it is not handed over. */
  withheld?: { protectionLevel: number };
  error: string | null;
  tokens: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export type HostAgentOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; error: string; retryAfter?: number };

interface RunPayload { plugin: string; tool: string; role: string; sessionId: string }
interface RunResult { output?: string; tokens?: number; protectionLevel?: number; truncated?: boolean }

/** Runs in this process, by package and user (they do not survive it). */
const inFlight = new Map<string, number>();
const flightKey = (plugin: string, userId: string) => `${plugin}\n${userId}`;

/** The configured per-run token budget (0: `agent:run` is off). */
export async function runTokenBudget(): Promise<number> {
  const { getConfig } = await import('@/config');
  return getConfig().plugins?.hostAgentRunTokens ?? DEFAULT_RUN_TOKENS;
}

/** The tool groups `role`'s worker gets in a run: the role's own, narrowed to PLUGIN_RUN_TOOL_IDS. */
export async function runToolIds(role: string): Promise<string[] | null> {
  const { ROLE_CONFIGS } = await import('@/core/agent/roles');
  if (role === 'general' || !Object.hasOwn(ROLE_CONFIGS, role)) return null;
  const allowed = new Set(PLUGIN_RUN_TOOL_IDS);
  return (ROLE_CONFIGS[role as keyof typeof ROLE_CONFIGS].toolIds ?? []).filter((id) => allowed.has(id));
}

/** Start a run (`POST /api/plugin-host/agent/runs`). */
export async function startPluginAgentRun(
  grant: HostTokenGrant, principal: Principal, req: HostAgentRunRequest,
): Promise<HostAgentOutcome<{ id: string; status: 'running'; role: string }>> {
  if (grant.effect !== 'write' && grant.effect !== 'external') {
    return { ok: false, status: 403, code: 'read_tool', error: 'A read tool may read a run; starting one needs a tool whose effect is write or external' };
  }
  // A run is someone's own work: spaces have their own funding and audience rules, not offered here yet.
  if (principal.workspaceKind === 'shared') {
    return { ok: false, status: 409, code: 'space', error: 'Background runs start in personal workspaces only' };
  }
  const role = req.role ?? DEFAULT_RUN_ROLE;
  const toolIds = await runToolIds(role);
  if (!toolIds) return { ok: false, status: 400, code: 'role', error: `Unknown role "${role}" (any role but general)` };
  if (toolIds.length === 0) return { ok: false, status: 400, code: 'role', error: `The role "${role}" has none of the tools a background run may hold (${PLUGIN_RUN_TOOL_IDS.join(', ')})` };

  const budget = await runTokenBudget();
  if (budget <= 0) return { ok: false, status: 403, code: 'agent_off', error: 'Plugin background runs are turned off on this install (plugins.hostAgentRunTokens is 0)' };

  const key = flightKey(grant.plugin, grant.userId);
  if ((inFlight.get(key) ?? 0) >= MAX_RUNS_IN_FLIGHT) {
    return { ok: false, status: 429, code: 'too_many_runs', error: `At most ${MAX_RUNS_IN_FLIGHT} background runs of a plugin at once`, retryAfter: 60 };
  }
  const limited = checkRateLimit(`plugin-host-agent:${grant.plugin}:${grant.userId}`, { capacity: RUN_BURST, refillPerSecond: RUNS_PER_HOUR / 3600 });
  if (!limited.allowed) {
    return { ok: false, status: 429, code: 'rate_limited', error: `At most ${RUNS_PER_HOUR} background runs an hour per plugin`, retryAfter: limited.retryAfterSeconds ?? 600 };
  }

  const { getConfig } = await import('@/config');
  const cap = getConfig().plugins?.hostModelDailyTokens ?? 200_000;
  if (cap <= 0) return { ok: false, status: 403, code: 'model_off', error: 'Plugin model calls are turned off on this install (plugins.hostModelDailyTokens is 0)' };
  const used = await pluginTokensToday(grant.userId);
  // The whole run budget is reserved against today's allowance, as model:complete reserves its estimate.
  if (used + Math.max(budget, estimateTokens({ prompt: req.prompt })) > cap) {
    return { ok: false, status: 429, code: 'token_cap', error: `Today's plugin model allowance is too low for a run (${used} of ${cap} tokens used, a run may take ${budget}); it resets at midnight UTC` };
  }
  try {
    const { checkSpend } = await import('@/security/spend-budgets');
    await checkSpend({ userId: grant.userId, workspaceId: principal.workspaceId ?? null, sessionId: grant.sessionId, funding: 'own', spaceId: null });
  } catch (err) {
    if ((err as Error).name === 'SpendBudgetExceededError') return { ok: false, status: 429, code: 'spend_budget', error: (err as Error).message };
    throw err;
  }

  const title = (req.title?.trim() || req.prompt.trim().replace(/\s+/g, ' ')).slice(0, 200);
  const sessionId = globalThis.crypto.randomUUID();
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  const session = await sessionRepository.createAutomation({
    id: sessionId, userId: grant.userId, workspaceId: principal.workspaceId ?? null,
    channelType: PLUGIN_RUN_CHANNEL, channelId: grant.plugin, title: `${grant.plugin}: ${title}`,
  });
  const row = await backgroundJobRepository.create({
    kind: 'agent', userId: grant.userId, workspaceId: principal.workspaceId ?? null, title, status: 'running',
    payload: { plugin: grant.plugin, tool: grant.tool, role, sessionId } satisfies RunPayload,
  });
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
  void runInBackground(row.id, grant, { session, role, toolIds, prompt: req.prompt, budget })
    .finally(() => {
      const n = (inFlight.get(key) ?? 1) - 1;
      if (n > 0) inFlight.set(key, n);
      else inFlight.delete(key);
    });
  coreLogger.info({ plugin: grant.plugin, tool: grant.tool, jobId: row.id, role }, 'plugin-host: background run started');
  return { ok: true, value: { id: row.id, status: 'running', role } };
}


async function runInBackground(
  jobId: string,
  grant: HostTokenGrant,
  run: { session: { id: string; userId: string; workspaceId: string | null }; role: string; toolIds: string[]; prompt: string; budget: number },
): Promise<void> {
  const sessionId = run.session.id;
  let workerId: string | undefined;
  let stopped: string | null = null;
  const { getAgentManager } = await import('@/core/agent-manager');
  const stop = (reason: string) => {
    stopped ??= reason;
    if (workerId) getAgentManager().stop(workerId, { cascade: true });
  };
  trackPluginRun(jobId, { plugin: grant.plugin, userId: grant.userId, sessionId, stop });
  const timer = setTimeout(() => stop(`The run took longer than ${Math.round(RUN_TIMEOUT_MS / 60_000)} minutes and was stopped`), RUN_TIMEOUT_MS);
  timer.unref?.();
  let tokens = 0;
  try {
    const { buildAgentContext, resolveAgentScope, withAgentUsage } = await import('@/core/agent/context');
    const scope = await resolveAgentScope({ session: run.session, userId: grant.userId, trigger: 'user' });
    const { ROLE_CONFIGS } = await import('@/core/agent/roles');
    const parent = buildAgentContext({
      id: `plugin-run:${grant.plugin}:${jobId}`, sessionId, userId: grant.userId, scope,
      topic: ROLE_CONFIGS[run.role as keyof typeof ROLE_CONFIGS]?.defaultTopic ?? run.role,
      model: '', role: run.role, root: false, attended: false, status: 'running',
    });
    await backgroundJobRepository.progress(jobId, { stage: 'working' });
    const { getAgentService } = await import('@/core/agent');
    const result = await withAgentUsage(grant.userId, scope, () => getAgentService().spawnWorker(run.role, run.prompt, '', parent, {
      toolIds: run.toolIds,
      // The approved list is the whole set: no test-container tools join it.
      exactTools: true,
      maxTokenBudget: run.budget,
      onTokens: (n: number) => { tokens += n; },
      onWorkerSpawned: (id: string) => { workerId = id; if (stopped) stop(stopped); },
    }));
    if (stopped) throw new Error(stopped);
    if (result && typeof result === 'object' && 'error' in result) throw new Error(String((result as { error: unknown }).error));
    const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
    const { sessionProtectionLevel } = await import('@/core/protection/session-level');
    const out: RunResult = {
      output: text.slice(0, MAX_RUN_OUTPUT_CHARS), tokens, protectionLevel: sessionProtectionLevel(sessionId),
      ...(text.length > MAX_RUN_OUTPUT_CHARS ? { truncated: true } : {}),
    };
    await backgroundJobRepository.finish(jobId, { status: 'done', stage: 'done', result: out as Record<string, unknown> });
    coreLogger.info({ plugin: grant.plugin, jobId, tokens }, 'plugin-host: background run finished');
  } catch (err) {
    const message = stopped ?? (err as Error).message;
    coreLogger.warn({ plugin: grant.plugin, jobId, err: (err as Error).message }, 'plugin-host: background run failed');
    await backgroundJobRepository.finish(jobId, { status: 'error', error: message.slice(0, 1000), result: { tokens } })
      .catch((e: unknown) => coreLogger.error({ jobId, err: (e as Error).message }, 'plugin-host: could not record a run\'s failure'));
  } finally {
    clearTimeout(timer);
    untrackPluginRun(jobId);
  }
}

/** A run of this package for this user, or null (another's, another package's, not a run). */
async function runRow(grant: HostTokenGrant, id: string): Promise<(BackgroundJob & { payload: RunPayload }) | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const row = await backgroundJobRepository.findById(id);
  if (!row || row.kind !== 'agent' || row.userId !== grant.userId) return null;
  const payload = row.payload as unknown as RunPayload;
  return payload.plugin === grant.plugin ? row as BackgroundJob & { payload: RunPayload } : null;
}

/** Read a run (`GET /api/plugin-host/agent/runs/:id`). */
export async function readPluginAgentRun(grant: HostTokenGrant, id: string): Promise<HostAgentOutcome<HostAgentRunView>> {
  const row = await runRow(grant, id);
  if (!row) return { ok: false, status: 404, code: 'not_found', error: 'Run not found' };
  const result = (row.result ?? {}) as RunResult;
  const status: HostAgentRunView['status'] = row.status === 'done' ? 'done'
    : row.status === 'interrupted' ? 'interrupted'
      : row.status === 'error' || row.status === 'cancelled' ? 'error' : 'running';
  let output: string | null = null;
  let withheld: HostAgentRunView['withheld'];
  if (status === 'done') {
    // No level recorded counts as unclear (4).
    const level = typeof result.protectionLevel === 'number' ? result.protectionLevel : 4;
    if (level > grant.maxProtection) {
      withheld = { protectionLevel: level };
    } else {
      output = result.output ?? '';
      await noteHostRead(grant, level);
      if (grant.sessionId) raiseSessionLevel(grant.sessionId, level);
    }
  }
  return {
    ok: true,
    value: {
      id: row.id, status, role: row.payload.role, title: row.title, stage: row.stage ?? null, output,
      ...(withheld ? { withheld } : {}),
      error: row.error ?? null, tokens: typeof result.tokens === 'number' ? result.tokens : null,
      startedAt: (row.startedAt ?? row.createdAt).toISOString(), finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    },
  };
}

/**
 * Cancel a running background run: its worker is stopped (when it runs in
 * this process) and the row is closed as `cancelled`, so a worker elsewhere
 * cannot report it done. Only the same package for the same user (the host
 * API), or that user or an admin from the app (`cancelRunFromApp`). Reads as
 * `error` with "Cancelled …" to the package afterwards.
 */
async function cancelRow(row: BackgroundJob, reason: string): Promise<HostAgentOutcome<{ id: string; status: 'cancelled' }>> {
  if (row.status !== 'running' && row.status !== 'queued') return { ok: false, status: 409, code: 'not_running', error: `The run is ${row.status}, not running` };
  const stoppedHere = stopPluginRun(row.id, reason);
  await backgroundJobRepository.finish(row.id, { status: 'cancelled', error: reason });
  coreLogger.info({ jobId: row.id, stoppedHere }, 'plugin-host: background run cancelled');
  return { ok: true, value: { id: row.id, status: 'cancelled' } };
}

/** Cancel a run (`DELETE /api/plugin-host/agent/runs/:id`): this package's, for this user only. */
export async function cancelPluginAgentRun(grant: HostTokenGrant, id: string): Promise<HostAgentOutcome<{ id: string; status: 'cancelled' }>> {
  const row = await runRow(grant, id);
  if (!row) return { ok: false, status: 404, code: 'not_found', error: 'Run not found' };
  return cancelRow(row, `Cancelled by ${grant.plugin}`);
}

/**
 * Cancel a run of `plugin` from the app (`DELETE /api/plugin-packages/:name/runs/:id`):
 * the user who started it, or an admin. Anyone else, another package's run,
 * or not a run: not found.
 */
export async function cancelRunFromApp(plugin: string, id: string, actor: { userId: string; isAdmin: boolean }): Promise<HostAgentOutcome<{ id: string; status: 'cancelled'; userId: string }>> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, status: 404, code: 'not_found', error: 'Run not found' };
  const row = await backgroundJobRepository.findById(id);
  const payload = row?.payload as unknown as RunPayload | undefined;
  if (!row || row.kind !== 'agent' || payload?.plugin !== plugin || (!actor.isAdmin && row.userId !== actor.userId)) {
    return { ok: false, status: 404, code: 'not_found', error: 'Run not found' };
  }
  const outcome = await cancelRow(row, actor.userId === row.userId ? 'Cancelled by the user' : 'Cancelled by an admin');
  return outcome.ok ? { ok: true, value: { ...outcome.value, userId: row.userId } } : outcome;
}

/** A running background run of a package, as the app lists it (`GET /api/plugin-packages/:name/runs`). */
export interface PluginRunListItem {
  id: string;
  userId: string;
  startedAt: string;
  role: string;
  title: string;
}

/**
 * The running (or queued) background runs of `plugin`: every user's, or one
 * user's with `userId`. Ids, the role and the title only, never the prompt or
 * any output.
 */
export async function listRunningRuns(plugin: string, userId?: string): Promise<PluginRunListItem[]> {
  const rows = await backgroundJobRepository.runningForPlugin(plugin, userId);
  return rows.map((r) => ({
    id: r.id, userId: r.userId, startedAt: (r.startedAt ?? r.createdAt).toISOString(),
    role: typeof r.payload.role === 'string' ? r.payload.role : DEFAULT_RUN_ROLE, title: r.title,
  }));
}
