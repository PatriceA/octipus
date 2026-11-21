/** The pure decisions behind merging and surfacing skill proposals (database paths: skill-proposal-consolidation.test.ts). */
import { describe, expect, test } from 'vitest';
import {
  appendSourceRefs,
  candidateIsRecurring,
  initialProposalStatus,
  interpretMergeReply,
  MAX_MERGED_CONTENT_CHARS,
  MAX_SOURCE_REFS,
  strongerSignal,
} from './skill-proposal-merge';

describe('initialProposalStatus', () => {
  test('manual, a correction, or the gate off ⇒ pending; otherwise a candidate', () => {
    expect(initialProposalStatus({ origin: 'manual', recurrenceSessions: 2 })).toBe('pending');
    expect(initialProposalStatus({ origin: 'learning', signal: 'correction', recurrenceSessions: 2 })).toBe('pending');
    expect(initialProposalStatus({ origin: 'learning', signal: 'procedure', recurrenceSessions: 1 })).toBe('pending');
    expect(initialProposalStatus({ origin: 'learning', signal: 'recovery', recurrenceSessions: 2 })).toBe('candidate');
    expect(initialProposalStatus({ origin: 'learning', recurrenceSessions: 2 })).toBe('candidate');
  });
});

describe('candidateIsRecurring', () => {
  test('two sessions or a correction', () => {
    expect(candidateIsRecurring({ sourceRefs: ['learning:a:session:s1', 'learning:b:session:s1'], signal: 'procedure' }, 2)).toBe(false);
    expect(candidateIsRecurring({ sourceRefs: ['learning:a:session:s1', 'learning:b:session:s2'], signal: null }, 2)).toBe(true);
    expect(candidateIsRecurring({ sourceRefs: ['learning:a:session:s1'], signal: 'correction' }, 2)).toBe(true);
  });
});

describe('strongerSignal', () => {
  test('correction > recovery > procedure > none', () => {
    expect(strongerSignal('procedure', 'correction')).toBe('correction');
    expect(strongerSignal('recovery', 'procedure')).toBe('recovery');
    expect(strongerSignal(null, 'procedure')).toBe('procedure');
    expect(strongerSignal('recovery', undefined)).toBe('recovery');
    expect(strongerSignal(null, null)).toBeNull();
  });
});

describe('appendSourceRefs', () => {
  test('appends newest last and keeps the newest 50', () => {
    expect(appendSourceRefs(['a'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
    const many = Array.from({ length: MAX_SOURCE_REFS }, (_, i) => `r${i}`);
    const next = appendSourceRefs(many, ['new']);
    expect(next).toHaveLength(MAX_SOURCE_REFS);
    expect(next[0]).toBe('r1');
    expect(next.at(-1)).toBe('new');
  });
});

describe('interpretMergeReply', () => {
  const json = (o: unknown) => JSON.stringify(o);

  test('a merged reply is PII-filtered and capped', () => {
    const out = interpretMergeReply(json({ verdict: 'merged', description: 'Mail ops@example.com', content: 'x'.repeat(MAX_MERGED_CONTENT_CHARS + 50) }), 'stop', false);
    expect(out.kind).toBe('merged');
    if (out.kind !== 'merged') return;
    expect(out.description).not.toContain('ops@example.com');
    expect(out.content).toHaveLength(MAX_MERGED_CONTENT_CHARS);
  });

  test('distinct only counts with allowDistinct; otherwise it is read as unchanged', () => {
    const distinct = json({ verdict: 'distinct', description: '', content: '' });
    expect(interpretMergeReply(distinct, 'stop', true)).toEqual({ kind: 'distinct' });
    expect(interpretMergeReply(distinct, 'stop', false)).toEqual({ kind: 'unchanged' });
    expect(interpretMergeReply(json({ verdict: 'unchanged', description: '', content: '' }), 'stop', false)).toEqual({ kind: 'unchanged' });
  });

  test('truncated and malformed replies are failures, not verdicts', () => {
    expect(interpretMergeReply(json({ verdict: 'merged', description: 'd', content: 'c' }), 'length', false)).toEqual({ kind: 'truncated' });
    expect(interpretMergeReply('no json here', 'stop', false).kind).toBe('malformed');
    expect(interpretMergeReply('{"verdict":', 'stop', false).kind).toBe('malformed');
    expect(interpretMergeReply(json({ verdict: 'maybe', description: '', content: '' }), 'stop', false).kind).toBe('malformed');
    expect(interpretMergeReply(json({ verdict: 'merged', description: '', content: 'c' }), 'stop', false).kind).toBe('malformed');
  });
});
