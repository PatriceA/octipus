import { describe, expect, test } from 'vitest';
import {
  CALIBRATION_MIN_RUNS, calibrationMessage, calibrationSample, calibrationVerdict, canonicalNumber, citedItems, MAX_MEASURED_CHARS, namesTitle,
  passageUsed, recommendThreshold, SWEEP_THRESHOLDS, usedPassages,
} from './measure';

describe('passageUsed', () => {
  const excerpt = 'Pricing: a five-page website costs 2,400 euro, hosting is billed apart at 15 euro a month. Renovation of an existing site is quoted per project.';
  const query = 'What do we charge for a website?';

  test('one strong token in the answer and not in the query: an amount', () => {
    expect(passageUsed('A five-page website is €2400.', excerpt, query)).toBe(true);
    // The same number written with its grouping mark, or with a zero decimal part.
    expect(passageUsed('That is 2,400.00 euro.', excerpt, query)).toBe(true);
  });

  test('an identifier, a date, a time off the quarter hour', () => {
    const ex = 'Invoice INV-2024-118 for Bakery Smit was paid on 2024-05-14 at 14:37.';
    expect(passageUsed('INV-2024-118 is paid.', ex, 'what about the bakery invoice?')).toBe(true);
    expect(passageUsed('It was paid on 2024-05-14.', ex, 'when was the bakery invoice paid?')).toBe(true);
    expect(passageUsed('Around 14:37.', ex, 'what time?')).toBe(true);
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

  // Each row: excerpt, answer, whether the answer used it. The false rows
  // were all counted as used before numbers were read by their value.
  test.each([
    // A grouping mark before three digits, in either convention: the number keeps its digits.
    ['Der Preis beträgt 1.000 EUR.', 'Step 1: open the app.', false],
    ['Der Preis beträgt 1.000 EUR.', 'Der Preis ist 1000 Euro.', true],
    ['Der Preis beträgt 1.000 EUR.', 'It costs 1,000 euro.', true],
    ['10.000 Nutzer sind registriert.', 'Here are 10 tips.', false],
    ['10.000 Nutzer sind registriert.', 'About 10,000 users.', true],
    // A zero decimal part is dropped, and what is left of $5.00 or €1,00 is one digit: no evidence.
    ['The basic plan costs $5.00 per month.', 'Do this:\n1. Sign up\n2. Pick a plan\n3. Pay\n4. Confirm\n5. Start', false],
    ['Der Kaffee kostet 1,00 €.', 'We have 100 seats.', false],
    // European and English decimals are the same number.
    ['Total: 1.234,50 EUR', 'The total was 1,234.50.', true],
    ['Total: 1,234.50 EUR', 'Das waren 1.234,5 Euro.', true],
    ['Zinsen: 12,75 Prozent', 'At 12.75 it is fine.', true],
    // A percentage is not the bare number, and a round one is no evidence.
    ['The room has 100 seats.', 'I am 100% sure.', false],
    ['Growth was 37% and churn 4.5%.', 'Growth: 37 %, churn: 4,5 %.', true],
    ['Half of them, 50%, and then 25%.', 'Maybe 50% or 25%.', false],
    // A time on the quarter hour is no evidence.
    ['The shop opens at 10:00.', 'Meet at 10:00.', false],
    ['The train leaves at 09:47.', 'It leaves at 9:47.', true],
    // List numbering in the answer is no evidence, however many items.
    ['We have 12 offices in 15 countries.', 'Steps:\n12. Open\n13. Check\n14. Save\n15. Close', false],
    ['We have 12 offices in 15 countries.', 'There are 12 offices across 15 countries.', true],
  ])('%s / %s → %s', (excerpt, answer, used) => {
    expect(passageUsed(answer, excerpt, 'what is it?')).toBe(used);
  });

  test.each([
    ['1.000', '1000'], ['1,000', '1000'], ['10.000', '10000'], ['1.000.000', '1000000'], ["1'000", '1000'], ['1_000', '1000'],
    ['2,400.00', '2400'], ['2.400,00', '2400'], ['1,000.50', '1000.5'], ['1.000,50', '1000.5'], ['5.00', '5'], ['1,00', '1'],
    ['3.5', '3.5'], ['2,5', '2.5'], ['3.14159', '3.14159'], ['2400', '2400'], ['007', '007'],
    // Not one number: grouping groups of another size, a mark used for both, a mixed grouping.
    ['192.168.0.1', null], ['1.000.00', null], ['1,000.000,5', null], ['12.34.567', null], ['1,000.500', null],
  ])('canonicalNumber(%s) = %s', (token, value) => {
    expect(canonicalNumber(token)).toBe(value);
  });

  test('one normal form: NFD and NFC are the same text', () => {
    const nfc = 'Die Überweisungsgebühr und die Kontoführungsgebühr steigen.';
    const nfd = 'Überweisungsgebühr, Kontoführungsgebühr'.normalize('NFD');
    expect(nfd).not.toBe(nfd.normalize('NFC'));
    expect(passageUsed(nfd, nfc, 'was kostet das?')).toBe(true);
    expect(passageUsed(nfc, nfd.normalize('NFD'), 'was kostet das?')).toBe(true);
  });

  test('a word of an Indic script keeps its vowel signs: two long Hindi words are two weak tokens, not fragments', () => {
    const ex = 'प्रतिपूर्ति प्रक्रियाओं के लिए अनुमोदनकर्ता की आवश्यकता होती है।';
    expect(passageUsed('प्रतिपूर्ति के लिए अनुमोदनकर्ता चाहिए।', ex, 'क्या चाहिए?')).toBe(true);
    // Fragments a split at vowel signs produced do not match on their own: one word in common is one weak token.
    expect(passageUsed('प्रतिपूर्ति नहीं।', ex, 'क्या चाहिए?')).toBe(false);
  });

  test('Korean: a word of four syllables or more is weak, compared on its first three, whatever particle follows', () => {
    const ex = '환불정책은 구매 후 십사일 이내에 적용되며 영수증사본이 필요합니다.';
    // 환불정책은 / 환불정책을, 영수증사본이 / 영수증사본을: two weak tokens.
    expect(passageUsed('환불정책을 보면 영수증사본을 내야 합니다.', ex, '환불은 어떻게 하나요?')).toBe(true);
    // One word in common is not enough, and a sentence-final predicate (…니다) is never evidence.
    expect(passageUsed('환불정책을 확인하세요. 필요합니다.', ex, '환불은 어떻게 하나요?')).toBe(false);
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

  test('a title whose every word the query held is not named by its title: the answer repeats the question\'s topic', () => {
    const pricing = [{ id: '44444444-4444-4444-4444-444444444444', sourceId: 'note:p', title: 'Pricing' }];
    expect(citedItems('Our pricing: a website is 2400 euro.', pricing, "What's our pricing?")).toBe(0);
    // Without that query, or when the title adds a word the query did not hold, it is.
    expect(citedItems('Our pricing: a website is 2400 euro.', pricing, 'What do we charge for a website?')).toBe(1);
    expect(citedItems('See Pricing 2026: a website is 2400 euro.', items, "What's our pricing?")).toBe(1);
    // A long word is compared on its stem, as for "used": "renovations" holds "Renovation".
    const renovation = [{ id: '55555555-5555-5555-5555-555555555555', sourceId: 'note:r', title: 'Renovation' }];
    expect(citedItems('From the Renovation note: per project.', renovation, 'how do we price renovations?')).toBe(0);
    // A title in a script without spaces, held whole by the query.
    const zh = [{ id: '66666666-6666-6666-6666-666666666666', sourceId: 'note:z', title: '网站价格表' }];
    expect(citedItems('根据网站价格表，两千欧元。', zh, '网站价格表里写了什么？')).toBe(0);
    expect(citedItems('根据网站价格表，两千欧元。', zh, '网站多少钱？')).toBe(1);
    // The id still names it.
    expect(citedItems('As note:p says.', pricing, "What's our pricing?")).toBe(1);
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

  test('NFD and NFC are the same title, and a combining mark is part of the word', () => {
    expect(namesTitle('Siehe Überweisungsgebühr.'.normalize('NFD'), 'Überweisungsgebühr')).toBe(true);
    expect(namesTitle('Siehe Überweisungsgebühr.', 'Überweisungsgebühr'.normalize('NFD'))).toBe(true);
    // नीति ("policy") inside नीतियाँ is not named: the vowel signs after it continue the word.
    expect(namesTitle('सभी नीतियाँ देखें', 'नीति')).toBe(false);
    expect(namesTitle('यह नीति देखें', 'नीति')).toBe(true);
  });

  test('reads the first MAX_MEASURED_CHARS characters of the answer', () => {
    const filler = 'x '.repeat(MAX_MEASURED_CHARS / 2);
    expect(namesTitle(`${filler} Pricing`, 'Pricing')).toBe(false);
    expect(namesTitle(`Pricing ${filler}`, 'Pricing')).toBe(true);
    expect(passageUsed(`${filler} INV-2024-118`, 'Invoice INV-2024-118.', 'what?')).toBe(false);
    expect(passageUsed(`INV-2024-118 ${filler}`, 'Invoice INV-2024-118.', 'what?')).toBe(true);
  });

  test('a long answer full of the title inside other words is read in linear time', () => {
    // ~3,600 occurrences, none on a word boundary: each was a copy of the
    // whole prefix and suffix before, 1.7 s for one title on 50k characters.
    const answer = 'Testx '.repeat(8_400);
    expect(answer.length).toBeGreaterThan(50_000);
    const passages = Array.from({ length: 10 }, (_, i) => ({ excerpt: `Passage ${i}: Testx and E${1000 + i}.`, query: 'q' }));
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `id-${i}`, sourceId: `note:${i}`, title: 'Test' }));
    const started = performance.now();
    expect(citedItems(answer, items)).toBe(0);
    usedPassages(answer, passages);
    // The old code took over 10 s for these ten titles; a slow runner does this in well under one.
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('four characters at the least, after the extension is stripped', () => {
    expect(namesTitle('Ask the AI.', 'AI')).toBe(false);
    expect(namesTitle('the faq says', 'faq.md')).toBe(false);
    expect(namesTitle('the plan says', 'plan.md')).toBe(true);
  });
});

describe('calibration', () => {
  test('which runs count: those whose record says how the bar went', () => {
    const cleared = { minSimilarity: 0.45, cleared: true };
    const notCleared = { minSimilarity: 0.45, cleared: false };
    // Shown, or found and then left out (over budget, shared budget spent, commit failed): the bar let it through.
    expect(calibrationSample({ bar: cleared })).toBe('found');
    // Nothing found, or only passages shown on keywords or an identifier: nothing cleared the bar.
    expect(calibrationSample({ bar: notCleared })).toBe('nothing');
    // Degraded to keywords: no cosine was compared.
    expect(calibrationSample({ bar: notCleared, degraded: 'embedding_failed' })).toBeNull();
    // No bar: not searched (short message, no embedding model, timeout), or decided by the earlier rules.
    expect(calibrationSample({})).toBeNull();
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

  test('the message points at the sweep, and for another hook at its own setting', () => {
    expect(calibrationMessage('Knowledge recall', 'injects_nearly_always', 39, 40)).toMatch(/cleared its minSimilarity on 98% of the 40 messages.*too low.*threshold sweep.*apply the value/s);
    expect(calibrationMessage('Knowledge recall', 'injects_almost_never', 1, 40)).toMatch(/3% of the 40 messages.*too high.*threshold sweep/s);
    const custom = calibrationMessage('Contracts', 'injects_nearly_always', 39, 40, false);
    expect(custom).toMatch(/Knowledge recall's other settings.*as Contracts's minSimilarity/s);
    expect(custom).not.toMatch(/apply the value/);
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
