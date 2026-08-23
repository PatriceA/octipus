import { describe, expect, test } from 'vitest';
import { parseResolverMatch, selectCandidates } from './link-resolver';

/**
 * Pure halves of the ghost-link resolver: the pair-resolver verdict parser and
 * the blocking step. Both decide whether a *wrong* edge gets written, so the
 * cases here are mostly about refusing to guess.
 */

const hit = (id: string, similarity: number, title?: string) => ({
  sourceId: `note:${id}`,
  similarity,
  metadata: title === undefined ? {} : { title },
});

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const SELF = '99999999-9999-4999-8999-999999999999';

describe('parseResolverMatch', () => {
  test('accepts a candidate number in range', () => {
    expect(parseResolverMatch('{"match": 2}', 3)).toBe(2);
    expect(parseResolverMatch('{"match": "1"}', 3)).toBe(1); // small models answer with strings
    expect(parseResolverMatch('```json\n{"match": 3}\n```', 3)).toBe(3);
  });

  test('null verdict means "no candidate is the same thing"', () => {
    expect(parseResolverMatch('{"match": null}', 3)).toBeNull();
  });

  test('refuses out-of-range, malformed, and prose answers', () => {
    expect(parseResolverMatch('{"match": 0}', 3)).toBeNull();
    expect(parseResolverMatch('{"match": 4}', 3)).toBeNull();
    expect(parseResolverMatch('{"match": 1.5}', 3)).toBeNull();
    expect(parseResolverMatch('{"match": true}', 3)).toBeNull();
    expect(parseResolverMatch('Candidate 1 looks right!', 3)).toBeNull();
    expect(parseResolverMatch('', 3)).toBeNull();
    expect(parseResolverMatch('{"match": 1}', 0)).toBeNull();
  });
});

describe('selectCandidates', () => {
  test('collapses chunk hits to distinct notes, best score first, capped at 3', () => {
    const out = selectCandidates(
      [
        hit(A, 0.9, 'Octipus architecture overview'),
        hit(A, 0.8, 'Octipus architecture overview'), // second chunk of the same note
        hit(B, 0.7, 'Deployment notes'),
        hit(C, 0.6, 'Model registry'),
        hit('44444444-4444-4444-8444-444444444444', 0.5, 'Fourth'),
      ],
      SELF,
    );
    expect(out.map((c) => c.noteId)).toEqual([A, B, C]);
    expect(out[0].similarity).toBe(0.9);
  });

  test('never proposes the linking note itself', () => {
    const out = selectCandidates([hit(SELF, 0.99, 'This note'), hit(A, 0.4, 'Other')], SELF);
    expect(out.map((c) => c.noteId)).toEqual([A]);
  });

  test('skips hits that cannot be named or are not notes', () => {
    const out = selectCandidates(
      [
        hit(A, 0.9), // no title — nothing to adjudicate against
        { sourceId: `document:${B}`, similarity: 0.8, metadata: { title: 'A document' } },
        { sourceId: 'not-an-entity-ref', similarity: 0.8, metadata: { title: 'Junk' } },
        hit(C, 0.5, 'Real note'),
      ],
      SELF,
    );
    expect(out.map((c) => c.noteId)).toEqual([C]);
  });

  test('no candidates means no guess', () => {
    expect(selectCandidates([], SELF)).toEqual([]);
  });
});
