/**
 * The pipeline evidence gate — a stage that DECLARED it produces artifacts may
 * not be marked complete on the child's word alone.
 *
 * Regression target (docs/plans/pipeline-evidence-gate.md): a 7-stage "Full
 * Development Cycle" reported every stage green over an empty workspace.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { emptyCounters } from '@/core/swarm/receipt';
import { PipelineManager, stageEvidenceFailure } from './pipeline-manager';
import { verificationEvidenceRepository } from '@/db/repositories/verification-evidence-repository';
import { planProducesArtifactsBackfill } from '@/db/seed-presets';

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

// ── Preset backfill ────────────────────────────────────────────────────────
// Presets are never overwritten on reseed, so without this an EXISTING install
// never receives the declaration and the gate silently never fires.

describe('planProducesArtifactsBackfill', () => {
  const shipped = [
    { name: 'Research', topic: 'research', toolIds: [], requiresApproval: false },
    { name: 'Implementation', topic: 'coding', toolIds: [], requiresApproval: false, producesArtifacts: true },
  ];

  test('adds the missing declaration, matched by name', () => {
    const stored = [
      { name: 'Research', topic: 'research', toolIds: [], requiresApproval: false },
      { name: 'Implementation', topic: 'coding', toolIds: [], requiresApproval: false },
    ];
    const { steps, changed } = planProducesArtifactsBackfill(stored, shipped);
    expect(changed).toBe(true);
    expect(steps[1].producesArtifacts).toBe(true);
    // Undeclared stages are left exactly as they were.
    expect(steps[0].producesArtifacts).toBeUndefined();
  });

  test('preserves an explicit false — that is a user opting OUT of gating', () => {
    const stored = [{ name: 'Implementation', topic: 'coding', toolIds: [], requiresApproval: false, producesArtifacts: false }];
    const { steps, changed } = planProducesArtifactsBackfill(stored, shipped);
    expect(changed).toBe(false);
    expect(steps[0].producesArtifacts).toBe(false);
  });

  test('is idempotent — a second pass writes nothing', () => {
    const stored = [{ name: 'Implementation', topic: 'coding', toolIds: [], requiresApproval: false }];
    const once = planProducesArtifactsBackfill(stored, shipped);
    expect(once.changed).toBe(true);
    expect(planProducesArtifactsBackfill(once.steps, shipped).changed).toBe(false);
  });

  test('tolerates renamed, removed and reordered steps', () => {
    const stored = [
      { name: 'Implementation (custom)', topic: 'coding', toolIds: [], requiresApproval: false },
      { name: 'Research', topic: 'research', toolIds: [], requiresApproval: false },
    ];
    expect(planProducesArtifactsBackfill(stored, shipped).changed).toBe(false);
  });

  test('leaves every other field untouched', () => {
    const stored = [{ name: 'Implementation', topic: 'coding', toolIds: ['git'], requiresApproval: true, promptTemplate: 'mine', maxRetries: 9 }];
    const { steps } = planProducesArtifactsBackfill(stored, shipped);
    expect(steps[0]).toMatchObject({ toolIds: ['git'], requiresApproval: true, promptTemplate: 'mine', maxRetries: 9 });
  });

  // `stageType` has the same failure mode producesArtifacts had, and it bit for
  // real: a full 7-stage run reported green while the audit-coverage gate never
  // fired, because no seeded template carried the flag the gate reads.
  describe('stageType', () => {
    const withAuditor = [
      ...shipped,
      { name: 'QA Validation', topic: 'qa', toolIds: [], requiresApproval: false, stageType: 'qa_validation' as const, retryTargetStage: 2 },
    ];

    test('marks the auditor and carries its retry target', () => {
      const stored = [{ name: 'QA Validation', topic: 'qa', toolIds: [], requiresApproval: false }];
      const { steps, changed } = planProducesArtifactsBackfill(stored, withAuditor);
      expect(changed).toBe(true);
      expect(steps[0].stageType).toBe('qa_validation');
      expect(steps[0].retryTargetStage).toBe(2);
    });

    test("preserves a user's explicit 'standard' — opting a stage out of auditing", () => {
      const stored = [{ name: 'QA Validation', topic: 'qa', toolIds: [], requiresApproval: false, stageType: 'standard' as const }];
      const { steps, changed } = planProducesArtifactsBackfill(stored, withAuditor);
      expect(changed).toBe(false);
      expect(steps[0].stageType).toBe('standard');
    });

    test('preserves a user-chosen retry target while still adding the type', () => {
      const stored = [{ name: 'QA Validation', topic: 'qa', toolIds: [], requiresApproval: false, retryTargetStage: 0 }];
      const { steps } = planProducesArtifactsBackfill(stored, withAuditor);
      expect(steps[0].stageType).toBe('qa_validation');
      expect(steps[0].retryTargetStage).toBe(0);
    });

    test('is idempotent', () => {
      const stored = [{ name: 'QA Validation', topic: 'qa', toolIds: [], requiresApproval: false }];
      const once = planProducesArtifactsBackfill(stored, withAuditor);
      expect(planProducesArtifactsBackfill(once.steps, withAuditor).changed).toBe(false);
    });
  });
});

// ── The gate as wired (ledger write + throw) ───────────────────────────────

describe('PipelineManager.assertStageEvidence', () => {
  const setup = () => {
    const rows: Array<Record<string, unknown>> = [];
    const spy = spyOn(verificationEvidenceRepository, 'record').mockImplementation(async (r) => {
      rows.push(r as Record<string, unknown>);
      return r as never;
    });
    // The gate is private by design — it must not become a public API just to
    // be observable. Reached here the same way the run loop reaches it.
    const call = (args: Record<string, unknown>) =>
      (new PipelineManager() as unknown as {
        assertStageEvidence: (a: Record<string, unknown>) => Promise<void>;
      }).assertStageEvidence({ sessionId: 's', pipelineId: 'p', stageName: 'Implementation', ...args });
    return { rows, spy, call };
  };

  test('throws and records a failed row when a declared stage wrote nothing', async () => {
    const { rows, spy, call } = setup();
    await expect(call({ producesArtifacts: true, counters: counters({ toolCalls: 7 }) })).rejects.toThrow(/produces artifacts/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'side_effect', passed: false, stage: 'Implementation' });
    spy.mockRestore();
  });

  test('passes and records evidence when the stage wrote a file', async () => {
    const { rows, spy, call } = setup();
    await call({ producesArtifacts: true, counters: counters({ filesChanged: 2, toolCalls: 5 }) });
    expect(rows[0]).toMatchObject({ kind: 'side_effect', passed: true });
    expect((rows[0].detail as { filesChanged: number }).filesChanged).toBe(2);
    spy.mockRestore();
  });

  test('an undeclared stage is not gated and writes no row at all', async () => {
    const { rows, spy, call } = setup();
    await call({ producesArtifacts: undefined, counters: counters() });
    expect(rows).toHaveLength(0);
    spy.mockRestore();
  });

  test('absent counters pass, but the gap is recorded rather than silently zeroed', async () => {
    const { rows, spy, call } = setup();
    await call({ producesArtifacts: true, counters: null });
    expect(rows[0]).toMatchObject({ passed: true });
    expect(rows[0].detail).toHaveProperty('unavailable');
    spy.mockRestore();
  });

  test('a ledger failure never breaks the run, and never masks the gate verdict', async () => {
    const spy = spyOn(verificationEvidenceRepository, 'record').mockImplementation(async () => {
      throw new Error('db down');
    });
    const call = (a: Record<string, unknown>) =>
      (new PipelineManager() as unknown as { assertStageEvidence: (x: Record<string, unknown>) => Promise<void> })
        .assertStageEvidence({ sessionId: 's', pipelineId: 'p', stageName: 'Implementation', ...a });
    // Still passes a good stage …
    await call({ producesArtifacts: true, counters: counters({ filesChanged: 1 }) });
    // … and still fails a bad one.
    await expect(call({ producesArtifacts: true, counters: counters() })).rejects.toThrow();
    spy.mockRestore();
  });
});
