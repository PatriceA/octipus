import { randomUUID } from 'crypto';
import type { EvalDataPoint, EvalResult, EvalRun, EvalScore, Evaluator } from './types';

export interface RunEvaluationOptions {
  /** How many data points to process per batch (default 5) */
  batchSize?: number;
  /** Max concurrent evaluators per data point (default 1) */
  concurrency?: number;
  /** Progress callback */
  onProgress?: (completed: number, total: number) => void;
  /** Optional run name */
  name?: string;
}

/**
 * Run a set of evaluators over a dataset and aggregate the results.
 */
export async function runEvaluation(
  dataset: EvalDataPoint[],
  evaluators: Evaluator[],
  options?: RunEvaluationOptions,
): Promise<EvalRun> {
  const batchSize = options?.batchSize ?? 5;
  const concurrency = options?.concurrency ?? 1;
  const total = dataset.length;
  let completed = 0;

  const allResults: EvalResult[] = [];

  // Process data points in batches
  for (let i = 0; i < dataset.length; i += batchSize) {
    const batch = dataset.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (dataPoint) => {
        const scores = await runEvaluatorsOnPoint(dataPoint, evaluators, concurrency);
        completed++;
        options?.onProgress?.(completed, total);
        return {
          dataPointId: dataPoint.id,
          scores,
          timestamp: new Date(),
        } satisfies EvalResult;
      }),
    );

    allResults.push(...batchResults);
  }

  // Aggregate summary per evaluator
  const summary: Record<string, { mean: number; passRate: number; count: number }> = {};

  for (const evaluator of evaluators) {
    const metricScores: EvalScore[] = [];
    for (const result of allResults) {
      const score = result.scores.find((s) => s.metric === evaluator.name);
      if (score) metricScores.push(score);
    }

    if (metricScores.length > 0) {
      const mean =
        metricScores.reduce((sum, s) => sum + s.score, 0) / metricScores.length;
      const passCount = metricScores.filter((s) => s.status === 'PASS').length;
      summary[evaluator.name] = {
        mean: Math.round(mean * 1000) / 1000,
        passRate: Math.round((passCount / metricScores.length) * 1000) / 1000,
        count: metricScores.length,
      };
    }
  }

  // Determine model from first data point (assumes homogeneous dataset)
  const model = dataset[0]?.model ?? 'unknown';

  return {
    id: randomUUID(),
    name: options?.name ?? `eval-${model}-${new Date().toISOString().slice(0, 19)}`,
    model,
    evaluators: evaluators.map((e) => e.name),
    results: allResults,
    summary,
    createdAt: new Date(),
  };
}

/**
 * Run evaluators on a single data point, respecting concurrency limit.
 */
async function runEvaluatorsOnPoint(
  dataPoint: EvalDataPoint,
  evaluators: Evaluator[],
  concurrency: number,
): Promise<EvalScore[]> {
  const scores: EvalScore[] = [];

  if (concurrency <= 1) {
    // Sequential execution
    for (const evaluator of evaluators) {
      try {
        const score = await evaluator.evaluate(dataPoint);
        scores.push(score);
      } catch (error) {
        scores.push({
          metric: evaluator.name,
          score: 0,
          status: 'UNKNOWN',
          reasoning: `Evaluator error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  } else {
    // Concurrent execution with limited parallelism
    const queue = [...evaluators];
    const running: Promise<void>[] = [];

    const processNext = async (): Promise<void> => {
      while (queue.length > 0) {
        const evaluator = queue.shift()!;
        try {
          const score = await evaluator.evaluate(dataPoint);
          scores.push(score);
        } catch (error) {
          scores.push({
            metric: evaluator.name,
            score: 0,
            status: 'UNKNOWN',
            reasoning: `Evaluator error: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    };

    for (let c = 0; c < Math.min(concurrency, evaluators.length); c++) {
      running.push(processNext());
    }

    await Promise.all(running);
  }

  return scores;
}
