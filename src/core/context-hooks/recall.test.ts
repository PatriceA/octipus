import { describe, expect, test } from 'vitest';
import {
  buildRecallQuery, carriesSubject, followUpQuery, containsIdentifier, distinctiveLexemes, excerptWindow, headAndTail, isAcknowledgement, isDistinctive, isIdentifier,
  lexicalCoverage, MAX_QUERY_CHARS, messageIdentifiers, type QualifiedBy, qualifyHit, queryTerms, relativeCut, searchesWithPreviousMessage,
  skipsShortMessage,
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
  test('references, taken whole from the text; years, times and short numbers are not', () => {
    expect(messageIdentifiers('What was on invoice INV-2024-118? And v2.3.1, E1234, 3pm, 12 or (2024).')).toEqual(['inv-2024-118', 'v2.3.1', 'e1234']);
    expect(messageIdentifiers('what do we charge for a website')).toEqual([]);
    // The reproduced case: a year in the question made a shopping list "2024" qualify.
    expect(messageIdentifiers('What did we decide in the 2024 planning meeting about hiring?')).toEqual([]);
    expect(messageIdentifiers('Where is PO 4500012345?')).toEqual(['4500012345']);
  });

  // What a person would call a reference, and what only holds a digit.
  const accepted = [
    'INV-2024-118', 'v2.3.1', 'E1234', '4500012345', '123456', 'sha256', 'h264', 'a1b2', 'ERR_404', 'PO-4500', 'OCT-142',
    'ISO-9001', '2.3.1', '10.0.0.1', 'AB12CD34', 'x86-64-v3', 'KB5034441', 'ticket#9912',
  ];
  const rejected = [
    // years, amounts, short numbers
    '2024', '1500', '12345', '2,400', '1,500,000', '1.500.000', '1.500', '€1500',
    // times, dates
    '10:30', '10:30:15', '10am', '3pm', '2024-03-01', '01/03/2024', '1.3.2024', '1/3/24', '12/25',
    // ordinals, units, decades
    '1st', '22nd', '103rd', '1500mb', '100km', '2024s',
    // short word-digit names
    'covid-19', 'covid19', 'web3', 'windows11', 'mp3', 'x86', 'v2', 'top-10', 'B2B', 'g20',
    // starts with a number, holds letters
    '3-d', '10-k', '24/7',
  ];
  test.each(accepted)('%s is an identifier', (token) => {
    expect(isIdentifier(token)).toBe(true);
    expect(messageIdentifiers(`about ${token}?`)).toEqual([token.toLowerCase()]);
  });
  test.each(rejected)('%s is not an identifier', (token) => {
    expect(isIdentifier(token)).toBe(false);
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

  test('a keyword-qualified passage is not cut, however far below the best', () => {
    // Reachable states only (minSimilarity 0.45): a passage qualified on keywords alone has a cosine below the bar.
    const out = relativeCut([
      h('top', 0.8, ['similarity']),
      h('kw', 0.3, ['coverage']),
      h('a', 0.5, ['similarity']),
      h('id', 0.1, ['identifier']),
      h('none', null, ['coverage']),
      h('both', 0.46, ['similarity', 'coverage']),
    ], 0.15);
    // Best by similarity is 0.8: 'a' is cut; 'both' is below the cut too but qualified on keywords as well.
    expect(out.map((x) => x.id)).toEqual(['top', 'kw', 'id', 'none', 'both']);
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

  test('the follow-up search exists only for a short message after another one', () => {
    expect(followUpQuery({ query: 'and for enterprise?' })).toBeNull();
    expect(followUpQuery({ query: 'and for enterprise?', previousMessage: 'What do we charge for a website?' })).toBe('What do we charge for a website?\nand for enterprise?');
    expect(followUpQuery({ query: 'Which hosting provider runs the client portal for Acme?', previousMessage: 'What do we charge?' })).toBeNull();
    expect(followUpQuery({ query: 'thanks', previousMessage: 'What do we charge?' })).toBeNull();
    expect(followUpQuery({ query: 'Enterprise?', previousMessage: 'Enterprise?' })).toBeNull();
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

describe('a short message', () => {
  const previous = 'What do we charge for a website?';

  test('a one-word follow-up that names something is searched when an earlier message gives it its subject', () => {
    expect(skipsShortMessage('Enterprise?')).toBe(true);
    expect(skipsShortMessage('Enterprise?', previous)).toBe(false);
    expect(skipsShortMessage('INV-2024-119?', 'What was on invoice INV-2024-118?')).toBe(false);
    expect(skipsShortMessage('Unternehmen?', 'Was kostet eine Webseite?')).toBe(false);
    // An unspaced script: a run of two characters or more names something.
    expect(skipsShortMessage('企业版？', '网站建设的报价是多少？')).toBe(false);
    expect(searchesWithPreviousMessage('Enterprise?')).toBe(true);
    expect(buildRecallQuery({ query: 'Enterprise?', previousMessage: previous })).toBe(`${previous}\nEnterprise?`);
  });

  test('a bare acknowledgement is not searched, with or without an earlier message', () => {
    for (const ack of ['ok', 'thanks', 'Thanks!', 'yes please', 'ok great, thanks', 'Thank you very much!', 'got it', 'Bedankt!', 'merci', '谢谢', '好的', 'ありがとう', '👍']) {
      expect(skipsShortMessage(ack, previous), ack).toBe(true);
      expect(skipsShortMessage(ack), ack).toBe(true);
      expect(searchesWithPreviousMessage(ack), ack).toBe(false);
    }
    expect(buildRecallQuery({ query: 'yes please', previousMessage: previous })).toBe('yes please');
  });

  test('a short message that names nothing is not a follow-up: "why?" stays skipped', () => {
    expect(skipsShortMessage('why?', previous)).toBe(true);
    expect(skipsShortMessage('Bob?', previous)).toBe(true);
    expect(searchesWithPreviousMessage('why?')).toBe(false);
    // The same message as the previous one adds nothing.
    expect(skipsShortMessage('Enterprise?', 'Enterprise?')).toBe(true);
  });

  test('two content words or more are searched as before, alone or as a follow-up', () => {
    expect(skipsShortMessage('try one?')).toBe(false);
    expect(skipsShortMessage('and for enterprise?')).toBe(false);
    expect(skipsShortMessage('good morning, pricing?')).toBe(false);
    expect(searchesWithPreviousMessage('and for enterprise?')).toBe(true);
  });

  test('what counts as an acknowledgement and as a subject', () => {
    expect(isAcknowledgement('Okay, thanks a lot!')).toBe(true);
    expect(isAcknowledgement('thanks, and the hosting?')).toBe(false);
    expect(isAcknowledgement('')).toBe(false);
    expect(carriesSubject('Enterprise?')).toBe(true);
    expect(carriesSubject('perfect!')).toBe(false);
    expect(carriesSubject('v2?')).toBe(true);
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

  test('a long token before the first hit does not push the last hit out of the window', () => {
    // A 60-character token ends just before the first hit; going back to its start would lose "omega".
    const content = `intro ${'x'.repeat(60)} alpha ${filler(10)} omega ${filler(40)}`;
    const out = excerptWindow(content, ['alpha', 'omega'], 110);
    expect(out).toContain('alpha');
    expect(out).toContain('omega');
    expect(out.length).toBeLessThanOrEqual(114);
  });

  test('the message\'s own terms steer the window; the fallback terms only when none of them is there', () => {
    const content = `${filler(30)} pricing for a website ${filler(60)} enterprise support plans ${filler(60)}`;
    expect(excerptWindow(content, ['enterprise'], 120, ['pricing'])).toContain('enterprise');
    expect(excerptWindow(content, ['enterprise'], 120, ['pricing'])).not.toContain('pricing');
    expect(excerptWindow(content, ['zzzz'], 120, ['pricing'])).toContain('pricing');
  });

  test('no term found: the first characters, as before', () => {
    const content = filler(200);
    const out = excerptWindow(content, ['zzzz'], 100);
    expect(out.startsWith('filler0 ')).toBe(true);
  });
});
