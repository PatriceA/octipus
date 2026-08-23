import { describe, expect, it } from 'vitest';
import { auditVerdictFailure, normalizeForMatch, thinVerdictFailure, unaddressedDoubt, uncoveredStages } from './audit-coverage';
import type { QAValidationResult } from './types';

function verdict(over: Partial<QAValidationResult> = {}): QAValidationResult {
  return { passed: true, issues: [], feedback: '', retryCount: 0, ...over };
}

const A = (name: string) => ({ name, producesArtifacts: true });
const SCOPE = [A('Implementation'), A('Testing'), A('Code Review')];

describe('normalizeForMatch', () => {
  it('folds case, punctuation and whitespace to one comparable form', () => {
    expect(normalizeForMatch('**Code Review:**')).toBe('code review');
    expect(normalizeForMatch('code-review')).toBe('code review');
    expect(normalizeForMatch('  Requirements & Architecture  ')).toBe('requirements architecture');
  });

  it('yields empty for punctuation-only input', () => {
    expect(normalizeForMatch('— *** —')).toBe('');
  });
});

describe('uncoveredStages', () => {
  it('reports every stage a rubber stamp never names', () => {
    const v = verdict({ feedback: 'All stages look good.' });
    expect(uncoveredStages(v, SCOPE)).toEqual(['Implementation', 'Testing', 'Code Review']);
  });

  it('reports only the stages left out of a partial audit', () => {
    const v = verdict({ feedback: 'Implementation wrote calc/percent.ts; Testing added a spec.' });
    expect(uncoveredStages(v, SCOPE)).toEqual(['Code Review']);
  });

  it('counts a mention inside issues[], not just feedback', () => {
    const v = verdict({
      feedback: 'Implementation and Testing are fine.',
      issues: ['Code Review skipped the error path'],
    });
    expect(uncoveredStages(v, SCOPE)).toEqual([]);
  });

  it('matches across case and punctuation drift', () => {
    const v = verdict({
      feedback: 'implementation ok. **testing:** ok. code-review ok.',
    });
    expect(uncoveredStages(v, SCOPE)).toEqual([]);
  });

  it('skips a stage whose name has nothing matchable in it', () => {
    expect(uncoveredStages(verdict({ feedback: '' }), [A('***')])).toEqual([]);
  });
});

describe('auditVerdictFailure', () => {
  it('rejects a pass that names nothing', () => {
    const failure = auditVerdictFailure(verdict({ feedback: 'All stages look good.' }), SCOPE);
    expect(failure).toContain('Implementation');
    expect(failure).toContain('Testing');
    expect(failure).toContain('Code Review');
  });

  it('rejects a pass that names only some of its scope', () => {
    const failure = auditVerdictFailure(
      verdict({ feedback: 'Implementation and Testing check out.' }),
      SCOPE,
    );
    expect(failure).toContain('Code Review');
    expect(failure).not.toContain('Implementation,');
  });

  it('accepts a pass that accounts for every stage', () => {
    const v = verdict({
      feedback: 'Implementation added calc/percent.ts. Testing covers rounding. Code Review found no blockers.',
    });
    expect(auditVerdictFailure(v, SCOPE)).toBeNull();
  });

  it('accepts a pass when the scope is empty (research-only pipeline)', () => {
    expect(auditVerdictFailure(verdict({ feedback: 'Nothing to build.' }), [])).toBeNull();
  });

  it('never gates a failing verdict — it is already routing to retry', () => {
    const v = verdict({ passed: false, feedback: 'Broken.', issues: ['it throws'] });
    expect(auditVerdictFailure(v, SCOPE)).toBeNull();
  });
});

// ── Phase 2: thin-verdict rules ────────────────────────────────────────────

describe('thinVerdictFailure', () => {
  const structured = (over: Partial<QAValidationResult> = {}) =>
    verdict({ source: 'json', confidence: 'high', whatIDidNotCheck: ['perf under load'], ...over });

  it('rejects a structured pass that states nothing it left unchecked', () => {
    expect(thinVerdictFailure(structured({ whatIDidNotCheck: [] }))).toContain('did NOT check');
    expect(thinVerdictFailure(structured({ whatIDidNotCheck: undefined }))).toContain('did NOT check');
  });

  it('accepts an explicit "nothing" — the point is stating it, not having gaps', () => {
    expect(thinVerdictFailure(structured({ whatIDidNotCheck: ['nothing, the change is trivial'] }))).toBeNull();
  });

  it('rejects a structured pass with no usable confidence', () => {
    const failure = thinVerdictFailure(structured({ confidence: undefined }));
    expect(failure).toContain('confidence');
    // An honest low must read as welcome, or models learn to always say high.
    expect(failure).toContain('low');
  });

  it('names both thin faults together rather than one per retry', () => {
    const failure = thinVerdictFailure(structured({ confidence: undefined, whatIDidNotCheck: [] }));
    expect(failure).toContain('did NOT check');
    expect(failure).toContain('confidence');
  });

  it('accepts a low-confidence pass — honesty is not a failure', () => {
    expect(thinVerdictFailure(structured({ confidence: 'low' }))).toBeNull();
  });

  it('never applies to a tier that was not asked for the fields', () => {
    expect(thinVerdictFailure(verdict({ source: 'prose' }))).toBeNull();
    expect(thinVerdictFailure(verdict({ source: 'inline' }))).toBeNull();
    expect(thinVerdictFailure(verdict({ source: undefined }))).toBeNull();
  });

  it('never gates a failing verdict', () => {
    expect(thinVerdictFailure(structured({ passed: false, whatIDidNotCheck: [] }))).toBeNull();
  });
});

describe('auditVerdictFailure composes both rules', () => {
  const covered = 'Implementation ok. Testing ok. Code Review ok.';

  it('reports the coverage debt first — it is the more specific fault', () => {
    const v = verdict({ source: 'json', feedback: 'Looks good.', whatIDidNotCheck: [] });
    expect(auditVerdictFailure(v, SCOPE)).toContain('audited stage');
  });

  it('reports EVERY fault at once, so retries are not spent one gap at a time', () => {
    // Missing all three: scope coverage, whatIDidNotCheck, confidence.
    const failure = auditVerdictFailure(verdict({ source: 'json', feedback: 'Fine.' }), SCOPE);
    expect(failure).toContain('audited stage');
    expect(failure).toContain('did NOT check');
    expect(failure).toContain('confidence');
  });

  it('falls through to the thin rules once coverage is satisfied', () => {
    const v = verdict({ source: 'json', feedback: covered, whatIDidNotCheck: [] });
    expect(auditVerdictFailure(v, SCOPE)).toContain('did NOT check');
  });

  it('passes a verdict that is both accountable and non-thin', () => {
    const v = verdict({ source: 'json', feedback: covered, whatIDidNotCheck: ['load testing'], confidence: 'medium' });
    expect(auditVerdictFailure(v, SCOPE)).toBeNull();
  });
});

// ── Phase 3: doubt debt ────────────────────────────────────────────────────
// A stage that handed off saying it was unsure must be addressed even when it
// produced no artifacts and is therefore outside the coverage scope.

describe('unaddressedDoubt', () => {
  const SHAKY = { name: 'Requirements & Architecture', confidence: 'low' as const };
  const SCOPE_WITH_DOUBT = [...SCOPE, SHAKY];

  it('flags a low-confidence non-producer the verdict passed over', () => {
    const v = verdict({ feedback: 'Implementation, Testing and Code Review all fine.' });
    expect(unaddressedDoubt(v, SCOPE_WITH_DOUBT)).toEqual(['Requirements & Architecture']);
  });

  it('is satisfied once the verdict names it', () => {
    const v = verdict({ feedback: 'Requirements & Architecture was thin, so I re-derived the API shape.' });
    expect(unaddressedDoubt(v, SCOPE_WITH_DOUBT)).toEqual([]);
  });

  it('does NOT accept it being named only in whatIDidNotCheck', () => {
    // jcode's sharp edge: declaring "I did not check X" is the opposite of
    // addressing X. Locked in with a test so a future change that folds
    // whatIDidNotCheck into the haystack fails loudly instead of silently.
    const v = verdict({ feedback: 'All good.', whatIDidNotCheck: ['Requirements & Architecture'] });
    expect(unaddressedDoubt(v, SCOPE_WITH_DOUBT)).toEqual(['Requirements & Architecture']);
  });

  it('ignores stages that stated medium, high, or nothing at all', () => {
    const quiet = [{ name: 'Design', confidence: 'medium' as const }, { name: 'Spike' }];
    expect(unaddressedDoubt(verdict({ feedback: '' }), quiet)).toEqual([]);
  });

  it('does not double-report a producer — the coverage rule already has it', () => {
    const shakyProducer = [{ name: 'Implementation', producesArtifacts: true, confidence: 'low' as const }];
    expect(unaddressedDoubt(verdict({ feedback: '' }), shakyProducer)).toEqual([]);
  });

  it('never gates a failing verdict', () => {
    const v = verdict({ passed: false, feedback: '' });
    expect(auditVerdictFailure(v, SCOPE_WITH_DOUBT)).toBeNull();
  });

  it('rejects the pass through auditVerdictFailure, naming the doubtful stage', () => {
    const v = verdict({
      source: 'json',
      feedback: 'Implementation ok. Testing ok. Code Review ok.',
      whatIDidNotCheck: ['load'],
      confidence: 'high',
    });
    const failure = auditVerdictFailure(v, SCOPE_WITH_DOUBT);
    expect(failure).toContain('LOW confidence');
    expect(failure).toContain('Requirements & Architecture');
  });
});
