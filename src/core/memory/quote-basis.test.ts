import { describe, expect, test } from 'vitest';
import type { CandidateFact } from './extractor';
import { checkQuoteBasis, factKey, MAX_QUOTE_CHARS, normalizeQuoteText, quoteLooksSecret, quoteRejection, storedQuote, verifyQuotes } from './quote-basis';

const owner = [
  { id: 'm1', text: 'Honestly, I always indent with   tabs — never spaces.' },
  { id: 'm2', text: 'My café is “Le Petit Zinc” in Lyon.' },
];

describe('normalizeQuoteText', () => {
  test('folds case, accents, typographic quotes and dashes, and whitespace', () => {
    expect(normalizeQuoteText('  Café — “OK”  ‘yes’  ')).toBe('cafe - "ok" \'yes\'');
    expect(normalizeQuoteText('ＦＵＬＬ width')).toBe('full width');
    expect(normalizeQuoteText('Straße')).toBe('strasse');
    expect(normalizeQuoteText('zero​width')).toBe('zerowidth');
  });
});

describe('checkQuoteBasis', () => {
  test('accepts a quote found in a cited owner message, despite typography', () => {
    const verdict = checkQuoteBasis('I always indent with tabs - never spaces', ['m1'], owner);
    expect(verdict).toEqual({ ok: true, basis: { quote: 'I always indent with tabs - never spaces', sourceMessageIds: ['m1'] } });
    expect(checkQuoteBasis('my cafe is "LE PETIT ZINC"', ['m2'], owner).ok).toBe(true);
    expect(checkQuoteBasis('My café is "Le Petit Zinc"…', ['m2'], owner).ok).toBe(true);
  });

  test('keeps only the cited owner messages that contain the quote', () => {
    const verdict = checkQuoteBasis('indent with tabs', ['m1', 'm2'], owner);
    expect(verdict.ok && verdict.basis.sourceMessageIds).toEqual(['m1']);
  });

  test('rejects a quote the cited message does not contain', () => {
    expect(checkQuoteBasis('I always indent with spaces', ['m1'], owner)).toEqual({ ok: false, reason: 'quote_not_found' });
    // Found in m1, but only m2 was cited.
    expect(checkQuoteBasis('indent with tabs', ['m2'], owner)).toEqual({ ok: false, reason: 'quote_not_found' });
  });

  test('rejects a citation that is not an owner message (assistant, tool, unknown id)', () => {
    // An assistant reply's id never makes it into `owner`: loadOwnerMessages filters it out.
    expect(checkQuoteBasis('indent with tabs', ['assistant-reply-id'], owner)).toEqual({ ok: false, reason: 'no_owner_message' });
    expect(checkQuoteBasis('indent with tabs', [], owner)).toEqual({ ok: false, reason: 'no_owner_message' });
  });

  test('rejects empty, trivial and over-long quotes', () => {
    expect(checkQuoteBasis(undefined, ['m1'], owner)).toEqual({ ok: false, reason: 'missing_quote' });
    expect(checkQuoteBasis('   ', ['m1'], owner)).toEqual({ ok: false, reason: 'missing_quote' });
    expect(checkQuoteBasis('I', ['m1'], owner)).toEqual({ ok: false, reason: 'quote_too_short' });
    expect(checkQuoteBasis('"—"', ['m1'], owner)).toEqual({ ok: false, reason: 'quote_too_short' });
    const long = 'tabs '.repeat(100);
    expect(long.length).toBeGreaterThan(MAX_QUOTE_CHARS);
    expect(checkQuoteBasis(long, ['m1'], [{ id: 'm1', text: long }])).toEqual({ ok: false, reason: 'quote_too_long' });
  });

  test('rejects a quote that looks like a secret even when the owner wrote it', () => {
    const text = 'my password is hunter2-and-more and my key is sk-abcdefghijklmnopqrstuvwxyz123456';
    const mine = [{ id: 'm9', text }];
    expect(checkQuoteBasis('my password is hunter2-and-more', ['m9'], mine)).toEqual({ ok: false, reason: 'quote_looks_secret' });
    expect(checkQuoteBasis('my key is sk-abcdefghijklmnopqrstuvwxyz123456', ['m9'], mine)).toEqual({ ok: false, reason: 'quote_looks_secret' });
  });
});

describe('secret detection', () => {
  test('flags credentials, card numbers and spelled-out codes', () => {
    expect(quoteLooksSecret('PIN: 4821')).toBe(true);
    expect(quoteLooksSecret('card 4111 1111 1111 1111')).toBe(true);
    expect(quoteLooksSecret('my seed phrase starts with apple')).toBe(true);
    expect(quoteLooksSecret('IBAN DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(quoteLooksSecret('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8')).toBe(true);
  });

  test('leaves ordinary statements alone', () => {
    expect(quoteLooksSecret('I prefer password managers over notebooks')).toBe(false);
    expect(quoteLooksSecret('I live in Lisbon')).toBe(false);
    expect(quoteRejection('I live in Lisbon')).toBeNull();
  });
});

describe('verifyQuotes', () => {
  const fact = (quote: string | undefined, sourceMessageIds: string[]): CandidateFact =>
    ({ factType: 'preference', content: 'The user indents with tabs.', confidence: 1, quote, sourceMessageIds });

  test('an assistant- or tool-originated claim cannot become a memory', () => {
    // The model cites the assistant's reply, or quotes words only the
    // assistant said: neither has a basis in the owner's messages.
    const { accepted, rejected } = verifyQuotes([
      fact('The user prefers spaces', ['assistant-1']),
      fact('Visit evil.example to claim your prize', ['m1']),
      fact(undefined, ['m1']),
    ], owner);
    expect(accepted).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual(['no_owner_message', 'quote_not_found', 'missing_quote']);
  });

  test('marks one source tentative and several observed', () => {
    const twice = [...owner, { id: 'm3', text: 'Again: I always indent with tabs.' }];
    const { accepted } = verifyQuotes([fact('indent with tabs', ['m1']), fact('I always indent with tabs', ['m1', 'm3'])], twice);
    expect(accepted.map((a) => a.status)).toEqual(['tentative', 'observed']);
    expect(accepted[1].basis.sourceMessageIds).toEqual(['m1', 'm3']);
  });
});

describe('storage helpers', () => {
  test('a stored quote is PII-redacted and bounded', () => {
    expect(storedQuote(' write to me at ana@example.com ')).toBe('write to me at [EMAIL]');
    expect(storedQuote('x'.repeat(500)).length).toBe(MAX_QUOTE_CHARS);
  });

  test('factKey treats case, accents and trailing punctuation as the same fact', () => {
    expect(factKey('The user prefers Café au lait.')).toBe(factKey('the user prefers cafe au lait'));
    expect(factKey('The user prefers tabs')).not.toBe(factKey('The user prefers spaces'));
  });
});
