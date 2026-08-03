/**
 * The audit-coverage gate as wired into the run loops — an auditor's PASS is
 * downgraded to a retry when it cannot account for the stages it covered.
 *
 * Companion to `pipeline-evidence-gate.test.ts`: that one gates the producer
 * (a stage that declared artifacts and wrote none), this one gates the auditor
 * (a stage that reviewed the work and named nothing).
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { verificationEvidenceRepository } from '@/db/repositories/verification-evidence-repository';
import { auditScopeBefore, PipelineManager } from './pipeline-manager';
import type { QAValidationResult } from './types';

describe('auditScopeBefore', () => {
  const names = ['Research', 'Implementation', 'Testing', 'QA Validation'];
  const declared = [undefined, true, true, undefined];

  test('scopes an auditor to the earlier stages that DECLARED artifacts', () => {
    expect(auditScopeBefore(3, names, declared)).toEqual([{ name: 'Implementation' }, { name: 'Testing' }]);
  });

  test('never includes the auditor itself or anything after it', () => {
    expect(auditScopeBefore(2, names, declared)).toEqual([{ name: 'Implementation' }]);
  });

  test('is empty for a research-only pipeline — nothing to enumerate', () => {
    expect(auditScopeBefore(2, ['Research', 'Summary'], [undefined, undefined])).toEqual([]);
  });

  test('is empty for the first stage', () => {
    expect(auditScopeBefore(0, names, declared)).toEqual([]);
  });

  test('tolerates a producesArtifacts array shorter than the stage list', () => {
    expect(auditScopeBefore(3, names, [undefined, true])).toEqual([{ name: 'Implementation' }]);
  });
});

// ── The gate as wired (parse → ledger write → downgrade) ────────────────────

describe('PipelineManager.gateQaVerdict', () => {
  const SCOPE = [{ name: 'Implementation' }, { name: 'Testing' }];
  const evidence = { sessionId: 's', pipelineId: 'p', stageName: 'QA Validation' };

  const setup = () => {
    const rows: Array<Record<string, unknown>> = [];
    const spy = spyOn(verificationEvidenceRepository, 'record').mockImplementation(async (r) => {
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

  test('returns null when the output carries no verdict at all', async () => {
    const { spy, call } = setup();
    expect(await call('Just some prose with no verdict in it whatsoever.')).toBeNull();
    spy.mockRestore();
  });

  test('a ledger failure never breaks the run, and never masks the gate verdict', async () => {
    const spy = spyOn(verificationEvidenceRepository, 'record').mockImplementation(async () => {
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
