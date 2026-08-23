import { describe, expect, test } from 'vitest';
import { formatLongDate, formatDateTimeContext } from './date-context';

describe('formatLongDate', () => {
  test('renders weekday, month, day, year in en-US', () => {
    // Use UTC noon so the local-clock date is stable regardless of test TZ.
    const d = new Date('2026-06-15T12:00:00Z');
    const out = formatLongDate(d);
    expect(out).toContain('2026');
    expect(out).toMatch(/^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, \d{4}$/);
  });
});

describe('formatDateTimeContext', () => {
  const d = new Date('2026-06-15T12:00:00Z');

  test('appends 24h time and the IANA timezone label', () => {
    const out = formatDateTimeContext(d);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(out.startsWith(formatLongDate(d))).toBe(true);
    expect(out).toContain(`(${tz})`);
    // 24h HH:MM time present.
    expect(out).toMatch(/\d{2}:\d{2}/);
  });

  test('all fields come from one clock — date in the string never disagrees with the long date', () => {
    const out = formatDateTimeContext(d);
    // The long-date prefix and the timezone-labelled context share the same
    // Date instance, so no UTC/local split can produce two different days.
    expect(out).toContain(formatLongDate(d));
  });
});
