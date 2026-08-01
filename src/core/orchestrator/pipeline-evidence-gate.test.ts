/**
 * The pipeline evidence gate — a stage that DECLARED it produces artifacts may
 * not be marked complete on the child's word alone.
 *
 * Regression target (docs/plans/pipeline-evidence-gate.md): a 7-stage "Full
 * Development Cycle" reported every stage green over an empty workspace.
 */
import { describe, expect, test } from 'bun:test';
import { emptyCounters } from '@/core/swarm/receipt';
import { stageEvidenceFailure } from './pipeline-manager';

const counters = (over: Partial<ReturnType<typeof emptyCounters>> = {}) => ({ ...emptyCounters(), ...over });

describe('stageEvidenceFailure', () => {
  test('fails a declared stage that changed no files', () => {
    const reason = stageEvidenceFailure(true, counters({ toolCalls: 12, commandsRun: 3 }));
    expect(reason).toContain('changed 0 files');
    expect(reason).toContain('12 tool calls');
  });

  test('passes a declared stage that changed a file', () => {
    expect(stageEvidenceFailure(true, counters({ filesChanged: 1, toolCalls: 4 }))).toBeNull();
  });

  test('never gates an undeclared stage — research/review legitimately write nothing', () => {
    expect(stageEvidenceFailure(undefined, counters())).toBeNull();
    expect(stageEvidenceFailure(false, counters())).toBeNull();
  });

  test('treats absent counters as unknown, not as zero', () => {
    // A worker that exposes no tally must NOT be failed — that would fail work
    // that actually succeeded, the one outcome worse than no gate.
    expect(stageEvidenceFailure(true, null)).toBeNull();
  });
});
