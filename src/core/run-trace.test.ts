import { describe, expect, test } from 'vitest';
import { buildTrace, type TraceEventInput } from './run-trace';

/**
 * The trace is what someone reads when a run went wrong or cost too much, so
 * the two properties worth pinning are: every dollar in `cost_log` appears
 * exactly once in the totals, and a node that never closed is visible rather
 * than dropped.
 */
const t0 = new Date('2026-08-19T10:00:00Z').getTime();
const at = (offsetMs: number) => new Date(t0 + offsetMs);

const events: TraceEventInput[] = [
  { seq: 1, subject: 'pipeline_node', subjectId: 'n0', event: 'node_entered', payload: { name: 'Plan' }, createdAt: at(0) },
  { seq: 2, subject: 'tool', subjectId: 'plan__add_items', event: 'tool_call', payload: { status: 'success', durationMs: 40 }, createdAt: at(900) },
  { seq: 3, subject: 'pipeline_node', subjectId: 'n0', event: 'node_completed', payload: { name: 'Plan' }, createdAt: at(1000) },
  { seq: 4, subject: 'pipeline_node', subjectId: 'n1', event: 'node_entered', payload: { name: 'Implement' }, createdAt: at(1100) },
];

const costs = [
  { createdAt: at(500), modelName: 'm', inputTokens: 100, outputTokens: 20, totalCost: 0.5 },
  { createdAt: at(1500), modelName: 'm', inputTokens: 200, outputTokens: 30, totalCost: 1.25 },
  // Before any span — a router turn that ran before the pipeline started.
  { createdAt: at(-500), modelName: 'm', inputTokens: 10, outputTokens: 1, totalCost: 0.1 },
];

describe('run trace — folding the log into spans', () => {
  const trace = buildTrace('run-1', events, costs);

  test('cost lands on the node that was running, and nothing is lost', () => {
    const plan = trace.spans.find((s) => s.name === 'Plan');
    const implement = trace.spans.find((s) => s.name === 'Implement');
    expect(plan?.costUsd).toBeCloseTo(0.5);
    expect(plan?.tokens).toBe(120);
    expect(implement?.costUsd).toBeCloseTo(1.25);
    // Every row counts toward the run total, attributed or not.
    expect(trace.totals.costUsd).toBeCloseTo(1.85);
    expect(trace.totals.unattributedCostUsd).toBeCloseTo(0.1);
  });

  test('a node still running is kept open rather than dropped', () => {
    const implement = trace.spans.find((s) => s.name === 'Implement');
    expect(implement?.open).toBe(true);
    expect(implement?.status).toBe('running');
    expect(trace.totals.nodes).toBe(2);
  });

  test('a tool call becomes a span ending when it was logged', () => {
    const tool = trace.spans.find((s) => s.subject === 'tool');
    expect(tool?.durationMs).toBe(40);
    expect(tool?.endMs).toBe(t0 + 900);
    expect(tool?.startMs).toBe(t0 + 860);
    // Tool spans never absorb model cost — they are not where a model ran.
    expect(tool?.costUsd).toBe(0);
  });

  test('a revisit opens a second span and closes the abandoned one', () => {
    const retried = buildTrace('run-2', [
      ...events.slice(0, 1),
      { seq: 9, subject: 'pipeline_node', subjectId: 'n0', event: 'node_entered', payload: { name: 'Plan' }, createdAt: at(2000) },
    ]);
    const planSpans = retried.spans.filter((s) => s.subjectId === 'n0');
    expect(planSpans.map((s) => s.id)).toEqual(['pipeline_node:n0#1', 'pipeline_node:n0#2']);
    expect(planSpans[0].status).toBe('failed');
    // Force-closed, so the UI must not keep showing it as live.
    expect(planSpans[0].open).toBe(false);
    expect(planSpans[0].durationMs).toBe(2000);
  });

  test('an empty log is an empty trace, not a crash', () => {
    expect(buildTrace('run-3', []).durationMs).toBeNull();
  });
});
