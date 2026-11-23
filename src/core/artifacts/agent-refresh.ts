/**
 * Agent refresh of a live artifact (docs/ARTIFACTS.md#agent-refresh): the
 * owner's stored instruction re-run by an agent, as the owner, to regenerate
 * the page — on demand by the owner, or on an owner-set schedule.
 *
 * - **Who.** Only the artifact's owner starts one (the REST route checks it;
 *   viewers and embed tokens have no route to it). The run uses the owner's
 *   permissions, workspace and spend budget, never a viewer's.
 * - **One at a time.** `claimRun` is a conditional update: a second request
 *   while one runs is `busy`, across processes too.
 * - **Atomic.** The new version becomes current only when the run succeeded,
 *   returned a valid page, its script built, and the page was not edited,
 *   restored or deleted meanwhile; otherwise the current version stays and
 *   the attempt is recorded as failed.
 * - **Refused is recorded.** A spend budget, quota or concurrency refusal,
 *   a disabled owner or a shared space ends the attempt as `refused` with the
 *   reason, visible to the owner; nothing is written to the artifact.
 * - **Schedule.** One-shot tasks on the shared Scheduler (`getScheduler`),
 *   each re-arming the next under the row's `scheduleChain`; changing or
 *   stopping the schedule mints or clears the chain, so a queued task of an
 *   old chain ends without running. Failures back off (doubling the interval,
 *   at most a day) and, after {@link MAX_SCHEDULE_FAILURES} in a row, the
 *   schedule turns itself off and the owner is notified. A deleted or
 *   expired artifact, or a disabled owner, stops it.
 */
import { isJobOn } from '@/core/modules/registry';
import { getScheduler, type ScheduledTask } from '@/core/scheduler';
import { isConcurrencyLimitError } from '@/core/errors/concurrency-limit';
import { limitKindOf } from '@/core/errors/limit-refusal';
import { artifactRefreshRepository as repo } from '@/db/repositories/artifact-refresh-repository';
import { artifactsRepository } from '@/db/repositories/artifacts-repository';
import type { AgentRefreshOutcome, ArtifactAgentRefresh } from '@/db/schema/artifact-agent-refresh';
import type { Artifact } from '@/db/schema/artifacts';
import type { AgentRefreshView } from '@/shared/artifacts';
import { generateId } from '@/utils/crypto';
import { coreLogger } from '@/utils/logger';
import { buildAndStoreBundle } from './bundler';
import { parseRefreshDeliverable, type RefreshDeliverable, type RefreshRunner, runRefreshAgent } from './agent-refresh-runner';
import { extractInteractiveScript } from './render';
import { announceVersion } from './version-writer';

export const AGENT_REFRESH_TASK = 'artifact:agent-refresh';
/** Longest one refresh run may take; the worker is stopped after it. */
export const MAX_REFRESH_RUNTIME_MS = 10 * 60_000;
/** A claim older than this belongs to a run whose process died; a new run may take it. */
export const REFRESH_CLAIM_STALE_MS = MAX_REFRESH_RUNTIME_MS + 5 * 60_000;
/** Scheduled attempts in a row that fail (or are refused) before the schedule turns itself off. */
export const MAX_SCHEDULE_FAILURES = 5;
/** Longest back-off between failing scheduled attempts. */
export const MAX_SCHEDULE_BACKOFF_MS = 24 * 60 * 60_000;

export interface AgentRefreshDeps {
  run: RefreshRunner;
  /** Throws the owner's spend-budget refusal (SpendBudgetExceededError) when a budget is paused. */
  checkBudget: (ownerUserId: string, workspaceId: string) => Promise<void>;
  notify: (userId: string, type: string, title: string, body: string, metadata: Record<string, unknown>) => Promise<void>;
  /** Max runtime of a run (ms). */
  maxRuntimeMs: number;
}

const defaultDeps: AgentRefreshDeps = {
  run: runRefreshAgent,
  checkBudget: async (userId, workspaceId) => {
    const { checkSpend } = await import('@/security/spend-budgets');
    await checkSpend({ userId, workspaceId, role: 'research', funding: 'own', spaceId: null });
  },
  notify: async (...args) => {
    const { getNotificationService } = await import('@/core/notification-service');
    await getNotificationService().notify(...args);
  },
  maxRuntimeMs: MAX_REFRESH_RUNTIME_MS,
};

function withDeps(overrides?: Partial<AgentRefreshDeps>): AgentRefreshDeps {
  return { ...defaultDeps, ...overrides };
}

export interface AgentRefreshResult {
  outcome: AgentRefreshOutcome;
  error: string | null;
  versionId?: string;
}

export type StartAgentRefresh =
  /** The run started; `done` settles (never rejects) when it is recorded. */
  | { status: 'started'; done: Promise<AgentRefreshResult> }
  /** Another refresh of this artifact is in flight; nothing was recorded. */
  | { status: 'busy' }
  /** Refused before any agent ran (budget, owner, space, module); recorded on the row. */
  | { status: 'refused'; error: string }
  /** Nothing to refresh: no instruction, or the artifact is gone. Not recorded. */
  | { status: 'unavailable'; error: string };

/** The owner's view of the row (REST and web app). */
export function toView(row: ArtifactAgentRefresh): AgentRefreshView {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    instruction: row.instruction,
    intervalMinutes: row.intervalMinutes,
    nextRunAt: iso(row.nextRunAt),
    scheduleDisabledReason: row.scheduleDisabledReason,
    running: row.runStartedAt !== null && Date.now() - row.runStartedAt.getTime() < REFRESH_CLAIM_STALE_MS,
    runStartedAt: iso(row.runStartedAt),
    lastAttemptAt: iso(row.lastAttemptAt),
    lastOutcome: row.lastOutcome ?? null,
    lastError: row.lastError,
    lastSuccessAt: iso(row.lastSuccessAt),
    consecutiveFailures: row.consecutiveFailures,
  };
}

/** Why a refresh of `artifact` for `row.ownerUserId` may not start now, or null. */
async function refusalOf(row: ArtifactAgentRefresh, artifact: Artifact, deps: AgentRefreshDeps): Promise<string | null> {
  if (artifact.createdByUserId !== row.ownerUserId) return 'Only the artifact\'s owner can refresh it';
  const { userRepository } = await import('@/db/repositories/user-repository');
  const owner = await userRepository.findById(row.ownerUserId);
  if (!owner?.isActive) return 'The owner\'s account is disabled';
  const { isSharedWorkspaceId } = await import('@/security/workspace-fs');
  if (await isSharedWorkspaceId(artifact.workspaceId)) {
    return 'Agent refresh runs as your personal agent, so it is not available on an artifact in a shared space';
  }
  if (!isJobOn('artifacts-refresh')) return 'Artifact refresh is turned off on this server (the artifacts module\'s refresh job)';
  try {
    await deps.checkBudget(row.ownerUserId, artifact.workspaceId);
  } catch (err) {
    if (limitKindOf(err)) return (err as Error).message;
    throw err;
  }
  return null;
}

/**
 * Start one refresh of an artifact. The claim and the pre-checks happen
 * before this returns, so a caller learns at once whether it is running,
 * busy or refused; the run itself continues in `done`.
 */
export async function startAgentRefresh(
  artifactId: string,
  trigger: 'user' | 'schedule',
  overrides?: Partial<AgentRefreshDeps>,
): Promise<StartAgentRefresh> {
  const deps = withDeps(overrides);
  const row = await repo.get(artifactId);
  if (!row) return { status: 'unavailable', error: 'This artifact has no refresh instruction' };
  const artifact = await artifactsRepository.getById(artifactId);
  if (!artifact) return { status: 'unavailable', error: 'Artifact not found' };

  const now = new Date();
  const startedAt = await repo.claimRun(artifactId, now, new Date(now.getTime() - REFRESH_CLAIM_STALE_MS));
  if (!startedAt) return { status: 'busy' };

  let refusal: string | null;
  try {
    refusal = await refusalOf(row, artifact, deps);
  } catch (err) {
    const error = `Could not check whether the refresh may run: ${(err as Error).message}`;
    await repo.finishRun(artifactId, startedAt, { outcome: 'failed', error, countsAsFailure: trigger === 'schedule' });
    coreLogger.error({ err, artifactId }, 'artifact.agent_refresh.precheck_failed');
    return { status: 'refused', error };
  }
  if (refusal) {
    await repo.finishRun(artifactId, startedAt, { outcome: 'refused', error: refusal, countsAsFailure: trigger === 'schedule' });
    coreLogger.info({ artifactId, trigger, refusal }, 'artifact.agent_refresh.refused');
    return { status: 'refused', error: refusal };
  }

  const done = runClaimed(row, artifact, trigger, startedAt, deps).catch(async (err: unknown) => {
    // Recording itself failed; release the claim so the next request can run.
    const error = `Refresh failed: ${(err as Error).message}`;
    coreLogger.error({ err, artifactId }, 'artifact.agent_refresh.crashed');
    await repo.finishRun(artifactId, startedAt, { outcome: 'failed', error, countsAsFailure: trigger === 'schedule' })
      .catch((e: unknown) => coreLogger.error({ err: e, artifactId }, 'artifact.agent_refresh.release_failed'));
    return { outcome: 'failed' as const, error };
  });
  return { status: 'started', done };
}

async function runClaimed(
  row: ArtifactAgentRefresh,
  artifact: Artifact,
  trigger: 'user' | 'schedule',
  startedAt: Date,
  deps: AgentRefreshDeps,
): Promise<AgentRefreshResult> {
  const finish = async (result: AgentRefreshResult): Promise<AgentRefreshResult> => {
    await repo.finishRun(artifact.id, startedAt, {
      outcome: result.outcome,
      error: result.error,
      countsAsFailure: trigger === 'schedule',
    });
    const log = result.outcome === 'success' ? coreLogger.info.bind(coreLogger) : coreLogger.warn.bind(coreLogger);
    log({ artifactId: artifact.id, trigger, outcome: result.outcome, error: result.error, versionId: result.versionId }, 'artifact.agent_refresh.finished');
    return result;
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), deps.maxRuntimeMs);
  let output: string;
  try {
    output = await deps.run({
      artifactId: artifact.id,
      workspaceId: artifact.workspaceId,
      ownerUserId: row.ownerUserId,
      title: artifact.title,
      instruction: row.instruction,
      trigger,
      sessionId: row.sessionId,
      signal: controller.signal,
      onSession: (sessionId) => repo.setSession(artifact.id, sessionId),
    });
  } catch (err) {
    if (controller.signal.aborted) {
      return finish({ outcome: 'failed', error: `The refresh took longer than ${Math.round(deps.maxRuntimeMs / 60_000)} minutes and was stopped` });
    }
    const refused = limitKindOf(err) !== null || isConcurrencyLimitError(err);
    return finish({ outcome: refused ? 'refused' : 'failed', error: (err as Error).message || String(err) });
  } finally {
    clearTimeout(timer);
  }
  if (controller.signal.aborted) {
    return finish({ outcome: 'failed', error: `The refresh took longer than ${Math.round(deps.maxRuntimeMs / 60_000)} minutes and was stopped` });
  }

  const parsed = parseRefreshDeliverable(output);
  if (!parsed.ok) return finish({ outcome: 'failed', error: parsed.error });

  const landed = await landVersion(artifact, parsed.page, row.ownerUserId);
  if (!landed.ok) return finish({ outcome: 'failed', error: landed.error });
  announceVersion(artifact.id, landed.versionId);
  return finish({ outcome: 'success', error: null, versionId: landed.versionId });
}

/**
 * Write the refreshed page as a new version and make it current — only if
 * its script builds and the artifact still shows the version the run started
 * from. Otherwise the new row is removed and the current version stays.
 */
async function landVersion(
  artifact: Artifact,
  page: RefreshDeliverable,
  ownerUserId: string,
): Promise<{ ok: true; versionId: string } | { ok: false; error: string }> {
  const extracted = extractInteractiveScript(page.template);
  const version = await artifactsRepository.createVersion({
    artifactId: artifact.id,
    htmlTemplate: extracted.template,
    css: page.css,
    changeSummary: 'agent refresh',
    createdByUserId: ownerUserId,
  });
  const discard = async (error: string) => {
    await artifactsRepository.deleteVersion(version.id);
    return { ok: false as const, error };
  };
  if (extracted.source.trim()) {
    try {
      await buildAndStoreBundle({ artifactId: artifact.id, versionId: version.id, source: extracted.source });
    } catch (err) {
      return discard(`The page's JavaScript did not build: ${(err as Error).message}`);
    }
  }
  if (!(await artifactsRepository.setCurrentVersionIf(artifact.id, artifact.currentVersionId, version.id))) {
    return discard('The artifact was edited, restored or deleted while the refresh ran; its current version was kept');
  }
  return { ok: true, versionId: version.id };
}

// ── schedule ─────────────────────────────────────────────────────────

interface AgentRefreshPayload {
  artifactId: string;
  chain: string;
}

async function queue(artifactId: string, chain: string, delayMs: number): Promise<void> {
  await getScheduler().schedule(
    `artifact:${artifactId}`,
    AGENT_REFRESH_TASK,
    { artifactId, chain } satisfies AgentRefreshPayload,
    // A handler that throws is not retried: the next run is the chain's job.
    { delayMs: Math.max(delayMs, 1), maxAttempts: 1 },
  );
}

/** Turn the schedule on (every `intervalMinutes`, first run one interval from now) or off (null). */
export async function setAgentRefreshSchedule(artifactId: string, intervalMinutes: number | null): Promise<void> {
  if (intervalMinutes === null) {
    await repo.setSchedule(artifactId, null, null, null);
    return;
  }
  const chain = generateId();
  const delayMs = intervalMinutes * 60_000;
  await repo.setSchedule(artifactId, intervalMinutes, chain, new Date(Date.now() + delayMs));
  await queue(artifactId, chain, delayMs);
}

/** Stop an artifact's schedule (retention expiry, deletion) and say why on the row. */
export async function stopAgentRefreshSchedule(artifactId: string, reason: string): Promise<boolean> {
  return repo.disableSchedule(artifactId, reason);
}

/** The delay before the next scheduled attempt after `failures` failed ones in a row. */
export function nextScheduleDelayMs(intervalMinutes: number, failures: number): number {
  const base = intervalMinutes * 60_000;
  if (failures <= 0) return base;
  return Math.max(base, Math.min(base * 2 ** failures, MAX_SCHEDULE_BACKOFF_MS));
}

/** Scheduler handler: one scheduled attempt, then re-arm (or stop) the chain. */
export async function handleAgentRefreshTask(task: ScheduledTask, overrides?: Partial<AgentRefreshDeps>): Promise<void> {
  const deps = withDeps(overrides);
  const { artifactId, chain } = task.payload as unknown as AgentRefreshPayload;
  const row = await repo.get(artifactId);
  if (!row || row.scheduleChain !== chain || row.intervalMinutes === null) {
    coreLogger.debug({ artifactId, chain }, 'artifact.agent_refresh.schedule_superseded');
    return;
  }
  const artifact = await artifactsRepository.getById(artifactId);
  if (!artifact) {
    await repo.disableSchedule(artifactId, 'The artifact was deleted', chain);
    coreLogger.info({ artifactId }, 'artifact.agent_refresh.schedule_stopped — artifact deleted');
    return;
  }
  const { userRepository } = await import('@/db/repositories/user-repository');
  if (!(await userRepository.findById(row.ownerUserId))?.isActive) {
    await repo.disableSchedule(artifactId, 'The owner\'s account is disabled', chain);
    coreLogger.info({ artifactId, ownerUserId: row.ownerUserId }, 'artifact.agent_refresh.schedule_stopped — owner disabled');
    return;
  }

  // Module off: no attempt, nothing recorded; the chain goes on so the
  // schedule resumes when the module is back (as source refresh does).
  if (isJobOn('artifacts-refresh')) {
    const started = await startAgentRefresh(artifactId, 'schedule', deps);
    if (started.status === 'started') await started.done;
  } else {
    coreLogger.debug({ artifactId }, 'artifact.agent_refresh.skip_module_off');
  }

  const after = await repo.get(artifactId);
  if (!after || after.scheduleChain !== chain || after.intervalMinutes === null) return;
  if (after.consecutiveFailures >= MAX_SCHEDULE_FAILURES) {
    const reason = `Stopped after ${after.consecutiveFailures} scheduled refreshes in a row did not succeed. Last error: ${after.lastError ?? 'unknown'}`;
    if (await repo.disableSchedule(artifactId, reason.slice(0, 1000), chain)) {
      coreLogger.warn({ artifactId, failures: after.consecutiveFailures }, 'artifact.agent_refresh.schedule_disabled');
      await deps.notify(
        after.ownerUserId,
        'artifact_refresh_disabled',
        `Scheduled refresh of "${artifact.title}" was turned off`,
        reason.slice(0, 280),
        { artifactId },
      ).catch((err: unknown) => coreLogger.error({ err, artifactId }, 'artifact.agent_refresh.notify_failed'));
    }
    return;
  }
  const delayMs = nextScheduleDelayMs(after.intervalMinutes, after.consecutiveFailures);
  if (await repo.setNextRun(artifactId, chain, new Date(Date.now() + delayMs))) {
    await queue(artifactId, chain, delayMs);
  }
}

export function registerAgentRefreshHandler(): void {
  getScheduler().registerHandler(AGENT_REFRESH_TASK, (task) => handleAgentRefreshTask(task));
}

/**
 * Re-arm every schedule at boot under a new chain, due at its stored next
 * run (now when that has passed). A task queued by the previous boot is then
 * of an old chain and ends without running, so a restart never doubles a
 * schedule, and one queued in memory that the restart lost is replaced.
 */
export async function bootstrapAgentRefreshSchedules(): Promise<number> {
  let armed = 0;
  for (const row of await repo.listScheduled()) {
    if (!row.scheduleChain || row.intervalMinutes === null) continue;
    const chain = generateId();
    if (!(await repo.rechain(row.artifactId, row.scheduleChain, chain))) continue;
    const due = row.nextRunAt ? row.nextRunAt.getTime() - Date.now() : row.intervalMinutes * 60_000;
    await queue(row.artifactId, chain, Math.max(due, 0));
    armed++;
  }
  if (armed > 0) coreLogger.info({ armed }, 'artifact.agent_refresh.schedules_armed');
  return armed;
}
