import { describe, expect, test } from 'bun:test';
import { type CoverageBaseline, evaluateCoverage, parseBaseline, parseLcov } from './coverage-check';

// Minimal lcov: 2 files. Totals: lines 15/20 = 75%, functions 3/4 = 75%.
const LCOV = [
  'SF:src/a.ts',
  'FNF:2',
  'FNH:2',
  'LF:10',
  'LH:8',
  'end_of_record',
  'SF:src/b.ts',
  'FNF:2',
  'FNH:1',
  'LF:10',
  'LH:7',
  'end_of_record',
].join('\n');

const baseline = (over: Partial<CoverageBaseline> = {}): CoverageBaseline => ({
  lines: 70,
  functions: 70,
  tolerance: 0.5,
  ...over,
});

describe('parseLcov', () => {
  test('sums LF/LH/FNF/FNH across files', () => {
    const t = parseLcov(LCOV);
    expect(t.lines).toEqual({ hit: 15, found: 20, pct: 75 });
    expect(t.functions).toEqual({ hit: 3, found: 4, pct: 75 });
  });

  test('treats a zero-denominator as 100% (no found lines)', () => {
    const t = parseLcov('SF:x\nLF:0\nLH:0\nFNF:0\nFNH:0\nend_of_record');
    expect(t.lines.pct).toBe(100);
    expect(t.functions.pct).toBe(100);
  });
});

describe('evaluateCoverage', () => {
  test('passes when coverage is at or above the floor', () => {
    const v = evaluateCoverage(LCOV, baseline({ lines: 75, functions: 75 }));
    expect(v.ok).toBe(true);
    expect(v.failures).toHaveLength(0);
  });

  test('tolerates a drop within tolerance', () => {
    // baseline 75.3, tolerance 0.5 → floor 74.8; actual 75% passes.
    const v = evaluateCoverage(LCOV, baseline({ lines: 75.3, functions: 75.3 }));
    expect(v.ok).toBe(true);
  });

  test('fails when line coverage drops below the floor', () => {
    const v = evaluateCoverage(LCOV, baseline({ lines: 80, functions: 70 }));
    expect(v.ok).toBe(false);
    expect(v.failures.join('\n')).toContain('line coverage 75.00%');
  });

  test('fails when function coverage drops below the floor', () => {
    const v = evaluateCoverage(LCOV, baseline({ lines: 70, functions: 90 }));
    expect(v.ok).toBe(false);
    expect(v.failures.join('\n')).toContain('function coverage 75.00%');
  });

  test('flags an improvement worth bumping the baseline', () => {
    const v = evaluateCoverage(LCOV, baseline({ lines: 60, functions: 60 }));
    expect(v.ok).toBe(true);
    expect(v.improvements.length).toBeGreaterThan(0);
    expect(v.summaryMarkdown).toContain('bump');
  });

  test('summary is markdown with a metrics table', () => {
    const v = evaluateCoverage(LCOV, baseline());
    expect(v.summaryMarkdown).toContain('## Test coverage');
    expect(v.summaryMarkdown).toContain('| Lines | 75.00% |');
  });

  test('FAILS on an empty/dataless lcov instead of reporting 100%', () => {
    const v = evaluateCoverage('', baseline());
    expect(v.ok).toBe(false);
    expect(v.failures.join('\n')).toContain('no line coverage data');
  });
});

describe('parseBaseline', () => {
  test('parses a valid baseline', () => {
    expect(parseBaseline('{"lines":51.4,"functions":59.3,"tolerance":0.5}')).toEqual({
      lines: 51.4,
      functions: 59.3,
      tolerance: 0.5,
    });
  });

  test('throws on a missing key (would otherwise make the ratchet a silent no-op)', () => {
    expect(() => parseBaseline('{"lines":51.4,"functions":59.3}')).toThrow(/tolerance/);
  });

  test('throws on a non-numeric key', () => {
    expect(() => parseBaseline('{"lines":"51.4","functions":59.3,"tolerance":0.5}')).toThrow(/lines/);
  });
});
