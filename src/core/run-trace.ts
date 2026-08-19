/**
 * The run log, folded into spans.
 *
 * `run_events` is a flat append-only stream: entered / completed / traversed /
 * tool_call. A trace view wants the other shape — what ran, nested, for how
 * long, and at what cost. This module is that fold, and it is PURE so the
 * arithmetic is testable without a database or a browser.
 *
 * Cost attribution is by TIME WINDOW against `cost_log`, not by a token counter
 * threaded through the walker: a model call already writes its own cost row
 * with the session id and a timestamp, and pipeline node spans do not overlap
 * each other, so "which node was running when this call was billed" is an
 * unambiguous question.
 *
 * ponytail: overlapping spans (a swarm fan-out billing two children at once)
 * attribute to the innermost span that contains the row, which splits fan-out
 * cost by whoever was innermost at that instant rather than by parentage.
 * Upgrade path when that matters: carry the node key on the cost row.
 */

export interface TraceEventInput {
  seq: number;
  subject: string;
  subjectId: string;
  parentSubjectId?: string | null;
  event: string;
  payload?: unknown;
  createdAt: Date | string;
}

export interface TraceCostInput {
  createdAt: Date | string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
}

export interface TraceSpan {
  /** `${subject}:${subjectId}#${visit}` — stable within one trace. */
  id: string;
  subject: string;
  subjectId: string;
  name: string;
  startMs: number;
  endMs: number | null;
  durationMs: number | null;
  status: 'running' | 'completed' | 'failed';
  /** Set when the span is still open at the end of the log. */
  open: boolean;
  costUsd: number;
  tokens: number;
  modelCalls: number;
  detail: Record<string, unknown>;
}

export interface RunTrace {
  runId: string;
  startMs: number | null;
  endMs: number | null;
  durationMs: number | null;
  spans: TraceSpan[];
  totals: {
    costUsd: number;
    tokens: number;
    modelCalls: number;
    /** Cost that fell outside every span — the run's own turns, not a node's. */
    unattributedCostUsd: number;
    nodes: number;
    toolCalls: number;
  };
}

const ms = (v: Date | string): number => (v instanceof Date ? v.getTime() : new Date(v).getTime());
const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v ? v : fallback);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Fold events (+ the run's cost rows) into spans, oldest-first.
 *
 * Open spans are kept rather than dropped: a run killed mid-node is exactly
 * when someone reads a trace, and a node that never closed is the finding.
 */
export function buildTrace(
  runId: string,
  events: TraceEventInput[],
  costRows: TraceCostInput[] = [],
): RunTrace {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const spans: TraceSpan[] = [];
  /** Open span per subject key, so a revisit opens a NEW span. */
  const open = new Map<string, TraceSpan>();
  const visits = new Map<string, number>();

  const keyOf = (e: TraceEventInput) => `${e.subject}:${e.subjectId}`;

  for (const e of ordered) {
    const at = ms(e.createdAt);
    const payload = (e.payload ?? {}) as Record<string, unknown>;

    // Point events with a duration: one self-contained span.
    if (e.event === 'tool_call') {
      const duration = num(payload.durationMs) ?? 0;
      spans.push({
        id: `tool:${e.subjectId}#${spans.length}`,
        subject: 'tool',
        subjectId: e.subjectId,
        name: e.subjectId,
        startMs: at - duration,
        endMs: at,
        durationMs: duration,
        status: payload.status === 'success' ? 'completed' : 'failed',
        open: false,
        costUsd: 0,
        tokens: 0,
        modelCalls: 0,
        detail: payload,
      });
      continue;
    }

    if (e.event === 'node_entered' || e.event === 'spawn' || e.event === 'item_started') {
      const key = keyOf(e);
      const visit = (visits.get(key) ?? 0) + 1;
      visits.set(key, visit);
      const span: TraceSpan = {
        id: `${key}#${visit}`,
        subject: e.subject,
        subjectId: e.subjectId,
        name: str(payload.name, str(payload.title, e.subjectId)),
        startMs: at,
        endMs: null,
        durationMs: null,
        status: 'running',
        open: true,
        costUsd: 0,
        tokens: 0,
        modelCalls: 0,
        detail: payload,
      };
      // A revisit closes the previous span for the same subject if the log
      // never did — a crashed node leaves no completion event.
      const previous = open.get(key);
      if (previous) {
        previous.endMs = at;
        previous.durationMs = at - previous.startMs;
        previous.status = 'failed';
        previous.open = false;
      }
      open.set(key, span);
      spans.push(span);
      continue;
    }

    if (
      e.event === 'node_completed' ||
      e.event === 'node_failed' ||
      e.event === 'result' ||
      e.event === 'cancel' ||
      e.event === 'item_finished'
    ) {
      const span = open.get(keyOf(e));
      if (!span) continue;
      span.endMs = at;
      span.durationMs = at - span.startMs;
      span.status = e.event === 'node_failed' || e.event === 'cancel' ? 'failed' : 'completed';
      span.open = false;
      span.detail = { ...span.detail, ...payload };
      open.delete(keyOf(e));
    }
  }

  // Cost attribution: innermost containing span wins; a row outside every span
  // is counted in the run total but attributed to nothing.
  let unattributed = 0;
  let totalCost = 0;
  let totalTokens = 0;
  for (const row of costRows) {
    const at = ms(row.createdAt);
    const tokens = (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
    totalCost += row.totalCost ?? 0;
    totalTokens += tokens;

    const containing = spans.filter(
      (s) => s.subject !== 'tool' && s.startMs <= at && (s.endMs ?? Number.POSITIVE_INFINITY) >= at,
    );
    const innermost = containing.sort((a, b) => b.startMs - a.startMs)[0];
    if (!innermost) {
      unattributed += row.totalCost ?? 0;
      continue;
    }
    innermost.costUsd += row.totalCost ?? 0;
    innermost.tokens += tokens;
    innermost.modelCalls += 1;
  }

  const starts = spans.map((s) => s.startMs);
  const ends = spans.map((s) => s.endMs ?? s.startMs);
  const startMs = starts.length ? Math.min(...starts) : null;
  const endMs = ends.length ? Math.max(...ends) : null;

  return {
    runId,
    startMs,
    endMs,
    durationMs: startMs != null && endMs != null ? endMs - startMs : null,
    spans,
    totals: {
      costUsd: totalCost,
      tokens: totalTokens,
      modelCalls: costRows.length,
      unattributedCostUsd: unattributed,
      nodes: spans.filter((s) => s.subject === 'pipeline_node').length,
      toolCalls: spans.filter((s) => s.subject === 'tool').length,
    },
  };
}
