/**
 * Run/trace correlation (WS4 observability, items 1–2).
 *
 * A `runId` is minted once per orchestrated turn in
 * `AgentService.handleMessage` and carried implicitly via
 * `AsyncLocalStorage` for the lifetime of that turn — including every child
 * agent, tool call, and LLM request it fans out to. Two consumers read it
 * without any threading:
 *
 *   - the pino logger `mixin` (src/utils/logger.ts) stamps `runId` onto every
 *     log line emitted inside the run, so a single grep reconstructs the turn;
 *   - `agent-events` rows record it (plus `origin`) for post-hoc forensics.
 *
 * This module deliberately has NO heavy dependencies (no prom-client, no DB) so
 * the logger can import it at process start without pulling the telemetry stack
 * in. Metric emission lives in `src/core/telemetry.ts`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RunContext {
  /** Stable id for one orchestrated turn — `run_<uuid>`. */
  readonly runId: string;
  readonly sessionId?: string;
  readonly userId?: string;
  /** Entry channel (`api`, `webchat`, `slack`, `heartbeat`, …). */
  readonly channel?: string;
  /** Provenance of the run for audit (`user`, `hook`, `heartbeat`, …). */
  readonly origin?: string;
}

const storage = new AsyncLocalStorage<RunContext>();

/** Mint a fresh run id. Prefixed so it's recognizable in logs/grep. */
export function generateRunId(): string {
  return `run_${randomUUID()}`;
}

/** Run `fn` with `ctx` bound as the ambient run context. */
export function runWithContext<T>(ctx: RunContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The ambient run context, or undefined outside any run. */
export function getRunContext(): RunContext | undefined {
  return storage.getStore();
}

/** The ambient run id, or undefined outside any run. */
export function getRunId(): string | undefined {
  return storage.getStore()?.runId;
}
