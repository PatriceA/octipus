import { describe, expect, test } from 'vitest';
import { runEvaluation } from './runner';
import type { EvalDataPoint, Evaluator, EvalScore } from './types';

// ── Helpers ───────────────────────────────────────────────────

function makeDataPoint(id: string, overrides: Partial<EvalDataPoint> = {}): EvalDataPoint {
  return {
    id,
    input: 'What is 2+2?',
    output: 'The answer is 4.',
    model: 'test-model',
    provider: 'test',
    ...overrides,
  };
}

function makeEvaluator(
  name: string,
  scoreFn: (dp: EvalDataPoint) => EvalScore | Promise<EvalScore>,
): Evaluator {
  return {
    name,
    description: `Test evaluator: ${name}`,
    evaluate: async (dp) => scoreFn(dp),
  };
}

const passingEvaluator = makeEvaluator('pass-always', () => ({
  metric: 'pass-always',
  score: 1.0,
  status: 'PASS',
  reasoning: 'Always passes',
}));

const failingEvaluator = makeEvaluator('fail-always', () => ({
  metric: 'fail-always',
  score: 0.0,
  status: 'FAIL',
  reasoning: 'Always fails',
}));

// ── runEvaluation ─────────────────────────────────────────────

describe('runEvaluation', () => {
  test('returns an EvalRun with correct structure', async () => {
    const dataset = [makeDataPoint('dp-1')];
    const run = await runEvaluation(dataset, [passingEvaluator]);

    expect(typeof run.id).toBe('string');
    expect(run.id.length).toBeGreaterThan(0);
    expect(typeof run.name).toBe('string');
    expect(run.model).toBe('test-model');
    expect(Array.isArray(run.evaluators)).toBe(true);
    expect(Array.isArray(run.results)).toBe(true);
    expect(typeof run.summary).toBe('object');
    expect(run.createdAt).toBeInstanceOf(Date);
  });

  test('processes all data points', async () => {
    const dataset = [
      makeDataPoint('dp-1'),
      makeDataPoint('dp-2'),
      makeDataPoint('dp-3'),
    ];
    const run = await runEvaluation(dataset, [passingEvaluator]);

    expect(run.results).toHaveLength(3);
    const ids = run.results.map((r) => r.dataPointId);
    expect(ids).toContain('dp-1');
    expect(ids).toContain('dp-2');
    expect(ids).toContain('dp-3');
  });

  test('each result has dataPointId, scores, and timestamp', async () => {
    const dataset = [makeDataPoint('dp-1')];
    const run = await runEvaluation(dataset, [passingEvaluator]);

    const result = run.results[0];
    expect(result.dataPointId).toBe('dp-1');
    expect(Array.isArray(result.scores)).toBe(true);
    expect(result.timestamp).toBeInstanceOf(Date);
  });

  test('empty dataset returns empty results and empty summary', async () => {
    const run = await runEvaluation([], [passingEvaluator]);

    expect(run.results).toHaveLength(0);
    expect(Object.keys(run.summary)).toHaveLength(0);
    expect(run.model).toBe('unknown');
  });

  describe('summary aggregation', () => {
    test('single evaluator: 100% pass rate and mean=1.0', async () => {
      const dataset = [makeDataPoint('dp-1'), makeDataPoint('dp-2')];
      const run = await runEvaluation(dataset, [passingEvaluator]);

      const s = run.summary['pass-always'];
      expect(s).toBeDefined();
      expect(s.mean).toBe(1.0);
      expect(s.passRate).toBe(1.0);
      expect(s.count).toBe(2);
    });

    test('single evaluator: 0% pass rate and mean=0.0', async () => {
      const dataset = [makeDataPoint('dp-1'), makeDataPoint('dp-2')];
      const run = await runEvaluation(dataset, [failingEvaluator]);

      const s = run.summary['fail-always'];
      expect(s.mean).toBe(0.0);
      expect(s.passRate).toBe(0.0);
      expect(s.count).toBe(2);
    });

    test('mixed results: 50% pass rate', async () => {
      let call = 0;
      const alternatingEvaluator = makeEvaluator('alternating', () => {
        const pass = call++ % 2 === 0;
        return {
          metric: 'alternating',
          score: pass ? 1.0 : 0.0,
          status: pass ? 'PASS' : 'FAIL',
        };
      });

      const dataset = [
        makeDataPoint('dp-1'),
        makeDataPoint('dp-2'),
        makeDataPoint('dp-3'),
        makeDataPoint('dp-4'),
      ];
      const run = await runEvaluation(dataset, [alternatingEvaluator]);

      const s = run.summary['alternating'];
      expect(s.passRate).toBe(0.5);
      expect(s.mean).toBeCloseTo(0.5);
      expect(s.count).toBe(4);
    });

    test('multiple evaluators each get their own summary entry', async () => {
      const dataset = [makeDataPoint('dp-1')];
      const run = await runEvaluation(dataset, [passingEvaluator, failingEvaluator]);

      expect(run.summary['pass-always']).toBeDefined();
      expect(run.summary['fail-always']).toBeDefined();
      expect(run.evaluators).toContain('pass-always');
      expect(run.evaluators).toContain('fail-always');
    });

    test('mean is rounded to 3 decimal places', async () => {
      // Score 2/3 = 0.666... should round to 0.667
      let call = 0;
      const ev = makeEvaluator('fractional', () => {
        call++;
        const pass = call <= 2; // first 2 pass, last fails
        return { metric: 'fractional', score: pass ? 1.0 : 0.0, status: pass ? 'PASS' : 'FAIL' };
      });

      const dataset = [makeDataPoint('a'), makeDataPoint('b'), makeDataPoint('c')];
      const run = await runEvaluation(dataset, [ev]);

      const s = run.summary['fractional'];
      // 2/3 ≈ 0.667
      expect(s.mean).toBeCloseTo(0.667, 2);
    });
  });

  describe('progress callback', () => {
    test('called once per data point with correct counts', async () => {
      const dataset = [makeDataPoint('dp-1'), makeDataPoint('dp-2'), makeDataPoint('dp-3')];
      const calls: Array<[number, number]> = [];

      await runEvaluation(dataset, [passingEvaluator], {
        onProgress: (completed, total) => {
          calls.push([completed, total]);
        },
      });

      expect(calls).toHaveLength(3);
      expect(calls[0]).toEqual([1, 3]);
      expect(calls[1]).toEqual([2, 3]);
      expect(calls[2]).toEqual([3, 3]);
    });

    test('no callback: does not crash', async () => {
      const dataset = [makeDataPoint('dp-1')];
      // Should not throw even when onProgress is undefined
      const run = await runEvaluation(dataset, [passingEvaluator]);
      expect(run.results).toHaveLength(1);
    });
  });

  describe('error handling', () => {
    test('evaluator that throws does not crash the runner', async () => {
      const throwingEvaluator = makeEvaluator('throws', () => {
        throw new Error('Evaluator blew up');
      });

      const dataset = [makeDataPoint('dp-1'), makeDataPoint('dp-2')];

      // Should not throw
      const run = await runEvaluation(dataset, [throwingEvaluator]);

      // Both data points should have a result
      expect(run.results).toHaveLength(2);

      // Each result should have a score with error reasoning
      for (const result of run.results) {
        const score = result.scores.find((s) => s.metric === 'throws');
        expect(score).toBeDefined();
        expect(score!.status).toBe('UNKNOWN');
        expect(score!.reasoning).toContain('Evaluator blew up');
      }
    });

    test('one failing evaluator does not prevent other evaluators from running', async () => {
      const throwingEvaluator = makeEvaluator('throws', () => {
        throw new Error('boom');
      });

      const dataset = [makeDataPoint('dp-1')];
      const run = await runEvaluation(dataset, [throwingEvaluator, passingEvaluator]);

      const result = run.results[0];
      expect(result.scores).toHaveLength(2);

      const passScore = result.scores.find((s) => s.metric === 'pass-always');
      expect(passScore!.status).toBe('PASS');
    });

    test('evaluator errors per-datapoint: later datapoints still processed', async () => {
      let call = 0;
      const sometimesThrows = makeEvaluator('sometimes', () => {
        call++;
        if (call === 1) throw new Error('first call fails');
        return { metric: 'sometimes', score: 1.0, status: 'PASS' };
      });

      const dataset = [makeDataPoint('dp-1'), makeDataPoint('dp-2')];
      const run = await runEvaluation(dataset, [sometimesThrows]);

      expect(run.results).toHaveLength(2);

      const first = run.results.find((r) => r.dataPointId === 'dp-1')!;
      const second = run.results.find((r) => r.dataPointId === 'dp-2')!;

      expect(first.scores[0].status).toBe('UNKNOWN');
      expect(second.scores[0].status).toBe('PASS');
    });
  });

  describe('batching', () => {
    test('custom batchSize still processes all data points', async () => {
      const dataset = Array.from({ length: 7 }, (_, i) => makeDataPoint(`dp-${i}`));
      const run = await runEvaluation(dataset, [passingEvaluator], { batchSize: 2 });

      expect(run.results).toHaveLength(7);
      expect(run.summary['pass-always'].count).toBe(7);
    });

    test('batchSize larger than dataset processes everything in one batch', async () => {
      const dataset = [makeDataPoint('dp-1'), makeDataPoint('dp-2')];
      const run = await runEvaluation(dataset, [passingEvaluator], { batchSize: 100 });

      expect(run.results).toHaveLength(2);
    });
  });

  describe('concurrency', () => {
    test('concurrency=2 still produces correct results', async () => {
      const dataset = [makeDataPoint('dp-1'), makeDataPoint('dp-2'), makeDataPoint('dp-3')];
      const run = await runEvaluation(dataset, [passingEvaluator, failingEvaluator], {
        concurrency: 2,
      });

      expect(run.results).toHaveLength(3);
      for (const result of run.results) {
        expect(result.scores).toHaveLength(2);
      }
      expect(run.summary['pass-always'].mean).toBe(1.0);
      expect(run.summary['fail-always'].mean).toBe(0.0);
    });
  });

  describe('run metadata', () => {
    test('uses model from first data point', async () => {
      const dataset = [makeDataPoint('dp-1', { model: 'gpt-4o' })];
      const run = await runEvaluation(dataset, [passingEvaluator]);
      expect(run.model).toBe('gpt-4o');
    });

    test('custom name option is used', async () => {
      const dataset = [makeDataPoint('dp-1')];
      const run = await runEvaluation(dataset, [passingEvaluator], {
        name: 'my-custom-eval-run',
      });
      expect(run.name).toBe('my-custom-eval-run');
    });

    test('evaluators list matches provided evaluator names', async () => {
      const dataset = [makeDataPoint('dp-1')];
      const run = await runEvaluation(dataset, [passingEvaluator, failingEvaluator]);
      expect(run.evaluators).toEqual(['pass-always', 'fail-always']);
    });
  });
});
