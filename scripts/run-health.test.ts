import { describe, expect, test } from 'bun:test';
import { fmt, percentile } from './run-health';

describe('percentile (nearest-rank)', () => {
  test('returns a value that a real run actually had', () => {
    const lags = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // Nearest-rank, not interpolated: every answer is drawn from the input.
    expect(lags).toContain(percentile(lags, 50));
    expect(lags).toContain(percentile(lags, 95));
  });

  test('p50 and p95 on the observed baseline', () => {
    // The 24 real runs that motivated this script, ascending.
    const lags = [
      0, 0, 12.3, 12.7, 13.1, 13.5, 14.5, 15.7, 16, 31.4, 35.2, 40, 46.4, 51.9,
      58, 66, 69.3, 383.6, 844.9, 897.6, 897.7, 897.9, 897.9, 897.9,
    ];
    expect(percentile(lags, 50)).toBe(40);
    expect(percentile(lags, 95)).toBe(897.9);
  });

  test('edges: empty, single, and the extremes', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 100)).toBe(3);
  });
});

describe('fmt', () => {
  test('keeps sub-second and sub-minute values legible', () => {
    // The whole point of the report is the number; "0min" would hide it.
    expect(fmt(0.25)).toBe('250ms');
    expect(fmt(1)).toBe('1.0s');
    expect(fmt(43.2)).toBe('43.2s');
  });

  test('minutes carry their seconds, zero-padded', () => {
    expect(fmt(60)).toBe('1m00s');
    expect(fmt(897.9)).toBe('14m58s');
    expect(fmt(6210)).toBe('103m30s');
  });
});
