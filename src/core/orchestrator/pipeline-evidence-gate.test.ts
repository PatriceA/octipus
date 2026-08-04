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
    const reason = stageEvidenceFailure({ producesArtifacts: true }, counters({ toolCalls: 12, commandsRun: 3 }));
    expect(reason).toContain('changed 0 files');
    expect(reason).toContain('12 tool calls');
  });

  test('passes a declared stage that changed a file', () => {
    expect(stageEvidenceFailure({ producesArtifacts: true }, counters({ filesChanged: 1, toolCalls: 4 }))).toBeNull();
  });

  test('never gates an undeclared stage — research/review legitimately write nothing', () => {
    expect(stageEvidenceFailure({}, counters())).toBeNull();
    expect(stageEvidenceFailure({ producesArtifacts: false }, counters())).toBeNull();
  });

  test('treats absent counters as unknown, not as zero', () => {
    // A worker that exposes no tally must NOT be failed — that would fail work
    // that actually succeeded, the one outcome worse than no gate.
    expect(stageEvidenceFailure({ producesArtifacts: true }, null)).toBeNull();
  });

  // The false positive this signal exists to kill: on 2026-08-03 a real
  // `Implement Fix` stage rewrote dice.py and test_dice.py through `shell__run`
  // (18 → 21 passing tests) and was failed for "changed 0 files", because
  // `filesChanged` counts only FILE_CHANGE_TOOLS.
  describe('filesystem evidence', () => {
    test('passes a shell-only writer that the counters could not see', () => {
      const shellWriter = counters({ toolCalls: 18, commandsRun: 11, toolErrors: 2 });
      expect(stageEvidenceFailure({ producesArtifacts: true }, shellWriter)).not.toBeNull();
      expect(stageEvidenceFailure({ producesArtifacts: true }, shellWriter, 2)).toBeNull();
    });

    test('still fails when BOTH signals say nothing happened', () => {
      const reason = stageEvidenceFailure({ producesArtifacts: true }, counters({ toolCalls: 9 }), 0);
      expect(reason).toContain('changed 0 files');
      expect(reason).toContain('workspace unchanged on disk');
    });

    test('names an unavailable snapshot rather than implying it was checked', () => {
      const reason = stageEvidenceFailure({ producesArtifacts: true }, counters({ toolCalls: 9 }), null);
      expect(reason).toContain('no workspace snapshot');
    });

    test('a snapshot showing work passes even with no counters at all', () => {
      // A CLI worker exposes no tally; the files are still plainly there.
      expect(stageEvidenceFailure({ producesArtifacts: true }, null, 3)).toBeNull();
    });

    test('either signal alone is enough — the two are blind in opposite ways', () => {
      // Counters see the tool but not the shell; the snapshot sees the disk but
      // not who wrote it. Requiring both would fail every stage using only one.
      expect(stageEvidenceFailure({ producesArtifacts: true }, counters({ filesChanged: 2 }), 0)).toBeNull();
      expect(stageEvidenceFailure({ producesArtifacts: true }, counters({ filesChanged: 0 }), 2)).toBeNull();
    });
  });

  // Declared purpose vs receipt. The failure: a Testing agent whose tools were
  // intersected down to `filesystem` said "I cannot run shell commands… I'll
  // simulate execution", then reported "18 passed, 0 failed". Its receipt said
  // `commandsRun: 0` and nothing compared that to what the stage was for.
  describe('runsCommands', () => {
    test('fails a verify-by-executing stage that executed nothing', () => {
      const simulated = counters({ toolCalls: 2, byName: { filesystem__read_file: 2 } });
      const reason = stageEvidenceFailure({ runsCommands: true }, simulated);
      expect(reason).toContain('ran 0 commands');
      expect(reason).toContain('cannot have executed nothing');
    });

    test('passes once it actually ran something', () => {
      expect(stageEvidenceFailure({ runsCommands: true }, counters({ commandsRun: 1, toolCalls: 3 }))).toBeNull();
    });

    test('is independent of producesArtifacts — a test run need not write files', () => {
      // Testing/Code Review legitimately change nothing; they must still run.
      expect(stageEvidenceFailure({ runsCommands: true }, counters({ commandsRun: 4, filesChanged: 0 }))).toBeNull();
    });

    test('reports BOTH misses when a stage declared both and did neither', () => {
      const reason = stageEvidenceFailure({ producesArtifacts: true, runsCommands: true }, counters(), 0);
      expect(reason).toContain('changed 0 files');
      expect(reason).toContain('ran 0 commands');
    });

    test('files on disk do not excuse a stage that never executed', () => {
      // The snapshot answers "did anything change", never "was it verified".
      // Letting it satisfy runsCommands would reopen the simulation hole.
      const reason = stageEvidenceFailure({ producesArtifacts: true, runsCommands: true }, counters({ filesChanged: 3 }), 3);
      expect(reason).toContain('ran 0 commands');
      expect(reason).not.toContain('changed 0 files');
    });

    test('absent counters stay unknown here too', () => {
      expect(stageEvidenceFailure({ runsCommands: true }, null)).toBeNull();
    });
  });

  // The mirror of producesArtifacts. A QA stage reported "I did not mutate the
  // repo under test" having patched the module through the shell — invisible to
  // `filesChanged`, which is why this is judged on the snapshot alone.
  describe('readOnly', () => {
    test('fails a validator that edited what it was validating', () => {
      const reason = stageEvidenceFailure({ readOnly: true, runsCommands: true }, counters({ commandsRun: 51 }), 2);
      expect(reason).toContain('changed 2 file(s) in a read-only stage');
    });

    test('passes when it inspected and reported without touching anything', () => {
      expect(stageEvidenceFailure({ readOnly: true, runsCommands: true }, counters({ commandsRun: 11 }), 0)).toBeNull();
    });

    test('is judged on the snapshot, not the counters', () => {
      // Counters say nothing changed; the disk says otherwise. The disk wins,
      // because the shell edit never reaches a counter.
      const reason = stageEvidenceFailure({ readOnly: true }, counters({ filesChanged: 0 }), 3);
      expect(reason).toContain('read-only');
    });

    test('no snapshot means unknown, not innocent — and not guilty either', () => {
      expect(stageEvidenceFailure({ readOnly: true }, counters(), null)).toBeNull();
    });
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

  describe('runsCommands', () => {
    const withExecutor = [
      ...shipped,
      { name: 'Testing', topic: 'qa', toolIds: [], requiresApproval: false, runsCommands: true },
    ];

    test('adds the declaration to an install seeded before the flag existed', () => {
      const stored = [{ name: 'Testing', topic: 'qa', toolIds: [], requiresApproval: false }];
      const { steps, changed } = planProducesArtifactsBackfill(stored, withExecutor);
      expect(changed).toBe(true);
      expect(steps[0].runsCommands).toBe(true);
    });

    test('preserves an explicit false and stays idempotent', () => {
      const optedOut = [{ name: 'Testing', topic: 'qa', toolIds: [], requiresApproval: false, runsCommands: false }];
      expect(planProducesArtifactsBackfill(optedOut, withExecutor).changed).toBe(false);

      const stored = [{ name: 'Testing', topic: 'qa', toolIds: [], requiresApproval: false }];
      const once = planProducesArtifactsBackfill(stored, withExecutor);
      expect(planProducesArtifactsBackfill(once.steps, withExecutor).changed).toBe(false);
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
    await expect(call({ declared: { producesArtifacts: true }, counters: counters({ toolCalls: 7 }) })).rejects.toThrow(/changed 0 files/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'side_effect', passed: false, stage: 'Implementation' });
    spy.mockRestore();
  });

  test('passes and records evidence when the stage wrote a file', async () => {
    const { rows, spy, call } = setup();
    await call({ declared: { producesArtifacts: true }, counters: counters({ filesChanged: 2, toolCalls: 5 }) });
    expect(rows[0]).toMatchObject({ kind: 'side_effect', passed: true });
    expect((rows[0].detail as { filesChanged: number }).filesChanged).toBe(2);
    spy.mockRestore();
  });

  test('an undeclared stage is not gated and writes no row at all', async () => {
    const { rows, spy, call } = setup();
    await call({ declared: undefined, counters: counters() });
    expect(rows).toHaveLength(0);
    spy.mockRestore();
  });

  test('absent counters pass, but the gap is recorded rather than silently zeroed', async () => {
    const { rows, spy, call } = setup();
    await call({ declared: { producesArtifacts: true }, counters: null });
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
    await call({ declared: { producesArtifacts: true }, counters: counters({ filesChanged: 1 }) });
    // … and still fails a bad one.
    await expect(call({ declared: { producesArtifacts: true }, counters: counters() })).rejects.toThrow();
    spy.mockRestore();
  });
});
