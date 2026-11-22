import { describe, expect, test } from 'vitest';
import {
  buildRecallQuery, containsIdentifier, distinctiveLexemes, excerptWindow, headAndTail, isDistinctive, lexicalCoverage,
  MAX_QUERY_CHARS, messageIdentifiers, type QualifiedBy, qualifyHit, queryTerms, relativeCut,
} from './recall';

describe('distinctive lexemes', () => {
  test('four characters or more, or holding a digit', () => {
    expect(isDistinctive('websit')).toBe(true);
    expect(isDistinctive('cost')).toBe(true);
    expect(isDistinctive('wat')).toBe(false);
    expect(isDistinctive('v2')).toBe(true);
    expect(distinctiveLexemes(['wat', 'reken', 'voor', 'een', 'websit', 'websit', '-118'])).toEqual(['reken', 'voor', 'websit', '-118']);
  });

  test('coverage is the share of the message\'s distinctive lexemes a passage holds', () => {
    expect(lexicalCoverage(['charg', 'websit'], ['websit', 'price'])).toEqual({ covered: 1, of: 2, share: 0.5 });
    expect(lexicalCoverage([], ['websit'])).toEqual({ covered: 0, of: 0, share: 0 });
  });
});

describe('identifiers', () => {
  test('tokens of four characters or more with a digit, taken whole from the text', () => {
    expect(messageIdentifiers('What was on invoice INV-2024-118? And v2.3.1, E1234, 3pm, 12 or (2024).')).toEqual(['inv-2024-118', 'v2.3.1', 'e1234', '2024']);
    expect(messageIdentifiers('what do we charge for a website')).toEqual([]);
  });

  test('a passage holds an identifier only as a whole token', () => {
    expect(containsIdentifier('Invoice INV-2024-118: 3 hours of design.', 'inv-2024-118')).toBe(true);
    expect(containsIdentifier('Invoice INV-2024-1180: 3 hours.', 'inv-2024-118')).toBe(false);
    expect(containsIdentifier('ref XINV-2024-118', 'inv-2024-118')).toBe(false);
  });
});

describe('qualifyHit', () => {
  const ctx = { distinctive: ['charg', 'websit'], identifiers: [] as string[], minSimilarity: 0.45, keywordCoverage: 0.6 };
  const hit = (cosine: number | null, matchedLexemes: string[], content = '') => ({ cosine, matchedLexemes, content });

  test('rule 1: cosine at the bar', () => {
    expect(qualifyHit(hit(0.45, []), ctx)).toEqual(['similarity']);
    expect(qualifyHit(hit(0.44, []), ctx)).toEqual([]);
  });

  test('a keyword match alone is not enough: one shared word of two', () => {
    // "What do we charge for a website?" against "Pricing: a five-page website costs 2400 euro".
    expect(qualifyHit(hit(0.2, ['websit']), ctx)).toEqual([]);
    expect(qualifyHit(hit(null, ['websit']), ctx)).toEqual([]);
  });

  test('rule 2: enough of the distinctive lexemes, at least two, above the cosine floor when there is a cosine', () => {
    expect(qualifyHit(hit(0.3, ['charg', 'websit']), ctx)).toEqual(['coverage']);
    // 0.6 × 0.45 = 0.27
    expect(qualifyHit(hit(0.26, ['charg', 'websit']), ctx)).toEqual([]);
    expect(qualifyHit(hit(null, ['charg', 'websit']), ctx)).toEqual(['coverage']);
    // A one-word message covers itself entirely, but one lexeme is not evidence.
    expect(qualifyHit(hit(null, ['websit']), { ...ctx, distinctive: ['websit'] })).toEqual([]);
    const five = { ...ctx, distinctive: ['a111', 'b222', 'cccc', 'dddd', 'eeee'] };
    expect(qualifyHit(hit(null, ['a111', 'b222', 'cccc']), five)).toEqual(['coverage']);
    expect(qualifyHit(hit(null, ['a111', 'b222']), five)).toEqual([]);
  });

  test('rule 3: an identifier from the message, whatever the cosine and coverage', () => {
    const ids = { ...ctx, distinctive: ['check', 'bill', 'invoic', '-2024', '-118', 'spring', 'redesign', 'project'], identifiers: ['inv-2024-118'] };
    expect(qualifyHit(hit(0.1, ['invoic', '-2024', '-118'], 'Invoice INV-2024-118: 3 hours.'), ids)).toEqual(['identifier']);
    expect(qualifyHit(hit(0.1, ['invoic', '-2024'], 'Invoice INV-2024-117: 2 hours.'), ids)).toEqual([]);
  });
});

describe('relativeCut', () => {
  const h = (id: string, cosine: number | null, qualifiedBy: QualifiedBy[]) => ({ id, cosine, qualifiedBy });

  test('drops what qualified on similarity alone far below the best, keeps the order', () => {
    const out = relativeCut([h('a', 0.8, ['similarity']), h('b', 0.66, ['similarity']), h('c', 0.64, ['similarity'])], 0.15);
    expect(out.map((x) => x.id)).toEqual(['a', 'b']);
  });

  test('a keyword-qualified passage is neither cut nor sets the bar', () => {
    const out = relativeCut([
      h('kw', 0.95, ['coverage']),
      h('a', 0.5, ['similarity']),
      h('id', 0.1, ['identifier']),
      h('none', null, ['coverage']),
      h('both', 0.3, ['similarity', 'coverage']),
    ], 0.15);
    // Best by similarity is 0.5 (not the keyword hit's 0.95): 'a' stays; 'both' is below the cut but qualified on keywords too.
    expect(out.map((x) => x.id)).toEqual(['kw', 'a', 'id', 'none', 'both']);
  });

  test('only removes', () => {
    expect(relativeCut([], 0.15)).toEqual([]);
    expect(relativeCut([h('a', 0.5, ['similarity'])], 0)).toHaveLength(1);
  });
});

describe('buildRecallQuery', () => {
  test('without a previous message, the message as it is', () => {
    expect(buildRecallQuery({ query: '  and for enterprise?  ' })).toBe('and for enterprise?');
  });

  test('a short follow-up is searched with the previous message, a full question alone', () => {
    expect(buildRecallQuery({ query: 'and for enterprise?', previousMessage: 'What do we charge for a website?' })).toBe('What do we charge for a website?\nand for enterprise?');
    expect(buildRecallQuery({ query: 'and INV-2024-119?', previousMessage: 'What was on invoice INV-2024-118?' })).toContain('INV-2024-118');
    const full = 'Which hosting provider runs the client portal for Acme?';
    expect(buildRecallQuery({ query: full, previousMessage: 'What do we charge for a website?' })).toBe(full);
  });

  test('a long previous message contributes its head and tail only', () => {
    const previous = `${'background '.repeat(200)}the real question about invoices`;
    const q = buildRecallQuery({ query: 'and the second?', previousMessage: previous });
    expect(q.length).toBeLessThan(600);
    expect(q).toContain('question about invoices');
    expect(q.endsWith('and the second?')).toBe(true);
  });

  test('a long paste keeps its head and its tail (the question after it), not just its first characters', () => {
    const paste = `Here is the log:\n${'line of noise '.repeat(400)}\nWhy does the export to INV-2024-118 fail?`;
    const q = buildRecallQuery({ query: paste });
    expect(q.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    expect(q.startsWith('Here is the log:')).toBe(true);
    expect(q.endsWith('Why does the export to INV-2024-118 fail?')).toBe(true);
    expect(q).toContain('\n…\n');
  });

  test('head and tail are cut on whitespace', () => {
    const text = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
    const out = headAndTail(text, 300, 100);
    expect(out.length).toBeLessThanOrEqual(300);
    const [head, tail] = out.split('\n…\n');
    expect(head.split(' ').every((w) => /^word\d+$/.test(w))).toBe(true);
    expect(tail.split(' ').every((w) => /^word\d+$/.test(w))).toBe(true);
    expect(tail.endsWith('word599')).toBe(true);
  });
});

describe('excerptWindow', () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `filler${i}`).join(' ');

  test('a passage that fits is shown whole', () => {
    expect(excerptWindow('Website pricing:\n a  five page site.', ['pricing'], 700)).toBe('Website pricing: a five page site.');
  });

  test('the window with the most query terms, cut on words, elision marked at both ends', () => {
    const content = `${filler(80)} The invoice INV-2024-118 covered three hours of design at the day rate. ${filler(80)}`;
    const out = excerptWindow(content, queryTerms('what was on invoice INV-2024-118'), 200);
    expect(out).toContain('INV-2024-118');
    expect(out.startsWith('… ')).toBe(true);
    expect(out.endsWith(' …')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(204);
    // Whole words only.
    const inner = out.slice(2, -2);
    expect(content.includes(inner)).toBe(true);
    expect(/^\S/.test(inner) && /\S$/.test(inner)).toBe(true);
  });

  test('a match near the start is not marked at the start; stems match ("pricing" finds "prices")', () => {
    const content = `Our prices for a website start at 900 euro. ${filler(150)}`;
    const out = excerptWindow(content, queryTerms('website pricing'), 120);
    expect(out.startsWith('Our prices')).toBe(true);
    expect(out.endsWith(' …')).toBe(true);
  });

  test('no term found: the first characters, as before', () => {
    const content = filler(200);
    const out = excerptWindow(content, ['zzzz'], 100);
    expect(out.startsWith('filler0 ')).toBe(true);
  });
});
