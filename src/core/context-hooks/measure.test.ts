import { describe, expect, test } from 'vitest';
import {
  CALIBRATION_MIN_RUNS, calibrationMessage, calibrationSample, calibrationVerdict, citedItems, namesTitle, passageUsed, recommendThreshold,
  SWEEP_THRESHOLDS, usedPassages,
} from './measure';

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

describe('citedItems', () => {
  const items = [
    { id: '11111111-1111-1111-1111-111111111111', sourceId: 'note:a', title: 'Pricing 2026', score: 0.7 },
    { id: '22222222-2222-2222-2222-222222222222', sourceId: 'file:b', title: 'contract.pdf', score: 0.6 },
    { id: '33333333-3333-3333-3333-333333333333', sourceId: 'note:c', title: 'AI', score: 0.6 },
  ];

  test('an answer names a source by its title, a file by its name without the extension', () => {
    expect(citedItems('From the note "pricing 2026": €900.', items)).toBe(1);
    expect(citedItems('See the Contract for the terms; also Pricing 2026.', items)).toBe(2);
    expect(citedItems('As note:a says.', items)).toBe(1);
  });

  test('titles under four characters do not count as named by chance', () => {
    expect(citedItems('AI is mentioned here.', items)).toBe(0);
    expect(citedItems('', items)).toBe(0);
  });
});

describe('namesTitle', () => {
  test('on word boundaries: not inside another word', () => {
    expect(namesTitle('From the note "Pricing": 900 euro.', 'Pricing')).toBe(true);
    expect(namesTitle("Pricing's second line", 'Pricing')).toBe(true);
    expect(namesTitle('We are repricing everything.', 'Pricing')).toBe(false);
    expect(namesTitle('Our pricings vary.', 'Pricing')).toBe(false);
    expect(namesTitle('The contractor will call.', 'contract.pdf')).toBe(false);
    expect(namesTitle('See contract.pdf.', 'contract.pdf')).toBe(true);
  });

  test('any script, any case, any spacing', () => {
    expect(namesTitle('Volgens de notitie Prijzen Ü-Bahn staat het er.', 'prijzen ü-bahn')).toBe(true);
    expect(namesTitle('Siehe Überblick.', 'überblick')).toBe(true);
    // A letter of another script is still a letter: "Überblicke" is another word.
    expect(namesTitle('Siehe Überblicke.', 'Überblick')).toBe(false);
    expect(namesTitle('From the   note\nPricing  2026.', 'Pricing 2026')).toBe(true);
    // A script without spaces: the title sits inside a run of text.
    expect(namesTitle('根据网站价格表，建站两千欧元。', '网站价格表')).toBe(true);
  });

  test('four characters at the least, after the extension is stripped', () => {
    expect(namesTitle('Ask the AI.', 'AI')).toBe(false);
    expect(namesTitle('the faq says', 'faq.md')).toBe(false);
    expect(namesTitle('the plan says', 'plan.md')).toBe(true);
  });
});

describe('calibration', () => {
  test('which runs count: searched and decided on similarity', () => {
    expect(calibrationSample({ status: 'injected' })).toBe('found');
    expect(calibrationSample({ status: 'abstained', reason: 'nothing_relevant' })).toBe('nothing');
    // Found, then left out: the bar let it through.
    expect(calibrationSample({ status: 'abstained', reason: 'over_budget' })).toBe('found');
    expect(calibrationSample({ status: 'skipped', reason: 'budget_spent' })).toBe('found');
    expect(calibrationSample({ status: 'error', reason: 'commit_failed' })).toBe('found');
    // Not searched, or not on the bar.
    expect(calibrationSample({ status: 'skipped', reason: 'short_message' })).toBeNull();
    expect(calibrationSample({ status: 'skipped', reason: 'no_embedding_model' })).toBeNull();
    expect(calibrationSample({ status: 'error', reason: 'timeout' })).toBeNull();
    expect(calibrationSample({ status: 'injected', degraded: 'embedding_failed' })).toBeNull();
  });

  test('the thresholds, and no verdict on a small sample', () => {
    expect(CALIBRATION_MIN_RUNS).toBe(30);
    expect(calibrationVerdict(29, 29)).toBeNull();
    expect(calibrationVerdict(0, 29)).toBeNull();
    expect(calibrationVerdict(29, 30)).toBe('injects_nearly_always');
    expect(calibrationVerdict(28, 30)).toBeNull();
    expect(calibrationVerdict(19, 20)).toBeNull();
    expect(calibrationVerdict(1, 30)).toBe('injects_almost_never');
    expect(calibrationVerdict(2, 30)).toBeNull();
    expect(calibrationVerdict(50, 100)).toBeNull();
    expect(calibrationVerdict(5, 100)).toBe('injects_almost_never');
    expect(calibrationVerdict(95, 100)).toBe('injects_nearly_always');
  });

  test('the message points at the sweep', () => {
    expect(calibrationMessage('Knowledge recall', 'injects_nearly_always', 39, 40)).toMatch(/98% of the 40 messages.*too low.*threshold sweep/s);
    expect(calibrationMessage('Knowledge recall', 'injects_almost_never', 1, 40)).toMatch(/3% of the 40 messages.*too high.*threshold sweep/s);
  });
});

describe('the sweep\'s recommendation', () => {
  const row = (minSimilarity: number, found: number, abstained: number) => ({ minSimilarity, found: { n: found, of: 4 }, abstained: { n: abstained, of: 2 } });

  test('the range it tries', () => {
    expect(SWEEP_THRESHOLDS).toEqual([0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]);
  });

  test('the highest found-rate plus abstained-rate', () => {
    // 0.3: 4/4 + 0/2 = 1; 0.4: 3/4 + 2/2 = 1.75; 0.5: 2/4 + 2/2 = 1.5.
    expect(recommendThreshold([row(0.3, 4, 0), row(0.4, 3, 2), row(0.5, 2, 2)])).toEqual({ recommended: 0.4 });
  });

  test('a tie goes to the higher threshold', () => {
    expect(recommendThreshold([row(0.3, 4, 1), row(0.4, 4, 1), row(0.5, 2, 1)])).toEqual({ recommended: 0.4 });
    // Found falls by as much as abstained rises (in share): equal, the higher one.
    expect(recommendThreshold([row(0.3, 4, 0), row(0.4, 2, 1)])).toEqual({ recommended: 0.4 });
  });

  test('none without both kinds of question', () => {
    const onlyAnswerable = [{ minSimilarity: 0.3, found: { n: 2, of: 2 }, abstained: { n: 0, of: 0 } }];
    const onlyEmpty = [{ minSimilarity: 0.3, found: { n: 0, of: 0 }, abstained: { n: 2, of: 2 } }];
    expect(recommendThreshold(onlyAnswerable)).toEqual({ recommended: null, reason: 'needs_both_kinds' });
    expect(recommendThreshold(onlyEmpty)).toEqual({ recommended: null, reason: 'needs_both_kinds' });
    expect(recommendThreshold([])).toEqual({ recommended: null, reason: 'needs_both_kinds' });
  });
});
