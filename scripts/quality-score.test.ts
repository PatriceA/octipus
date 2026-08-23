import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseTargets, type QualityMetrics, type QualityTargets, scoreQuality } from './quality-score';

const TARGETS: QualityTargets = {
  deliveredPct: 95,
  lagP95Seconds: 10,
  paidTokensPerRun: 60_000,
  autonomyPct: 90,
  minSamples: 20,
};

function metrics(over: Partial<Record<keyof QualityMetrics, { value: number | null; n: number }>> = {}): QualityMetrics {
  const mk = (value: number | null, n: number, unit: string) => ({ value, n, unit });
  return {
    deliveredPct: mk(over.deliveredPct?.value ?? 100, over.deliveredPct?.n ?? 50, '%'),
    lagP95Seconds: mk(over.lagP95Seconds?.value ?? 2, over.lagP95Seconds?.n ?? 50, 's'),
    paidTokensPerRun: mk(over.paidTokensPerRun?.value ?? 10_000, over.paidTokensPerRun?.n ?? 50, 'tok'),
    autonomyPct: mk(over.autonomyPct?.value ?? 100, over.autonomyPct?.n ?? 50, '%'),
  };
}

describe('scoreQuality', () => {
  test('all four axes met is the stopping condition', () => {
    const v = scoreQuality(metrics(), TARGETS);
    expect(v.ok).toBe(true);
    expect(v.complete).toBe(true);
    expect(v.summary).toContain('stopping condition');
  });

  test('direction is per-axis: lag and cost are better when smaller', () => {
    expect(scoreQuality(metrics({ lagP95Seconds: { value: 40, n: 50 } }), TARGETS).ok).toBe(false);
    expect(scoreQuality(metrics({ paidTokensPerRun: { value: 90_000, n: 50 } }), TARGETS).ok).toBe(false);
    // ...and worse when smaller for the two percentages.
    expect(scoreQuality(metrics({ deliveredPct: { value: 50, n: 50 } }), TARGETS).ok).toBe(false);
    expect(scoreQuality(metrics({ autonomyPct: { value: 10, n: 50 } }), TARGETS).ok).toBe(false);
  });

  test('an axis with no data is n/a — never a silent pass', () => {
    const v = scoreQuality(metrics({ deliveredPct: { value: null, n: 0 } }), TARGETS);
    const delivered = v.axes.find((a) => a.axis === 'deliveredPct')!;
    expect(delivered.status).toBe('n/a');
    expect(v.complete).toBe(false);
    // The other three still passed, so `ok` is true — which is precisely why
    // the gate requires `complete` as well.
    expect(v.ok).toBe(true);
    expect(v.summary).toContain('No stopping condition');
  });

  test('a target met on too few samples is not met', () => {
    const v = scoreQuality(metrics({ lagP95Seconds: { value: 1, n: 3 } }), TARGETS);
    const lag = v.axes.find((a) => a.axis === 'lagP95Seconds')!;
    expect(lag.status).toBe('n/a');
    expect(lag.note).toContain('need 20');
  });

  test('an entirely empty install scores nothing and claims nothing', () => {
    const empty = metrics({
      deliveredPct: { value: null, n: 0 },
      lagP95Seconds: { value: null, n: 0 },
      paidTokensPerRun: { value: null, n: 0 },
      autonomyPct: { value: null, n: 0 },
    });
    const v = scoreQuality(empty, TARGETS);
    expect(v.complete).toBe(false);
    expect(v.axes.every((a) => a.status === 'n/a')).toBe(true);
  });
});

describe('parseTargets', () => {
  test('the committed baseline parses and carries every axis', () => {
    const t = parseTargets(readFileSync(join(import.meta.dirname, 'quality-baseline.json'), 'utf8'));
    expect(t.deliveredPct).toBeGreaterThan(0);
    expect(t.minSamples).toBeGreaterThan(0);
  });

  test('a missing or non-numeric target fails loud rather than passing everything', () => {
    // NaN comparisons are all false, so a silently-missing target would make
    // its axis unfailable — the same class of bug coverage-check.ts guards.
    expect(() => parseTargets('{"targets":{}}')).toThrow(/deliveredPct/);
    expect(() => parseTargets('{"targets":{"deliveredPct":"95"}}')).toThrow(/deliveredPct/);
  });
});
