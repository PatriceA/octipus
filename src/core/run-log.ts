/**
 * The run log — one append-only stream of what happened during a run.
 *
 * `run_events` already carried swarm node lifecycle (as `swarm_ledger`); this
 * is the writer for everything else: graph node transitions, edge traversals,
 * plan item progress, and tool dispatch. Swarm events keep going through
 * `SwarmLedger`, which owns the replay/reconcile fold on top of them.
 *
 * Two rules the whole module is built around:
 *
 *  - **Never on the critical path.** Every append is fire-and-forget with the
 *    error swallowed and logged. A log write must not fail a pipeline; the log
 *    is a durability and observability aid, not a transaction.
 *  - **Shape, not payloads.** Tool arguments and results are never stored. What
 *    tracing and checkpointing need is which node ran, in what order, for how
 *    long, and how it ended — a durable copy of every tool payload is a
 *    data-retention problem nobody asked for.
 */
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import type { NewRunEventRecord, RunEventRecord } from '@/db/schema/run-events';
import { runEvents } from '@/db/schema/run-events';
import { coreLogger } from '@/utils/logger';
import { getOrchestratorHooks } from './orchestrator/hooks';

export type RunEventSubject = NewRunEventRecord['subject'];
export type RunEventType = NewRunEventRecord['event'];

export interface RunEventInput {
  /** Root session id — one run. */
  runId: string;
  subject: RunEventSubject;
  subjectId: string;
  event: RunEventType;
  parentSubjectId?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Append one event. Fire-and-forget: awaiting it is allowed but never required,
 * and a failure is logged rather than thrown.
 */
export async function appendRunEvent(input: RunEventInput): Promise<void> {
  try {
    await getDb().insert(runEvents).values({
      runId: input.runId,
      subject: input.subject,
      subjectId: input.subjectId,
      parentSubjectId: input.parentSubjectId ?? null,
      event: input.event,
      payload: (input.payload ?? null) as NewRunEventRecord['payload'],
    });
  } catch (err) {
    coreLogger.error(
      { err, subject: input.subject, event: input.event },
      'run-log append failed — continuing (the log is an aid, not the critical path)',
    );
  }
}

/** Fire-and-forget helper for call sites that must not await. */
export function recordRunEvent(input: RunEventInput): void {
  void appendRunEvent(input);
}

/**
 * Build the run event for one tool dispatch, or `null` when the call does not
 * belong to a run.
 *
 * Pure and exported so the two properties that matter are testable without a
 * database: a tool invoked outside a session (CLI utilities, boot-time probes)
 * is NOT logged — inventing a run for it would pollute every replay — and the
 * payload records argument NAMES only. Never values, never results.
 */
export function toolCallEvent(ctx: {
  toolId: string;
  toolName: string;
  args: Record<string, unknown>;
  agent: { sessionId: string; role?: string };
  status: string;
  durationMs: number;
}): RunEventInput | null {
  if (!ctx.agent.sessionId) return null;
  return {
    runId: ctx.agent.sessionId,
    subject: 'tool',
    subjectId: `${ctx.toolId}__${ctx.toolName}`,
    event: 'tool_call',
    payload: {
      status: ctx.status,
      durationMs: ctx.durationMs,
      role: ctx.agent.role,
      args: Object.keys(ctx.args ?? {}),
    },
  };
}

let installed = false;

/**
 * Subscribe the run log to tool dispatch.
 *
 * This is the payoff of the dispatch waterfall: one subscriber records every
 * tool call in the system, instead of a log line threaded through each of the
 * places a tool can be invoked. Idempotent — safe to call more than once.
 */
export function installRunLogHooks(): () => void {
  if (installed) return () => {};
  installed = true;

  const off = getOrchestratorHooks().register('tool:after', (ctx) => {
    const event = toolCallEvent(ctx);
    if (event) recordRunEvent(event);
  });

  return () => {
    off();
    installed = false;
  };
}

/**
 * A run's events in append order. The one read path — replay, tracing and the
 * API all fold the same ordered stream.
 *
 * `limit` caps the newest N (returned oldest-first, so a truncated read is
 * still a readable tail rather than a random slice).
 */
export async function readRunEvents(
  runId: string,
  opts: { subject?: RunEventSubject; limit?: number } = {},
): Promise<RunEventRecord[]> {
  const where = opts.subject
    ? and(eq(runEvents.runId, runId), eq(runEvents.subject, opts.subject))
    : eq(runEvents.runId, runId);

  const rows = await getDb().select().from(runEvents).where(where).orderBy(asc(runEvents.seq));
  return opts.limit && opts.limit > 0 ? rows.slice(-opts.limit) : rows;
}
