import { describe, expect, it } from 'bun:test';
import { auditVerdictFailure, normalizeForMatch, uncoveredStages } from './audit-coverage';
import type { QAValidationResult } from './types';

function verdict(over: Partial<QAValidationResult> = {}): QAValidationResult {
  return { passed: true, issues: [], feedback: '', retryCount: 0, ...over };
}

const SCOPE = [{ name: 'Implementation' }, { name: 'Testing' }, { name: 'Code Review' }];

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
    expect(uncoveredStages(verdict({ feedback: '' }), [{ name: '***' }])).toEqual([]);
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
