import type { Pipeline, PipelineNodeRow, PlanItemRow } from '@/db/schema/pipelines';
import type { RunEventRecord } from '@/db/schema/run-events';
import { stripPipelineControlBlocks } from './handoff';

/** Live state takes precedence over a summary left by an earlier transition. */
export function pipelineSummary(pipeline: Pipeline, nodes: PipelineNodeRow[], items: PlanItemRow[]): string {
  const node = nodes.find(n => n.nodeKey === pipeline.currentNodeKey);
  const item = items.find(i => i.status === 'running');
  const where = `${node ? ` at "${node.name}"` : ''}${item ? ` for "${item.title}"` : ''}`;
  if (pipeline.status === 'running') return `Running${where}.`;
  if (pipeline.status === 'awaiting_approval') {
    const pending = pipeline.metadata?.pendingApproval as { stage?: string; subject?: string; reason?: string } | undefined;
    return `Waiting for approval${pending?.stage ? ` at "${pending.stage}"` : where}${pending?.subject ? `: ${pending.subject}` : ''}.`;
  }
  return stripPipelineControlBlocks(pipeline.summary ?? `${pipeline.status}${where}.`);
}

/** Preserve each item/attempt independently; legacy events without identity stay unassigned. */
export function pipelineStageHistory(events: RunEventRecord[]): Array<Record<string, unknown> & { seq: number; stageKey: string }> {
  return events.map(event => ({ seq: event.seq, at: event.createdAt, event: event.event, stageKey: event.subjectId,
    ...(event.payload as Record<string, unknown> ?? {}),
  }));
}

/** One row per stage attempt, with all its start/resume/approval transitions. */
export function pipelineStageRuns(history: ReturnType<typeof pipelineStageHistory>, itemId: string) {
  const runs = new Map<string, Record<string, unknown> & { events: Array<Record<string, unknown>> }>();
  for (const event of history) {
    if (event.itemId !== itemId || typeof event.attemptId !== 'string') continue;
    const key = `${event.stageKey}:${event.attemptId}`;
    const run: Record<string, unknown> & { events: Array<Record<string, unknown>> } = runs.get(key) ?? { key: event.stageKey, name: event.name, attemptId: event.attemptId,
      attempt: event.attempt, itemId, startedAt: event.at, startReason: event.startReason, events: [] };
    run.events.push(event);
    if (event.event === 'spawn') run.status = 'running';
    if (event.event === 'node_completed') Object.assign(run, { status: 'completed', completedAt: event.at, output: event.output, verdict: event.verdict });
    if (event.event === 'reconcile' && event.reasonKind === 'environment') Object.assign(run, { status: 'paused', reason: 'environment', error: event.reason });
    if (event.event === 'node_failed') Object.assign(run, { status: 'failed', completedAt: event.at, error: event.reason, retry: event.retry });
    runs.set(key, run);
  }
  return [...runs.values()];
}

/** Keep status structured below the bridge's 50 KB text ceiling. */
export function compactPipelineStatus<T extends Record<string, unknown>>(status: T): T & { outputCompacted?: boolean } {
  const clip = (value: unknown, chars: number, depth = 0, field = ''): unknown => {
    if (typeof value === 'string') return value.length > chars ? `${value.slice(0, chars)} … [clipped]` : value;
    if (value instanceof Date) return value;
    if (depth > 10) return '[details omitted]';
    if (Array.isArray(value)) {
      const page = depth === 1 && ['items', 'stages', 'history', 'recoveryRequired', 'remainingItems'].includes(field);
      return (page ? value : value.slice(0, chars <= 120 ? 3 : 20)).map(entry => clip(entry, chars, depth + 1));
    }
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
      // IDs, statuses, dates and pagination cursors remain lossless.
      /^(?:id|.*Id|status|.*At|seq|stageKey|key|resumeAfter)$/.test(key) ? entry : clip(entry, chars, depth + 1, key)]));
    return value;
  };
  if (JSON.stringify(status).length <= 40_000) return status;
  const out = clip(status, 500) as T & { outputCompacted?: boolean };
  out.outputCompacted = true;
  const history = out.history as unknown[] | undefined;
  const items = out.items as Array<{ stages?: unknown[] }> | undefined;
  if (items) for (const item of items) item.stages = [];
  while (JSON.stringify(out).length > 40_000 && history && history.length > 1) history.shift();
  if (history?.length) (out as Record<string, unknown>).historyNextBeforeSeq = (history[0] as { seq: number }).seq;
  // Large plans still expose every id/status; verbose fields yield to the state.
  if (JSON.stringify(out).length > 40_000) return { ...clip(out, 120) as T, outputCompacted: true };
  return out;
}
