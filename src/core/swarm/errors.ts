/**
 * Swarm Phase 2 — error taxonomy.
 *
 * First-class error classes staked by `.octipus/swarm-design.md` §Failure Modes.
 * Each maps to a `FailoverReason` via `classifyError()` — see `mapSwarmError()`.
 *
 * These errors flow from `AgentWorker.run()` (budget/timeout pre-check) and
 * from `SwarmSpawner` (cycle detection, cascade abort) up to parent LLMs,
 * where they surface as `ChildResult.status` and as tool-error messages.
 */

import {
  ClassifiedError,
  FailoverReason,
  RecoveryAction,
} from '@/core/errors/classification';
import type { ChildResultStatus } from './types';

/** Thrown when a node exceeds its `tokens.cap` before or during an LLM call. */
export class BudgetExceededError extends ClassifiedError {
  constructor(opts: { agentId: string; used: number; cap: number; cause?: unknown }) {
    super({
      reason: FailoverReason.BUDGET_EXCEEDED,
      recovery: RecoveryAction.ABORT,
      message: `Token budget exceeded for ${opts.agentId} (${opts.used}/${opts.cap})`,
      metadata: { agentId: opts.agentId, used: opts.used, cap: opts.cap },
      cause: opts.cause,
    });
    this.name = 'BudgetExceededError';
  }
}

/**
 * Thrown when a node's tool activity stopped matching its brief for long enough
 * that it is no longer plausibly doing the requested work. See
 * `agent-worker/drift-detector.ts`.
 */
export class DriftDetectedError extends ClassifiedError {
  constructor(opts: { agentId: string; consecutive: number; briefSummary: string; cause?: unknown }) {
    super({
      reason: FailoverReason.TASK_DRIFT,
      recovery: RecoveryAction.ABORT,
      message:
        `Task drift: ${opts.agentId} ran ${opts.consecutive} consecutive iterations whose tool ` +
        `activity had nothing in common with its brief (${opts.briefSummary}). Stopped rather than ` +
        `letting it run to budget and report success on unrelated work.`,
      metadata: { agentId: opts.agentId, consecutive: opts.consecutive },
      cause: opts.cause,
    });
    this.name = 'DriftDetectedError';
  }
}

/** Thrown when a node's wall-clock cap elapses. */
export class ChildTimeoutError extends ClassifiedError {
  constructor(opts: { agentId: string; elapsedMs: number; capMs: number; cause?: unknown }) {
    super({
      reason: FailoverReason.CHILD_TIMEOUT,
      recovery: RecoveryAction.ABORT,
      message: `Child timeout: ${opts.agentId} exceeded wall-clock (${opts.elapsedMs}ms / ${opts.capMs}ms)`,
      metadata: { agentId: opts.agentId, elapsedMs: opts.elapsedMs, capMs: opts.capMs },
      cause: opts.cause,
    });
    this.name = 'ChildTimeoutError';
  }
}

/** Thrown by `SwarmCallGraph` when a spawn's fingerprint or ancestor-chain check fails. */
export class DuplicateSpawnError extends ClassifiedError {
  /** Structured notes returned to the parent LLM as a tool-error message. */
  readonly parentNotice: string;
  /** Matching existing node id (if any). */
  readonly existingNodeId?: string;

  constructor(opts: {
    topicPath: string;
    parentNotice: string;
    existingNodeId?: string;
    cause?: unknown;
  }) {
    super({
      reason: FailoverReason.DUPLICATE_SPAWN,
      recovery: RecoveryAction.NONE,
      message: `Duplicate spawn rejected for topic "${opts.topicPath}"`,
      metadata: { topicPath: opts.topicPath, existingNodeId: opts.existingNodeId },
      cause: opts.cause,
    });
    this.name = 'DuplicateSpawnError';
    this.parentNotice = opts.parentNotice;
    this.existingNodeId = opts.existingNodeId;
  }
}

/** Thrown when an ancestor's abort cascades down — child / descendant terminates. */
export class CascadedCancellationError extends ClassifiedError {
  constructor(opts: { agentId: string; reason?: string; cause?: unknown }) {
    super({
      reason: FailoverReason.CASCADED_CANCELLATION,
      recovery: RecoveryAction.ABORT,
      message: `Cascaded cancellation at ${opts.agentId}${opts.reason ? `: ${opts.reason}` : ''}`,
      metadata: { agentId: opts.agentId, reason: opts.reason },
      cause: opts.cause,
    });
    this.name = 'CascadedCancellationError';
  }
}

/**
 * True for any error that represents intentional termination — admin cancel,
 * parent abort cascading down, AbortSignal trips. These are expected outcomes,
 * not failures, so callers should log them at info/debug rather than error.
 */
export function isCancellationError(err: unknown): boolean {
  if (err instanceof CascadedCancellationError) return true;
  if (err instanceof DuplicateSpawnError) return true;
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true;
    const msg = err.message || '';
    if (/abort|cancel|stopped/i.test(msg)) return true;
  }
  return false;
}

/** Map any thrown error into a `ChildResult.status` via the `ClassifiedError` taxonomy. */
export function classifyChildError(err: unknown): ChildResultStatus {
  // Direct matches on our own classes (fast path).
  if (err instanceof BudgetExceededError) return 'budget';
  if (err instanceof ChildTimeoutError) return 'timeout';
  // `contract_failed`, not `tool_error` — drift means the child did not do the
  // requested work, which is a contract miss. Without this line it falls
  // through to `tool_error`, which triggers the crash-retry path in the spawner
  // and would spawn a SECOND child to drift all over again.
  if (err instanceof DriftDetectedError) return 'contract_failed';
  if (err instanceof DuplicateSpawnError) return 'cancelled';
  if (err instanceof CascadedCancellationError) return 'cancelled';

  const msg = err instanceof Error ? err.message : String(err ?? '');
  // Fall through to the classification taxonomy for everything else.
  // Cheap string-level matches mirror the legacy spawner heuristic so tests
  // and mocks that throw plain `Error('timeout')` keep working.
  if (/permission denied/i.test(msg)) return 'denied';
  if (/budget.*exceed|token.*limit|token.*budget.*exceed/i.test(msg)) return 'budget';
  if (/child.*(timeout|timed.?out)|subagent.*timeout|agent.*timeout/i.test(msg)) return 'timeout';
  if (/abort|cancel|stopped/i.test(msg)) return 'cancelled';
  if (/rate.?limit|overload|provider|ECONN|5\d\d/i.test(msg)) return 'provider_error';
  return 'tool_error';
}
