/**
 * Per-item acceptance criteria: the QA verdict must account for each one, a
 * pass that reports one unmet goes back to the builder, and the attempt
 * ledger remembers which attempt came closest.
 */
import { describe, expect, test, vi } from 'vitest';
import { verificationEvidenceRepository } from '@/db/repositories/verification-evidence-repository';
import { normalizeAcceptance } from '@/tools/plan';
import { attemptFromVerdict, bestAttempt, describeBestAttempt, type QaAttempt } from './attempt-ledger';
import { criteriaReasons, matchCriteria, unmetCriteria } from './audit-coverage';
import {
  noteReviewModel,
  normalizeCriteria,
  PipelineManager,
  qaCriteriaInstruction,
  qaVerdictCorrectionInput,
  withQaVerdictContract,
} from './pipeline-manager';
import type { QAValidationResult } from './types';

const CRITERIA = ['npm test passes', 'GET /users/:id returns 404 for an unknown id'];

const verdict = (over: Partial<QAValidationResult> = {}): QAValidationResult => ({
  passed: true, issues: [], feedback: '', retryCount: 0, source: 'json', ...over,
});

describe('matchCriteria / criteriaReasons / unmetCriteria', () => {
  test('matches paraphrased criteria by text, either direction', () => {
    const v = verdict({ criteria: [
      { criterion: 'GET /users/:id returns 404 for an unknown id (checked with curl)', met: true, evidence: 'curl → 404' },
      { criterion: 'npm test', met: true, evidence: 'exit 0' },
    ] });
    expect(matchCriteria(v, CRITERIA).every(({ entry }) => entry)).toBe(true);
    expect(criteriaReasons(v, CRITERIA)).toEqual([]);
  });

  test('falls back to position when the counts line up and the text does not', () => {
    const v = verdict({ criteria: [
      { criterion: '1', met: true, evidence: 'exit 0' },
      { criterion: '2', met: true, evidence: 'curl → 404' },
    ] });
    expect(criteriaReasons(v, CRITERIA)).toEqual([]);
  });

  test('a numbered entry is not matched by a digit inside another criterion', () => {
    const acceptance = ['npm test passes', 'GET /users/1 returns 404'];
    const v = verdict({ criteria: [
      { criterion: '1', met: true, evidence: 'exit 0' },
      { criterion: '2', met: false, evidence: 'returns 500' },
    ] });
    expect(unmetCriteria(v, acceptance)).toEqual(['GET /users/1 returns 404']);
  });

  test('one entry answers one criterion, never several', () => {
    const acceptance = ['npm test passes', 'npm test --coverage reports at least 80%'];
    const v = verdict({ criteria: [{ criterion: 'npm test passes', met: true, evidence: 'exit 0' }] });
    const matched = matchCriteria(v, acceptance);
    expect(matched[0].entry).toBeDefined();
    expect(matched[1].entry).toBeUndefined();
    expect(criteriaReasons(v, acceptance).join(' ')).toContain('coverage');
  });

  test('position fills only the entry nothing else claimed', () => {
    const acceptance = ['npm test passes', 'tsc has no errors'];
    const v = verdict({ criteria: [
      { criterion: 'tsc has no errors', met: true, evidence: 'exit 0' },
      { criterion: 'unit suite green', met: false, evidence: '3 failures' },
    ] });
    // The tsc entry is taken by its own criterion, so it cannot also stand in
    // for "npm test passes" by position: that one is unreported, not met.
    expect(matchCriteria(v, acceptance)[0].entry).toBeUndefined();
    expect(criteriaReasons(v, acceptance).join(' ')).toContain('npm test passes');
  });

  test('a pass outside the json tier cannot satisfy criteria', () => {
    expect(criteriaReasons(verdict({ source: 'inline' }), CRITERIA).join(' ')).toContain('json');
  });

  test('a pass that skips a criterion or gives no evidence is a report fault', () => {
    const v = verdict({ criteria: [{ criterion: 'npm test passes', met: true, evidence: '' }] });
    const reasons = criteriaReasons(v, CRITERIA);
    expect(reasons.join(' ')).toContain('GET /users/:id');
    expect(reasons.join(' ')).toContain('no evidence');
  });

  test('only gates passes that have criteria to answer', () => {
    expect(criteriaReasons(verdict({ passed: false }), CRITERIA)).toEqual([]);
    expect(criteriaReasons(verdict({ source: 'prose' }), [])).toEqual([]);
    expect(criteriaReasons(verdict(), [])).toEqual([]);
  });

  test('unmetCriteria names what the auditor itself said falls short', () => {
    const v = verdict({ criteria: [
      { criterion: 'npm test passes', met: true, evidence: 'exit 0' },
      { criterion: 'GET /users/:id returns 404 for an unknown id', met: false, evidence: 'returns 500' },
    ] });
    expect(unmetCriteria(v, CRITERIA)).toEqual([CRITERIA[1]]);
  });
});

describe('verdict contract and parsing', () => {
  test('the criteria section appears only when the item has criteria', () => {
    expect(qaCriteriaInstruction([])).toBe('');
    expect(withQaVerdictContract('PROMPT')).not.toContain('ACCEPTANCE CRITERIA');
    const wrapped = withQaVerdictContract('PROMPT', undefined, CRITERIA);
    expect(wrapped).toContain('1. npm test passes');
    expect(wrapped).toContain('2. GET /users/:id');
    expect(qaVerdictCorrectionInput('report', 'why', false, CRITERIA)).toContain('ACCEPTANCE CRITERIA');
  });

  test('normalizeCriteria drops entries whose status is unreadable', () => {
    expect(normalizeCriteria([
      { criterion: ' a ', met: true, evidence: ' e ' },
      { criterion: 'b', met: 'yes' },
      { met: true },
    ])).toEqual([{ criterion: 'a', met: true, evidence: 'e' }]);
    expect(normalizeCriteria('nope')).toBeUndefined();
  });

  test('normalizeAcceptance accepts a string or a list, trims and caps it', () => {
    expect(normalizeAcceptance(' one ')).toEqual(['one']);
    expect(normalizeAcceptance(['a', '', 3, ' b '])).toEqual(['a', 'b']);
    expect(normalizeAcceptance([])).toBeUndefined();
    expect(normalizeAcceptance(Array.from({ length: 30 }, (_, i) => `c${i}`))).toHaveLength(12);
  });
});

describe('PipelineManager.gateQaVerdict with acceptance criteria', () => {
  const SCOPE = [{ name: 'Implementation', producesArtifacts: true }];
  const evidence = { sessionId: 's', pipelineId: 'p', stageName: 'QA Validation' };
  const call = (v: Record<string, unknown>) => {
    const spy = vi.spyOn(verificationEvidenceRepository, 'record').mockResolvedValue(undefined as never);
    const out = `Report.\n\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;
    return (new PipelineManager() as unknown as {
      gateQaVerdict: (o: string, s: typeof SCOPE, e: typeof evidence, a: string[]) => Promise<QAValidationResult | null>;
    }).gateQaVerdict(out, SCOPE, evidence, CRITERIA).finally(() => spy.mockRestore());
  };
  const accountable = {
    passed: true, issues: [], confidence: 'high', whatIDidNotCheck: ['load'],
    feedback: 'Implementation adds the route and its tests.',
  };

  test('a pass reporting an unmet criterion becomes a real failure, not a report fault', async () => {
    const result = await call({ ...accountable, criteria: [
      { criterion: CRITERIA[0], met: true, evidence: 'exit 0' },
      { criterion: CRITERIA[1], met: false, evidence: 'returns 500' },
    ] });
    expect(result?.passed).toBe(false);
    expect(result?.auditGateFailed).toBeUndefined();
    expect(result?.issues).toContain(`Acceptance criterion not met: ${CRITERIA[1]}`);
  });

  test('a pass that leaves a criterion unreported is sent back to the auditor', async () => {
    const result = await call({ ...accountable, criteria: [{ criterion: CRITERIA[0], met: true, evidence: 'exit 0' }] });
    expect(result?.passed).toBe(false);
    expect(result?.auditGateFailed).toBe(true);
  });

  test('an alias-shaped verdict carries its criteria too', async () => {
    const result = await call({
      verdict: 'approve', blockers: [], confidence: 'high', whatIDidNotCheck: ['load'],
      summary: 'Implementation adds the route and its tests.',
      criteria: [
        { criterion: CRITERIA[0], met: true, evidence: 'exit 0' },
        { criterion: CRITERIA[1], met: false, evidence: 'returns 500' },
      ],
    });
    expect(result?.passed).toBe(false);
    expect(result?.issues).toContain(`Acceptance criterion not met: ${CRITERIA[1]}`);
  });

  test('a pass that accounts for every criterion stands', async () => {
    const result = await call({ ...accountable, criteria: [
      { criterion: CRITERIA[0], met: true, evidence: 'exit 0' },
      { criterion: CRITERIA[1], met: true, evidence: 'curl → 404' },
    ] });
    expect(result?.passed).toBe(true);
    expect(result?.criteria).toHaveLength(2);
  });
});

describe('attempt ledger', () => {
  const a = (over: Partial<QaAttempt>): QaAttempt => ({ attempt: 1, passed: false, criteriaMet: 0, criteriaTotal: 3, issues: 0, ...over });

  test('prefers a pass, then most criteria met, then fewest issues; ties go to the later attempt', () => {
    expect(bestAttempt([a({ attempt: 1, criteriaMet: 2 }), a({ attempt: 2, criteriaMet: 1 })])?.attempt).toBe(1);
    expect(bestAttempt([a({ attempt: 1, issues: 1 }), a({ attempt: 2, issues: 3 })])?.attempt).toBe(1);
    expect(bestAttempt([a({ attempt: 1, criteriaMet: 3 }), a({ attempt: 2, passed: true })])?.attempt).toBe(2);
    expect(bestAttempt([a({ attempt: 1 }), a({ attempt: 2 })])?.attempt).toBe(2);
    expect(bestAttempt([])).toBeUndefined();
  });

  test('describes an earlier, better attempt with its commit — and says nothing when the last is best', () => {
    const note = describeBestAttempt([a({ attempt: 1, criteriaMet: 2, head: 'abc1234' }), a({ attempt: 2, criteriaMet: 1, issues: 2 })]);
    expect(note).toContain('#1 (commit abc1234): 2/3 criteria met');
    expect(note).toContain('#2');
    expect(describeBestAttempt([a({ attempt: 1 }), a({ attempt: 2, criteriaMet: 1 })])).toBe('');
  });

  test('does not count an unmet criterion twice', () => {
    const v = verdict({
      passed: false,
      issues: [`Acceptance criterion not met: ${CRITERIA[1]}`],
      criteria: [{ criterion: CRITERIA[0], met: true, evidence: 'ok' }, { criterion: CRITERIA[1], met: false, evidence: '500' }],
    });
    expect(attemptFromVerdict(v, CRITERIA, 1)).toMatchObject({ criteriaMet: 1, issues: 0 });
  });

  test('builds an entry from a settled verdict', () => {
    const v = verdict({ passed: false, issues: ['x'], criteria: [{ criterion: CRITERIA[0], met: true, evidence: 'ok' }] });
    expect(attemptFromVerdict(v, CRITERIA, 2, 'def5678')).toEqual({
      attempt: 2, passed: false, criteriaMet: 1, criteriaTotal: 2, issues: 1, head: 'def5678',
    });
  });
});

describe('noteReviewModel', () => {
  test('flags the first auditor that runs on a builder model, once per run', () => {
    const ledger = { builders: new Set<string>(), warned: false };
    expect(noteReviewModel(ledger, 'opus', { auditor: true, builder: false })).toBeNull();
    noteReviewModel(ledger, 'opus', { auditor: false, builder: true });
    expect(noteReviewModel(ledger, 'sonnet', { auditor: true, builder: false })).toBeNull();
    expect(noteReviewModel(ledger, 'opus', { auditor: true, builder: false })).toBe('opus');
    expect(noteReviewModel(ledger, 'opus', { auditor: true, builder: false })).toBeNull();
    expect(noteReviewModel(ledger, undefined, { auditor: true, builder: false })).toBeNull();
  });
});
