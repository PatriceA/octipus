/**
 * The audit-coverage gate as wired into the run loops — an auditor's PASS is
 * downgraded to a retry when it cannot account for the stages it covered.
 *
 * Companion to `pipeline-evidence-gate.test.ts`: that one gates the producer
 * (a stage that declared artifacts and wrote none), this one gates the auditor
 * (a stage that reviewed the work and named nothing).
 */
import { describe, expect, test, vi } from 'vitest';
import { verificationEvidenceRepository } from '@/db/repositories/verification-evidence-repository';
import { auditFault } from './audit-coverage';
import { auditScopeBefore, handoffConfidenceByStage, PipelineManager } from './pipeline-manager';
import type { QAValidationResult } from './types';

describe('auditScopeBefore', () => {
  const names = ['Research', 'Implementation', 'Testing', 'QA Validation'];
  const declared = [undefined, true, true, undefined];

  test('scopes an auditor to the earlier stages that DECLARED artifacts', () => {
    expect(auditScopeBefore(3, names, declared)).toEqual([
      { name: 'Implementation', producesArtifacts: true, confidence: undefined },
      { name: 'Testing', producesArtifacts: true, confidence: undefined },
    ]);
  });

  test('never includes the auditor itself or anything after it', () => {
    expect(auditScopeBefore(2, names, declared)).toEqual([
      { name: 'Implementation', producesArtifacts: true, confidence: undefined },
    ]);
  });

  test('is empty for a research-only pipeline — nothing to enumerate', () => {
    expect(auditScopeBefore(2, ['Research', 'Summary'], [undefined, undefined])).toEqual([]);
  });

  test('is empty for the first stage', () => {
    expect(auditScopeBefore(0, names, declared)).toEqual([]);
  });

  test('tolerates a producesArtifacts array shorter than the stage list', () => {
    expect(auditScopeBefore(3, names, [undefined, true])).toEqual([
      { name: 'Implementation', producesArtifacts: true, confidence: undefined },
    ]);
  });

  test('pulls in a low-confidence stage even though it produced no artifacts', () => {
    const conf = new Map<number, 'high' | 'medium' | 'low'>([[0, 'low']]);
    expect(auditScopeBefore(3, names, declared, conf)).toEqual([
      { name: 'Research', producesArtifacts: false, confidence: 'low' },
      { name: 'Implementation', producesArtifacts: true, confidence: undefined },
      { name: 'Testing', producesArtifacts: true, confidence: undefined },
    ]);
  });

  test('leaves a confident non-producer out — only doubt earns a place', () => {
    const conf = new Map<number, 'high' | 'medium' | 'low'>([[0, 'high']]);
    expect(auditScopeBefore(3, names, declared, conf).map((s) => s.name)).toEqual([
      'Implementation',
      'Testing',
    ]);
  });
});

describe('handoffConfidenceByStage', () => {
  const h = (stageIndex: number | undefined, confidence?: 'high' | 'medium' | 'low') =>
    ({ from: { role: 'r', stageName: 'Stage', stageIndex }, confidence }) as unknown as Parameters<
      typeof handoffConfidenceByStage
    >[0][number];

  test('keys each stage to what it said about itself', () => {
    const map = handoffConfidenceByStage([h(0, 'low'), h(1, 'high')]);
    expect(map.get(0)).toBe('low');
    expect(map.get(1)).toBe('high');
  });

  test('skips handoffs with no stated confidence or no stage index', () => {
    expect(handoffConfidenceByStage([h(0), h(undefined, 'low')]).size).toBe(0);
  });

  test('keeps same-named stages apart — a recipe may reuse a name', () => {
    // Keyed by name, the later `high` would erase the earlier `low` and the
    // doubt would be lost; keyed by index, both survive.
    const map = handoffConfidenceByStage([h(2, 'low'), h(4, 'high')]);
    expect(map.get(2)).toBe('low');
    expect(map.get(4)).toBe('high');
  });

  test('a duplicate stage name does not leak confidence between occurrences', () => {
    const names = ['Code Review', 'Implementation', 'Code Review', 'QA'];
    const declared = [undefined, true, undefined, undefined];
    const conf = handoffConfidenceByStage([h(0, 'low'), h(2, 'high')]);
    const scope = auditScopeBefore(3, names, declared, conf);
    // Index 0 keeps its doubt; index 2 is confident and stays out.
    expect(scope).toEqual([
      { name: 'Code Review', producesArtifacts: false, confidence: 'low' },
      { name: 'Implementation', producesArtifacts: true, confidence: undefined },
    ]);
  });
});

// ── Which rejection a verdict repair may fix ────────────────────────────────

describe('auditFault — one row per gate reason', () => {
  const SCOPE = [{ name: 'Implementation', producesArtifacts: true }];
  const AC = ['returns 0 for empty input', 'rejects negatives'];
  const full = {
    passed: true,
    issues: [],
    feedback: 'Implementation checked end to end.',
    retryCount: 0,
    confidence: 'high' as const,
    whatIDidNotCheck: ['performance'],
    source: 'json' as const,
    criteria: AC.map((criterion) => ({ criterion, met: true, evidence: 'npm test exit 0' })),
  };
  const v = (over: Partial<QAValidationResult>): QAValidationResult => ({ ...full, ...over });

  test.each<[string, QAValidationResult, string[], boolean, 'coverage' | 'report' | null]>([
    ['an accountable pass', v({}), AC, false, null],
    ['a failing verdict', v({ passed: false }), AC, false, null],
    ['missing whatIDidNotCheck only', v({ whatIDidNotCheck: [] }), AC, false, 'report'],
    ['missing confidence only', v({ confidence: undefined }), AC, false, 'report'],
    ['an uncovered stage', v({ feedback: 'Looks fine.' }), AC, false, 'coverage'],
    ['a criterion with no entry', v({ criteria: [full.criteria[0]] }), AC, false, 'coverage'],
    ['a met criterion with no evidence', v({ criteria: [full.criteria[0], { criterion: AC[1], met: true, evidence: '' }] }), AC, false, 'coverage'],
    ['a non-json pass on an item with criteria', v({ source: 'prose', criteria: undefined }), AC, false, 'coverage'],
    ['a thin pass whose prose says FAIL', v({ whatIDidNotCheck: [] }), AC, true, 'coverage'],
    ['a thin pass AND an unreported criterion', v({ whatIDidNotCheck: [], criteria: undefined }), AC, false, 'coverage'],
  ])('%s', (_name, verdict, acceptance, proseFail, expected) => {
    expect(auditFault(verdict, SCOPE, acceptance, proseFail)).toBe(expected);
  });

  test('a low-confidence stage the verdict ignores is coverage', () => {
    const scope = [...SCOPE, { name: 'Research', producesArtifacts: false, confidence: 'low' as const }];
    expect(auditFault(v({}), scope, AC)).toBe('coverage');
  });
});

// ── The gate as wired (parse → ledger write → downgrade) ────────────────────

describe('PipelineManager.gateQaVerdict', () => {
  const SCOPE = [
    { name: 'Implementation', producesArtifacts: true },
    { name: 'Testing', producesArtifacts: true },
  ];
  const evidence = { sessionId: 's', pipelineId: 'p', stageName: 'QA Validation' };

  const setup = () => {
    const rows: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(verificationEvidenceRepository, 'record').mockImplementation(async (r) => {
      rows.push(r as Record<string, unknown>);
      return r as never;
    });
    // Private by design — reached the way the run loops reach it.
    const call = (output: string, scope = SCOPE) =>
      (new PipelineManager() as unknown as {
        gateQaVerdict: (o: string, s: typeof SCOPE, e: typeof evidence) => Promise<QAValidationResult | null>;
      }).gateQaVerdict(output, scope, evidence);
    const auditRows = () => rows.filter((r) => r.kind === 'audit_coverage');
    return { rows, auditRows, spy, call };
  };

  const verdictBlock = (v: Record<string, unknown>) => `Report text.\n\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;

  test('downgrades a rubber stamp to a retry, flagged as an audit-gate failure', async () => {
    const { auditRows, spy, call } = setup();
    const result = await call(verdictBlock({ passed: true, issues: [], feedback: 'All stages look good.' }));

    expect(result?.passed).toBe(false);
    expect(result?.auditGateFailed).toBe(true);
    expect(result?.feedback).toContain('rejected');
    // The complaint names what was missed, so the re-ask is actionable.
    expect(result?.issues.join(' ')).toContain('Implementation');
    expect(result?.issues.join(' ')).toContain('Testing');

    expect(auditRows()[0]).toMatchObject({ kind: 'audit_coverage', passed: false, stage: 'QA Validation' });
    expect((auditRows()[0].detail as { uncovered: string[] }).uncovered).toEqual(['Implementation', 'Testing']);
    spy.mockRestore();
  });

  test('lets an accountable pass through untouched', async () => {
    const { auditRows, spy, call } = setup();
    const result = await call(
      verdictBlock({
        passed: true,
        issues: [],
        feedback: 'Implementation added calc/percent.ts; Testing covers the rounding path.',
        confidence: 'high',
        whatIDidNotCheck: ['performance under load'],
      }),
    );

    expect(result?.passed).toBe(true);
    expect(result?.auditGateFailed).toBeUndefined();
    expect(auditRows()[0]).toMatchObject({ kind: 'audit_coverage', passed: true, confidence: 'high' });
    spy.mockRestore();
  });

  test('does not gate a failing verdict, and writes no audit row for it', async () => {
    const { auditRows, spy, call } = setup();
    const result = await call(verdictBlock({ passed: false, issues: ['it throws'], feedback: 'Broken.' }));

    expect(result?.passed).toBe(false);
    expect(result?.auditGateFailed).toBeUndefined();
    expect(auditRows()).toHaveLength(0);
    spy.mockRestore();
  });

  test('a research-only pipeline (empty scope) still passes', async () => {
    const { spy, call } = setup();
    const result = await call(
      verdictBlock({
        passed: true,
        issues: [],
        feedback: 'Nothing to build.',
        confidence: 'high',
        whatIDidNotCheck: ['nothing — no artifacts were produced'],
      }),
      [],
    );
    expect(result?.passed).toBe(true);
    spy.mockRestore();
  });

  test('rejects an accountable pass that never states what it did not check', async () => {
    const { auditRows, spy, call } = setup();
    const result = await call(
      verdictBlock({
        passed: true,
        issues: [],
        feedback: 'Implementation and Testing are both fine.',
        confidence: 'high',
      }),
    );

    expect(result?.passed).toBe(false);
    expect(result?.auditGateFailed).toBe(true);
    expect(result?.issues.join(' ')).toContain('did NOT check');
    expect(auditRows()[0]).toMatchObject({ passed: false });
    spy.mockRestore();
  });

  test('rejects an accountable pass that states no confidence', async () => {
    const { spy, call } = setup();
    const result = await call(
      verdictBlock({
        passed: true,
        issues: [],
        feedback: 'Implementation and Testing are both fine.',
        whatIDidNotCheck: ['the CLI path'],
      }),
    );
    expect(result?.passed).toBe(false);
    expect(result?.issues.join(' ')).toContain('confidence');
    spy.mockRestore();
  });

  test('a prose-tier pass is still coverage-gated but exempt from the thin rules', async () => {
    const { auditRows, spy, call } = setup();
    // No JSON block at all — tier 3. It names its scope, so coverage is met;
    // it cannot carry whatIDidNotCheck because it was never asked for one.
    const covered = await call('Implementation and Testing both look right.\n\nOverall status: PASS');
    expect(covered?.passed).toBe(true);
    expect((auditRows()[0].detail as { source: string }).source).toBe('prose');

    const stamped = await call('Everything looks great.\n\nOverall status: PASS');
    expect(stamped?.passed).toBe(false);
    expect(stamped?.auditGateFailed).toBe(true);
    spy.mockRestore();
  });

  test('accepts a capitalised confidence — casing must not fail an accountable audit', async () => {
    const { spy, call } = setup();
    const result = await call(
      verdictBlock({
        passed: true,
        issues: [],
        feedback: 'Implementation and Testing are both accounted for.',
        confidence: 'High',
        whatIDidNotCheck: ['the migration path'],
      }),
    );
    expect(result?.passed).toBe(true);
    spy.mockRestore();
  });

  test('an inline-tier pass falls back to the report when no feedback field parses', async () => {
    const { spy, call } = setup();
    // Malformed JSON (trailing comma) → tier 2. No usable "feedback" field,
    // so the report itself must become the haystack, else an honest audit
    // that names its scope gets rejected for naming nothing.
    const result = await call(
      'Implementation and Testing were both reviewed.\n```json\n{"passed": true, "issues": [],}\n```',
    );
    expect(result?.passed).toBe(true);
    spy.mockRestore();
  });

  test('accepts a bare-string whatIDidNotCheck — that is answering the question', async () => {
    const { spy, call } = setup();
    const result = await call(
      verdictBlock({
        passed: true,
        issues: [],
        feedback: 'Implementation and Testing are accounted for.',
        confidence: 'low',
        whatIDidNotCheck: 'nothing, the diff is three lines',
      }),
    );
    // An honest `low` must not itself be a failure, or models learn to lie.
    expect(result?.passed).toBe(true);
    spy.mockRestore();
  });

  test('rejects a pass that walks past a stage which said it was unsure', async () => {
    const { auditRows, spy, call } = setup();
    const withDoubt = [
      ...SCOPE,
      { name: 'Requirements & Architecture', producesArtifacts: false, confidence: 'low' as const },
    ];
    const result = await call(
      verdictBlock({
        passed: true,
        issues: [],
        feedback: 'Implementation and Testing both check out.',
        confidence: 'high',
        // Naming it here must NOT discharge the doubt — that is the point.
        whatIDidNotCheck: ['Requirements & Architecture'],
      }),
      withDoubt,
    );

    expect(result?.passed).toBe(false);
    expect(result?.issues.join(' ')).toContain('LOW confidence');
    expect((auditRows()[0].detail as { unaddressedDoubt: string[] }).unaddressedDoubt).toEqual([
      'Requirements & Architecture',
    ]);
    spy.mockRestore();
  });

  // Previously this returned null, which callers read as "no QA signal" and
  // skipped the retry loop — so an auditor could opt itself out of being audited
  // by simply not answering. Measured: a QA stage ended with a prose
  // "**Verdict:** implementation is correct" instead of the requested JSON, no
  // `audit_coverage` row was written, and the pipeline went green on a verdict
  // nobody had checked.
  test('an unreadable verdict is an audit-gate FAILURE, not an absence of one', async () => {
    const { spy, call, auditRows } = setup();
    const result = await call('Just some prose with no verdict in it whatsoever.');

    expect(result?.passed).toBe(false);
    // Auditor-only retry: the deliverable may be fine, it is the REPORT that is
    // unusable, so re-running the implementation would burn a run on good work.
    expect(result?.auditGateFailed).toBe(true);
    expect(result?.feedback).toContain('no machine-readable verdict');

    const [row] = auditRows();
    expect(row).toMatchObject({ kind: 'audit_coverage', passed: false });
    expect((row.detail as { source: string }).source).toBe('unparseable');
    spy.mockRestore();
  });

  // Which rejections a verdict repair may fix. Getting this wrong in either
  // direction is costly: a coverage fault sent to repair can only re-word, and
  // a missing field sent to a full re-audit pays for the audit twice.
  test('a covered pass missing only a required field is a REPORT fault', async () => {
    const { auditRows, spy, call } = setup();
    const result = await call(
      verdictBlock({ passed: true, issues: [], feedback: 'Implementation and Testing are both fine.', confidence: 'high' }),
    );
    expect(result).toMatchObject({ passed: false, auditGateFailed: true, auditGateReason: 'report' });
    expect(auditRows()[0].detail).toMatchObject({ fault: 'report' });
    spy.mockRestore();
  });

  test('an uncovered stage makes it a COVERAGE fault, even with fields missing too', async () => {
    const { auditRows, spy, call } = setup();
    const result = await call(verdictBlock({ passed: true, issues: [], feedback: 'Implementation is fine.' }));
    expect(result).toMatchObject({ auditGateFailed: true, auditGateReason: 'coverage' });
    // Every reason still reaches the re-audit at once.
    expect(result?.issues.join(' ')).toContain('Testing');
    expect(result?.issues.join(' ')).toContain('did NOT check');
    expect(auditRows()[0].detail).toMatchObject({ fault: 'coverage' });
    spy.mockRestore();
  });

  test('an unreadable verdict is tagged a report fault, and a repair attempt is recorded', async () => {
    const { auditRows, spy } = setup();
    const result = await (new PipelineManager() as unknown as {
      gateQaVerdict: (o: string, s: typeof SCOPE, e: typeof evidence & { repairAttempt?: number }) => Promise<QAValidationResult | null>;
    }).gateQaVerdict('Prose only.', SCOPE, { ...evidence, repairAttempt: 2 });
    expect(result).toMatchObject({ auditGateReason: 'unparseable' });
    expect(auditRows()[0].detail).toMatchObject({ source: 'unparseable', fault: 'report', repairAttempt: 2 });
    spy.mockRestore();
  });

  test('a pass whose own prose says FAIL is never repaired — it is re-judged', async () => {
    const { auditRows, spy, call } = setup();
    const result = await call(
      `Overall status: FAIL\n\n${verdictBlock({ passed: true, issues: [], feedback: 'Implementation and Testing are fine.', confidence: 'high' })}`,
    );
    expect(result).toMatchObject({ auditGateFailed: true, auditGateReason: 'coverage' });
    expect(auditRows()[0].detail).toMatchObject({ fault: 'coverage' });
    spy.mockRestore();
  });

  test('an accepted pass carries no fault', async () => {
    const { auditRows, spy, call } = setup();
    await call(
      verdictBlock({
        passed: true,
        issues: [],
        feedback: 'Implementation and Testing both check out.',
        confidence: 'high',
        whatIDidNotCheck: ['the migration path'],
      }),
    );
    expect((auditRows()[0].detail as Record<string, unknown>).fault).toBeUndefined();
    spy.mockRestore();
  });

  test('a ledger failure never breaks the run, and never masks the gate verdict', async () => {
    const spy = vi.spyOn(verificationEvidenceRepository, 'record').mockImplementation(async () => {
      throw new Error('db down');
    });
    const call = (output: string) =>
      (new PipelineManager() as unknown as {
        gateQaVerdict: (o: string, s: typeof SCOPE, e: typeof evidence) => Promise<QAValidationResult | null>;
      }).gateQaVerdict(output, SCOPE, evidence);

    const stamped = await call(verdictBlock({ passed: true, issues: [], feedback: 'Looks fine.' }));
    expect(stamped?.passed).toBe(false);
    const accounted = await call(
      verdictBlock({
        passed: true,
        issues: [],
        feedback: 'Implementation and Testing both check out.',
        confidence: 'medium',
        whatIDidNotCheck: ['integration with the live DB'],
      }),
    );
    expect(accounted?.passed).toBe(true);
    spy.mockRestore();
  });
});
