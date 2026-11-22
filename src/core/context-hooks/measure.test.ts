import { describe, expect, test } from 'vitest';
import { passageUsed, usedPassages } from './measure';

describe('passageUsed', () => {
  const excerpt = 'Pricing: a five-page website costs 2,400 euro, hosting is billed apart at 15 euro a month. Renovation of an existing site is quoted per project.';
  const query = 'What do we charge for a website?';

  test('one strong token in the answer and not in the query: an amount', () => {
    expect(passageUsed('A five-page website is €2400.', excerpt, query)).toBe(true);
    // The same number written with its grouping mark, or with a zero decimal part.
    expect(passageUsed('That is 2,400.00 euro.', excerpt, query)).toBe(true);
  });

  test('an identifier, a date, a time', () => {
    const ex = 'Invoice INV-2024-118 for Bakery Smit was paid on 2024-05-14 at 14:30.';
    expect(passageUsed('INV-2024-118 is paid.', ex, 'what about the bakery invoice?')).toBe(true);
    expect(passageUsed('It was paid on 2024-05-14.', ex, 'when was the bakery invoice paid?')).toBe(true);
    expect(passageUsed('Around 14:30.', ex, 'what time?')).toBe(true);
  });

  test('what the query already held does not count: the answer may repeat the question', () => {
    const ex = 'Invoice INV-2024-118 for Bakery Smit: three hours of logo design.';
    expect(passageUsed('INV-2024-118 — I could not find it.', ex, 'What is on INV-2024-118?')).toBe(false);
  });

  test('a single weak token is not enough: one long word, one two-digit number, or a year', () => {
    expect(passageUsed('Renovation is something we do.', excerpt, query)).toBe(false);
    expect(passageUsed('I can do that in 15 minutes.', excerpt, query)).toBe(false);
    expect(passageUsed('In 2024 we changed this.', 'Our rates changed in 2024 after the review.', query)).toBe(false);
    // Two different weak ones are: a long word (by its stem) and a two-digit amount.
    expect(passageUsed('Renovations are quoted per project; hosting is 15 euro.', excerpt, query)).toBe(true);
  });

  test('common long words and short words do not count', () => {
    const ex = 'Everything about the important information is available here, including questions.';
    expect(passageUsed('Here is everything important: the information available, including your questions.', ex, 'hi')).toBe(false);
  });

  test('a number is a whole token: 2400 is not in 24001', () => {
    expect(passageUsed('Reference 24001.', excerpt, query)).toBe(false);
  });

  test('scripts without spaces: a shared run of eight characters not in the query', () => {
    const ex = '网站建设的报价是两千四百欧元，托管每月十五欧元。';
    expect(passageUsed('网站建设的报价是两千四百欧元。', ex, '网站多少钱？')).toBe(true);
    expect(passageUsed('我不知道。', ex, '网站多少钱？')).toBe(false);
  });

  test('nothing to compare: an empty answer or excerpt', () => {
    expect(passageUsed('', excerpt, query)).toBe(false);
    expect(passageUsed('2400', '', query)).toBe(false);
  });

  test('usedPassages counts per passage', () => {
    const passages = [{ excerpt, query }, { excerpt: 'The studio closes from 24 December to 2 January.', query }];
    expect(usedPassages('A website is 2400 euro.', passages)).toBe(1);
    expect(usedPassages('', passages)).toBe(0);
  });
});
