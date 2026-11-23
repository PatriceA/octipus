/**
 * Agent refresh of a live artifact (docs/ARTIFACTS.md#agent-refresh): the
 * owner's stored instruction re-run by an agent, as the owner, to regenerate
 * the page — on demand by the owner, or on an owner-set schedule.
 *
 * - **Who.** Only the artifact's owner starts one (the REST route checks it;
 *   viewers and embed tokens have no route to it). The run uses the owner's
 *   permissions, workspace and spend budget, never a viewer's.
 * - **One at a time.** `claimRun` is a conditional update: a second request
 *   while one runs is `busy`, across processes too. At most
 *   {@link MAX_CONCURRENT_AGENT_REFRESHES} run at once in a process.
 * - **Atomic.** The new version becomes current only when the run succeeded,
 *   returned a valid page, its script built, and the page was not edited,
 *   restored or deleted meanwhile; otherwise the current version stays and
 *   the attempt is recorded as failed. An identical page writes no version;
 *   refresh versions beyond {@link KEEP_REFRESH_VERSIONS} are pruned.
 * - **Refused is recorded.** A spend budget, quota or concurrency refusal,
 *   a disabled owner or a shared space ends the attempt as `refused` with the
 *   reason, visible to the owner; nothing is written to the artifact.
 * - **Schedule.** One-shot tasks on the shared Scheduler (`getScheduler`),
 *   each re-arming the next under the row's `scheduleChain`; changing or
 *   stopping the schedule mints or clears the chain, so a queued task of an
 *   old chain ends without running. A task only starts the run: the next is
 *   queued when the run settles, so no scheduler worker waits on an agent.
 *   Failures back off; after {@link MAX_SCHEDULE_FAILURES} in a row the
 *   schedule turns itself off and the owner is notified. A deleted or expired
 *   artifact, a disabled owner, or an artifact nobody opens stops it.
 */
import { createHash, randomUUID } from 'node:crypto';
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
import { resolveArtifactRetention } from './settings';
import { announceVersion } from './version-writer';

export const AGENT_REFRESH_TASK = 'artifact:agent-refresh';
/** Longest one refresh run may take; the worker is stopped after it. */
export const MAX_REFRESH_RUNTIME_MS = 10 * 60_000;
/** A claim older than this belongs to a run whose process died; a new run may take it. */
export const REFRESH_CLAIM_STALE_MS = MAX_REFRESH_RUNTIME_MS + 5 * 60_000;
/** Scheduled attempts in a row that fail (or are refused) before the schedule turns itself off. */
export const MAX_SCHEDULE_FAILURES = 5;
/** Longest back-off between failing scheduled attempts, unless the interval itself is longer. */
export const MAX_SCHEDULE_BACKOFF_MS = 24 * 60 * 60_000;
/** Agent refreshes running at once in this process; more wait (scheduled) or are turned away (manual). */
export const MAX_CONCURRENT_AGENT_REFRESHES = 3;
/** A scheduled attempt that found no free slot tries again after this (plus jitter). */
export const CAPACITY_RETRY_MS = 5 * 60_000;
/** Spread of the boot re-arm, so a restart does not start every overdue schedule at once. */
export const BOOT_JITTER_MS = 10 * 60_000;
/** Without a retention policy, a schedule pauses after this many days nobody opened the artifact. */
export const DEFAULT_IDLE_DAYS = 30;
/** Versions written by agent refreshes kept per artifact; older ones are deleted (never the current one). */
export const KEEP_REFRESH_VERSIONS = 5;
/** `schemaJson` of a version an agent refresh wrote: what pruning recognises. */
export const REFRESH_VERSION_MARKER = '{"origin":"agent-refresh"}';

const DAY_MS = 24 * 60 * 60_000;

export interface AgentRefreshDeps {
  run: RefreshRunner;
  /** Throws the owner's spend-budget refusal (SpendBudgetExceededError) when a budget is paused. */
  checkBudget: (ownerUserId: string, workspaceId: string) => Promise<void>;
  notify: (userId: string, type: string, title: string, body: string, metadata: Record<string, unknown>) => Promise<void>;
  /** Max runtime of a run (ms). */
  maxRuntimeMs: number;
  /** Max agent refreshes running at once in this process. */
  maxConcurrent: number;
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
  maxConcurrent: MAX_CONCURRENT_AGENT_REFRESHES,
};

function withDeps(overrides?: Partial<AgentRefreshDeps>): AgentRefreshDeps {
  return { ...defaultDeps, ...overrides };
}

/** Agent refreshes running in this process. */
let activeRuns = 0;

export interface AgentRefreshResult {
  outcome: AgentRefreshOutcome;
  error: string | null;
  versionId?: string;
  /** The page equalled the current one: no version was written. */
  unchanged?: boolean;
}

export type StartAgentRefresh =
  /** The run started; `done` settles (never rejects) when it is recorded. */
  | { status: 'started'; done: Promise<AgentRefreshResult> }
  /** Another refresh of this artifact is in flight; nothing was recorded. */
  | { status: 'busy' }
  /** This process already runs its maximum of agent refreshes; nothing was recorded. */
  | { status: 'capacity' }
  /** Refused before any agent ran (budget, owner, space, module); recorded on the row. */
  | { status: 'refused'; error: string }
  /** Nothing to refresh: no instruction, or the artifact is gone. Not recorded. */
  | { status: 'unavailable'; error: string };

/** The owner's view of the row (REST and web app). */
export function toView(row: ArtifactAgentRefresh): AgentRefreshView {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    instruction: row.instruction,
    instructionSetBy: row.instructionSetBy,
    knowledgeAccess: row.knowledgeAccess,
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
 * A version a run inserted but never made current or removed (its process
 * died between the two): removed now, under this run's claim.
 */
async function removeOrphanVersion(row: ArtifactAgentRefresh, artifact: Artifact): Promise<void> {
  if (!row.pendingVersionId) return;
  if (row.pendingVersionId !== artifact.currentVersionId) {
    await artifactsRepository.deleteVersion(row.pendingVersionId);
    coreLogger.info({ artifactId: artifact.id, versionId: row.pendingVersionId }, 'artifact.agent_refresh.orphan_version_removed');
  }
  await repo.setPendingVersion(artifact.id, null);
}

/**
 * Start one refresh of an artifact. The claim and the pre-checks happen
 * before this returns, so a caller learns at once whether it is running,
 * busy, over capacity or refused; the run itself continues in `done`.
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
  if (activeRuns >= deps.maxConcurrent) return { status: 'capacity' };

  activeRuns++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeRuns--;
  };
  try {
    const now = new Date();
    const startedAt = await repo.claimRun(artifactId, now, new Date(now.getTime() - REFRESH_CLAIM_STALE_MS));
    if (!startedAt) {
      release();
      return { status: 'busy' };
    }
    const countsAsFailure = trigger === 'schedule';

    let refusal: string | null;
    try {
      await removeOrphanVersion(row, artifact);
      refusal = await refusalOf(row, artifact, deps);
    } catch (err) {
      const error = `Could not check whether the refresh may run: ${(err as Error).message}`;
      coreLogger.error({ err, artifactId }, 'artifact.agent_refresh.precheck_failed');
      await repo.finishRun(artifactId, startedAt, { outcome: 'failed', error, countsAsFailure });
      release();
      return { status: 'refused', error };
    }
    if (refusal) {
      await repo.finishRun(artifactId, startedAt, { outcome: 'refused', error: refusal, countsAsFailure });
      coreLogger.info({ artifactId, trigger, refusal }, 'artifact.agent_refresh.refused');
      release();
      return { status: 'refused', error: refusal };
    }

    const done = runClaimed(row, artifact, trigger, startedAt, deps)
      .catch(async (err: unknown) => {
        // Recording itself failed; release the claim so the next request can run.
        const error = `Refresh failed: ${(err as Error).message}`;
        coreLogger.error({ err, artifactId }, 'artifact.agent_refresh.crashed');
        await repo.finishRun(artifactId, startedAt, { outcome: 'failed', error, countsAsFailure })
          .catch((e: unknown) => coreLogger.error({ err: e, artifactId }, 'artifact.agent_refresh.release_failed'));
        return { outcome: 'failed' as const, error };
      })
      .finally(release);
    return { status: 'started', done };
  } catch (err) {
    release();
    throw err;
  }
}

async function runClaimed(
  row: ArtifactAgentRefresh,
  artifact: Artifact,
  trigger: 'user' | 'schedule',
  startedAt: Date,
  deps: AgentRefreshDeps,
): Promise<AgentRefreshResult> {
  const finish = async (result: AgentRefreshResult, landed?: { pageHash: string; versionId: string }): Promise<AgentRefreshResult> => {
    await repo.finishRun(artifact.id, startedAt, {
      outcome: result.outcome,
      error: result.error,
      countsAsFailure: trigger === 'schedule',
      ...(landed ? { landed } : {}),
    });
    const log = result.outcome === 'success' ? coreLogger.info.bind(coreLogger) : coreLogger.warn.bind(coreLogger);
    log({ artifactId: artifact.id, trigger, outcome: result.outcome, error: result.error, versionId: result.versionId, unchanged: result.unchanged }, 'artifact.agent_refresh.finished');
    return result;
  };
  const timedOut = () => finish({ outcome: 'failed', error: `The refresh took longer than ${Math.round(deps.maxRuntimeMs / 60_000)} minutes and was stopped` });

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
      knowledgeAccess: row.knowledgeAccess,
      trigger,
      sessionId: row.sessionId,
      signal: controller.signal,
      onSession: (sessionId) => repo.setSession(artifact.id, sessionId),
    });
  } catch (err) {
    if (controller.signal.aborted) return timedOut();
    const refused = limitKindOf(err) !== null || isConcurrencyLimitError(err);
    return finish({ outcome: refused ? 'refused' : 'failed', error: (err as Error).message || String(err) });
  } finally {
    clearTimeout(timer);
  }
  if (controller.signal.aborted) return timedOut();

  const parsed = parseRefreshDeliverable(output);
  if (!parsed.ok) return finish({ outcome: 'failed', error: parsed.error });

  const landed = await landVersion(row, artifact, parsed.page);
  if (!landed.ok) return finish({ outcome: 'failed', error: landed.error });
  if (landed.unchanged) return finish({ outcome: 'success', error: null, versionId: landed.versionId, unchanged: true });
  announceVersion(artifact.id, landed.versionId);
  return finish({ outcome: 'success', error: null, versionId: landed.versionId }, { pageHash: landed.pageHash, versionId: landed.versionId });
}

function pageHash(template: string, css: string, script: string): string {
  return createHash('sha256').update(template).update('\0').update(css).update('\0').update(script).digest('hex');
}

/**
 * Write the refreshed page as a new version and make it current — only if
 * its script builds and the artifact still shows the version the run started
 * from. Otherwise the new row is removed and the current version stays. A
 * page identical to the one the last refresh landed (still current) writes
 * nothing.
 */
async function landVersion(
  row: ArtifactAgentRefresh,
  artifact: Artifact,
  page: RefreshDeliverable,
): Promise<{ ok: true; versionId: string; pageHash: string; unchanged: boolean } | { ok: false; error: string }> {
  const extracted = extractInteractiveScript(page.template);
  const hash = pageHash(extracted.template, page.css, extracted.source);
  if (artifact.currentVersionId && row.lastVersionId === artifact.currentVersionId && row.lastPageHash === hash) {
    return { ok: true, versionId: artifact.currentVersionId, pageHash: hash, unchanged: true };
  }

  // Named on the row before the insert, so a crash after it leaves a trace
  // the next run cleans up (removeOrphanVersion).
  const versionId = randomUUID();
  await repo.setPendingVersion(artifact.id, versionId);
  await artifactsRepository.createVersion({
    id: versionId,
    artifactId: artifact.id,
    htmlTemplate: extracted.template,
    css: page.css,
    schemaJson: REFRESH_VERSION_MARKER,
    changeSummary: 'agent refresh',
    createdByUserId: row.ownerUserId,
  });
  const discard = async (error: string) => {
    await artifactsRepository.deleteVersion(versionId);
    await repo.setPendingVersion(artifact.id, null);
    return { ok: false as const, error };
  };
  if (extracted.source.trim()) {
    try {
      await buildAndStoreBundle({ artifactId: artifact.id, versionId, source: extracted.source });
    } catch (err) {
      return discard(`The page's JavaScript did not build: ${(err as Error).message}`);
    }
  }
  if (!(await artifactsRepository.setCurrentVersionIf(artifact.id, artifact.currentVersionId, versionId))) {
    return discard('The artifact was edited, restored or deleted while the refresh ran; its current version was kept');
  }
  await repo.setPendingVersion(artifact.id, null);
  const pruned = await artifactsRepository.pruneMarkedVersions(artifact.id, REFRESH_VERSION_MARKER, KEEP_REFRESH_VERSIONS);
  if (pruned > 0) coreLogger.debug({ artifactId: artifact.id, pruned }, 'artifact.agent_refresh.versions_pruned');
  return { ok: true, versionId, pageHash: hash, unchanged: false };
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

/**
 * Turn the schedule on (every `intervalMinutes`, first run one interval from
 * now) or off (null). Setting the interval it already runs at changes
 * nothing: no new chain, the failure streak and next run stay.
 */
export async function setAgentRefreshSchedule(artifactId: string, intervalMinutes: number | null): Promise<void> {
  const row = await repo.get(artifactId);
  if (!row) return;
  if (intervalMinutes === null) {
    if (row.intervalMinutes !== null || row.scheduleChain !== null) await repo.setSchedule(artifactId, null, null, null);
    return;
  }
  if (row.intervalMinutes === intervalMinutes && row.scheduleChain) return;
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

const jitter = (ms: number) => Math.floor(Math.random() * ms);

/**
 * Queue the chain's next attempt — or switch the schedule off after too many
 * failures in a row, telling the owner once. Never throws: a failure to
 * queue is recorded on the row as the reason the schedule stopped, so the
 * owner never sees "scheduled" for a schedule that is not.
 */
async function rearm(artifactId: string, chain: string, title: string, deps: AgentRefreshDeps, delayOverrideMs?: number): Promise<void> {
  try {
    const after = await repo.get(artifactId);
    if (!after || after.scheduleChain !== chain || after.intervalMinutes === null) return;
    if (after.consecutiveFailures >= MAX_SCHEDULE_FAILURES) {
      const reason = `Stopped after ${after.consecutiveFailures} scheduled refreshes in a row did not succeed. Last error: ${after.lastError ?? 'unknown'}`;
      if (await repo.disableSchedule(artifactId, reason.slice(0, 1000), chain)) {
        coreLogger.warn({ artifactId, failures: after.consecutiveFailures }, 'artifact.agent_refresh.schedule_disabled');
        await deps.notify(after.ownerUserId, 'artifact_refresh_disabled', `Scheduled refresh of "${title}" was turned off`, reason.slice(0, 280), { artifactId })
          .catch((err: unknown) => coreLogger.error({ err, artifactId }, 'artifact.agent_refresh.notify_failed'));
      }
      return;
    }
    const delayMs = delayOverrideMs ?? nextScheduleDelayMs(after.intervalMinutes, after.consecutiveFailures);
    if (await repo.setNextRun(artifactId, chain, new Date(Date.now() + delayMs))) {
      await queue(artifactId, chain, delayMs);
    }
  } catch (err) {
    coreLogger.error({ err, artifactId, chain }, 'artifact.agent_refresh.rearm_failed');
    await repo.disableSchedule(artifactId, `The next scheduled refresh could not be queued: ${(err as Error).message}`.slice(0, 1000), chain)
      .catch((e: unknown) => coreLogger.error({ err: e, artifactId }, 'artifact.agent_refresh.rearm_record_failed'));
  }
}

/** Why an unviewed artifact's schedule should pause now, or null. */
function idleReason(row: ArtifactAgentRefresh, artifact: Artifact, now: number): string | null {
  const { retentionDays } = resolveArtifactRetention();
  const idleDays = retentionDays > 0 ? retentionDays : DEFAULT_IDLE_DAYS;
  const since = Math.max(
    artifact.lastViewedAt?.getTime() ?? 0,
    (row.scheduleSetAt ?? artifact.createdAt).getTime(),
  );
  if (now - since <= idleDays * DAY_MS) return null;
  return `Paused: nobody has opened this artifact in ${idleDays} days. Open it and set the schedule again to resume.`;
}

/**
 * One scheduled attempt. Returns once the attempt has started (or was
 * skipped); `settled` resolves when the next one is queued or the schedule
 * stopped. The scheduler's handler does not wait for `settled`, so no
 * scheduler worker is held for an agent run.
 */
export async function runScheduledAttempt(task: ScheduledTask, overrides?: Partial<AgentRefreshDeps>): Promise<{ settled: Promise<void> }> {
  const deps = withDeps(overrides);
  const { artifactId, chain } = task.payload as unknown as AgentRefreshPayload;
  const none = { settled: Promise.resolve() };
  let title = artifactId;
  try {
    const row = await repo.get(artifactId);
    if (!row || row.scheduleChain !== chain || row.intervalMinutes === null) {
      coreLogger.debug({ artifactId, chain }, 'artifact.agent_refresh.schedule_superseded');
      return none;
    }
    const artifact = await artifactsRepository.getById(artifactId);
    if (!artifact) {
      await repo.disableSchedule(artifactId, 'The artifact was deleted', chain);
      coreLogger.info({ artifactId }, 'artifact.agent_refresh.schedule_stopped — artifact deleted');
      return none;
    }
    title = artifact.title;
    const { userRepository } = await import('@/db/repositories/user-repository');
    if (!(await userRepository.findById(row.ownerUserId))?.isActive) {
      await repo.disableSchedule(artifactId, 'The owner\'s account is disabled', chain);
      coreLogger.info({ artifactId, ownerUserId: row.ownerUserId }, 'artifact.agent_refresh.schedule_stopped — owner disabled');
      return none;
    }
    const idle = idleReason(row, artifact, Date.now());
    if (idle) {
      if (await repo.disableSchedule(artifactId, idle, chain)) {
        coreLogger.info({ artifactId }, 'artifact.agent_refresh.schedule_paused_unviewed');
        await deps.notify(row.ownerUserId, 'artifact_refresh_paused', `Scheduled refresh of "${artifact.title}" was paused`, idle, { artifactId })
          .catch((err: unknown) => coreLogger.error({ err, artifactId }, 'artifact.agent_refresh.notify_failed'));
      }
      return none;
    }

    // Module off: no attempt, nothing recorded; the chain goes on so the
    // schedule resumes when the module is back (as source refresh does).
    if (!isJobOn('artifacts-refresh')) {
      coreLogger.debug({ artifactId }, 'artifact.agent_refresh.skip_module_off');
      await rearm(artifactId, chain, title, deps);
      return none;
    }
    const started = await startAgentRefresh(artifactId, 'schedule', deps);
    if (started.status === 'started') {
      return { settled: started.done.then(() => rearm(artifactId, chain, title, deps)) };
    }
    if (started.status === 'capacity') {
      await rearm(artifactId, chain, title, deps, CAPACITY_RETRY_MS + jitter(CAPACITY_RETRY_MS));
      return none;
    }
    await rearm(artifactId, chain, title, deps);
    return none;
  } catch (err) {
    const error = `The scheduled refresh could not run: ${(err as Error).message}`;
    coreLogger.error({ err, artifactId, chain }, 'artifact.agent_refresh.schedule_attempt_failed');
    await repo.recordScheduleError(artifactId, chain, error.slice(0, 1000))
      .catch((e: unknown) => coreLogger.error({ err: e, artifactId }, 'artifact.agent_refresh.record_failed'));
    await rearm(artifactId, chain, title, deps);
    return none;
  }
}

/** Scheduler handler: starts the attempt and returns; the run re-arms the chain when it settles. */
export async function handleAgentRefreshTask(task: ScheduledTask): Promise<void> {
  const { settled } = await runScheduledAttempt(task);
  void settled;
}

export function registerAgentRefreshHandler(): void {
  getScheduler().registerHandler(AGENT_REFRESH_TASK, handleAgentRefreshTask);
}

/**
 * Re-arm every schedule at boot under a new chain, due at its stored next
 * run (spread over {@link BOOT_JITTER_MS}). A task queued by the previous
 * boot is then of an old chain and ends without running, so a restart never
 * doubles a schedule, and one queued in memory that the restart lost is
 * replaced; the jitter keeps a restart from starting every overdue one at once.
 */
export async function bootstrapAgentRefreshSchedules(): Promise<number> {
  let armed = 0;
  for (const row of await repo.listScheduled()) {
    if (!row.scheduleChain || row.intervalMinutes === null) continue;
    const chain = generateId();
    if (!(await repo.rechain(row.artifactId, row.scheduleChain, chain))) continue;
    const due = row.nextRunAt ? row.nextRunAt.getTime() - Date.now() : row.intervalMinutes * 60_000;
    await queue(row.artifactId, chain, Math.max(due, 0) + jitter(BOOT_JITTER_MS));
    armed++;
  }
  if (armed > 0) coreLogger.info({ armed }, 'artifact.agent_refresh.schedules_armed');
  return armed;
}
