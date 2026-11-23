import { describe, expect, test } from 'vitest';
import { dueChipLabel, parseQuickAdd, quickAddDueAt } from './quick-add';

// Monday 23 November 2026, 10:00 in Berlin (09:00 UTC).
const NOW = new Date('2026-11-23T09:00:00Z');
const BERLIN = { now: NOW, timezone: 'Europe/Berlin' };
const parse = (text: string, lists?: string[]) => parseQuickAdd(text, { ...BERLIN, lists });

describe('parseQuickAdd', () => {
  test('the example from the brief: date, time, priority and list come out of the title', () => {
    const p = parse('call dentist tomorrow 3pm !high #personal');
    expect(p).toMatchObject({
      title: 'call dentist',
      due: { date: '2026-11-24', time: '15:00' },
      priority: 3,
      category: 'personal',
      important: false,
      repeat: null,
    });
    expect(p.tokens.map((t) => [t.kind, t.text, t.label])).toEqual([
      ['due', 'tomorrow', 'Tomorrow'],
      ['time', '3pm', '15:00'],
      ['priority', '!high', 'High'],
      ['list', '#personal', '#personal'],
    ]);
    // Spans point into the original text, for chips and highlighting.
    for (const t of p.tokens) expect('call dentist tomorrow 3pm !high #personal'.slice(t.start, t.end)).toBe(t.text);
  });

  test('plain text is left alone', () => {
    expect(parse('Buy 3 apples and 2 pears')).toMatchObject({ title: 'Buy 3 apples and 2 pears', due: null, priority: null, tokens: [] });
    expect(parse('Read about the sun in may')).toMatchObject({ title: 'Read about the sun in may', due: null });
    expect(parse('Email bob@example.com re #3 issue!')).toMatchObject({ title: 'Email bob@example.com re #3 issue!' });
  });

  test('a text that would leave no title is taken literally', () => {
    expect(parse('Tomorrow')).toMatchObject({ title: 'Tomorrow', due: null, tokens: [] });
    expect(parse('  !high  ')).toMatchObject({ title: '!high', priority: null });
  });

  test.each([
    ['today', '2026-11-23'],
    ['tomorrow', '2026-11-24'],
    ['tmrw', '2026-11-24'],
    ['day after tomorrow', '2026-11-25'],
    ['wednesday', '2026-11-25'],
    ['on fri', '2026-11-27'],
    ['by Friday', '2026-11-27'],
    // Today is Monday: "monday" is next week's, not today.
    ['monday', '2026-11-30'],
    ['next tue', '2026-12-01'],
    ['next week', '2026-11-30'],
    ['this weekend', '2026-11-28'],
    ['next month', '2026-12-01'],
    ['in 3 days', '2026-11-26'],
    ['in 2 weeks', '2026-12-07'],
    ['in a month', '2026-12-23'],
    ['2027-02-14', '2027-02-14'],
    ['dec 5', '2026-12-05'],
    ['5th December', '2026-12-05'],
    // A month day already past this year is next year's.
    ['on March 1st', '2027-03-01'],
    ['nov 2 2027', '2027-11-02'],
  ])('"%s" is due %s', (phrase, date) => {
    const p = parse(`Pay rent ${phrase}`);
    expect(p.title).toBe('Pay rent');
    expect(p.due).toEqual({ date, time: null });
  });

  test('an impossible date is not a date', () => {
    expect(parse('Plan feb 30 party')).toMatchObject({ title: 'Plan feb 30 party', due: null });
  });

  test.each([
    ['at 9', '09:00'],
    ['9am', '09:00'],
    ['12am', '00:00'],
    ['12pm', '12:00'],
    ['3:30 pm', '15:30'],
    ['17:45', '17:45'],
    ['at noon', '12:00'],
    ['in the evening', '18:00'],
  ])('time "%s" is %s', (phrase, time) => {
    expect(parse(`Standup tomorrow ${phrase}`)).toMatchObject({ title: 'Standup', due: { date: '2026-11-24', time } });
  });

  test('a time alone is today while it is still ahead, else tomorrow', () => {
    // It is 10:00 in Berlin.
    expect(parse('Call Ana 11:00').due).toEqual({ date: '2026-11-23', time: '11:00' });
    expect(parse('Call Ana 8am').due).toEqual({ date: '2026-11-24', time: '08:00' });
  });

  test('tonight is today at 20:00 unless a time is given', () => {
    expect(parse('Take out bins tonight').due).toEqual({ date: '2026-11-23', time: '20:00' });
    expect(parse('Take out bins tonight 21:30').due).toEqual({ date: '2026-11-23', time: '21:30' });
  });

  test('"today" is the user\'s day, not UTC\'s', () => {
    // 23:30 UTC on the 23rd is already the 24th in Berlin.
    const late = parseQuickAdd('Water plants today', { now: new Date('2026-11-23T23:30:00Z'), timezone: 'Europe/Berlin' });
    expect(late.due?.date).toBe('2026-11-24');
    const ny = parseQuickAdd('Water plants today', { now: new Date('2026-11-23T03:00:00Z'), timezone: 'America/New_York' });
    expect(ny.due?.date).toBe('2026-11-22');
  });

  test.each([
    ['!high', 3], ['!!!', 3], ['!3', 3], ['!medium', 2], ['!!', 2], ['!med', 2], ['!low', 1], ['!', 1], ['!1', 1],
  ])('priority %s is %d', (mark, priority) => {
    expect(parse(`Fix the tap ${mark}`)).toMatchObject({ title: 'Fix the tap', priority });
  });

  test('a star marks it important', () => {
    expect(parse('* Renew passport')).toMatchObject({ title: 'Renew passport', important: true });
    expect(parse('Renew passport !important')).toMatchObject({ title: 'Renew passport', important: true });
    // Not inside a word.
    expect(parse('Check a*b formula')).toMatchObject({ important: false });
  });

  test('a list matches an existing one by name, else is kept as typed', () => {
    expect(parse('Mop the floor #house-work', ['House work', 'Shopping']).category).toBe('House work');
    expect(parse('Milk #SHOPPING', ['House work', 'Shopping']).category).toBe('Shopping');
    expect(parse('Milk #groceries', ['Shopping']).category).toBe('groceries');
    // Only the first list counts; the second stays in the title.
    expect(parse('Milk #a #b')).toMatchObject({ title: 'Milk #b', category: 'a' });
  });

  test.each([
    ['daily', { unit: 'day', interval: 1 }],
    ['every day', { unit: 'day', interval: 1 }],
    ['weekdays', { unit: 'week', interval: 1, weekdays: [1, 2, 3, 4, 5] }],
    ['every weekday', { unit: 'week', interval: 1, weekdays: [1, 2, 3, 4, 5] }],
    ['weekly', { unit: 'week', interval: 1 }],
    ['every month', { unit: 'month', interval: 1 }],
    ['yearly', { unit: 'year', interval: 1 }],
    ['every 2 weeks', { unit: 'week', interval: 2 }],
    ['every other day', { unit: 'day', interval: 2 }],
  ])('repeat "%s"', (phrase, repeat) => {
    expect(parse(`Stretch ${phrase}`)).toMatchObject({ title: 'Stretch', repeat });
  });

  test('"every <weekday>" repeats weekly and is first due on the next such day', () => {
    const p = parse('Team sync every tue and thu 9am');
    expect(p).toMatchObject({ title: 'Team sync', repeat: { unit: 'week', interval: 1, weekdays: [2, 4] }, due: { date: '2026-11-24', time: '09:00' } });
    // Today counts when it is one of the days.
    expect(parse('Gym every monday').due).toEqual({ date: '2026-11-23', time: null });
  });

  test('every token kind together, in any order', () => {
    const p = parse('#work !! weekly Send report on friday 4pm *', ['Work']);
    expect(p).toMatchObject({
      title: 'Send report',
      category: 'Work',
      priority: 2,
      important: true,
      repeat: { unit: 'week', interval: 1 },
      due: { date: '2026-11-27', time: '16:00' },
    });
  });
});

describe('quickAddDueAt', () => {
  test('a day stays a bare date; a time becomes the instant in the zone', () => {
    expect(quickAddDueAt(null, 'UTC')).toBeNull();
    expect(quickAddDueAt({ date: '2026-11-24', time: null }, 'Europe/Berlin')).toBe('2026-11-24');
    expect(quickAddDueAt({ date: '2026-11-24', time: '15:00' }, 'Europe/Berlin')).toBe('2026-11-24T14:00:00.000Z');
    // Across the DST change in New York.
    expect(quickAddDueAt({ date: '2026-03-08', time: '09:00' }, 'America/New_York')).toBe('2026-03-08T13:00:00.000Z');
  });
});

describe('dueChipLabel', () => {
  test('relative within a week, else the date', () => {
    expect(dueChipLabel('2026-11-23', '2026-11-23')).toBe('Today');
    expect(dueChipLabel('2026-11-24', '2026-11-23')).toBe('Tomorrow');
    expect(dueChipLabel('2026-11-27', '2026-11-23')).toBe('Friday');
    expect(dueChipLabel('2026-12-05', '2026-11-23')).toBe('Sat, Dec 5');
    expect(dueChipLabel('2027-01-05', '2026-11-23')).toBe('Tue, Jan 5 2027');
  });
});
