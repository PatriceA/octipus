import { desc, eq, } from 'drizzle-orm';
import type { EvalRun } from '@/models/evaluation/types';
import type { ConformanceReport } from '@/models/testing/conformance';
import { dbLogger } from '@/utils/logger';
import { getDb } from '../postgres';
import type {
  ConformanceRunEntry,
  EvalRunEntry,
  NewConformanceRunEntry,
  NewEvalRunEntry,
} from '../schema/evaluations';
import { conformanceRuns, evalRuns } from '../schema/evaluations';

export class EvaluationRepository {
  private get db() {
    return getDb();
  }

  // ── Conformance runs ──────────────────────────────────────────

  async saveConformanceRun(
    userId: string,
    report: ConformanceReport
  ): Promise<ConformanceRunEntry> {
    const models = [...new Set(report.results.map((r) => r.model))];
    const data: NewConformanceRunEntry = {
      userId,
      models,
      results: report.results,
      summary: {
        passed: report.summary.passed,
        failed: report.summary.failed,
        skipped: report.summary.skipped,
        totalMs: report.summary.durationMs,
      },
    };

    const result = await this.db
      .insert(conformanceRuns)
      .values(data)
      .returning();

    dbLogger.info(
      { runId: result[0].id, userId, models: models.length },
      'Conformance run saved'
    );
    return result[0];
  }

  async getConformanceRuns(
    userId: string,
    limit: number = 20
  ): Promise<ConformanceRunEntry[]> {
    return this.db
      .select()
      .from(conformanceRuns)
      .where(eq(conformanceRuns.userId, userId))
      .orderBy(desc(conformanceRuns.createdAt))
      .limit(limit);
  }

  async getConformanceRun(id: string): Promise<ConformanceRunEntry | null> {
    const result = await this.db
      .select()
      .from(conformanceRuns)
      .where(eq(conformanceRuns.id, id))
      .limit(1);
    return result[0] ?? null;
  }

  // ── Eval runs ─────────────────────────────────────────────────

  async saveEvalRun(userId: string, run: EvalRun): Promise<EvalRunEntry> {
    const data: NewEvalRunEntry = {
      userId,
      name: run.name,
      model: run.model,
      evaluators: run.evaluators,
      results: run.results,
      summary: run.summary,
    };

    const result = await this.db.insert(evalRuns).values(data).returning();

    dbLogger.info(
      { runId: result[0].id, userId, model: run.model },
      'Eval run saved'
    );
    return result[0];
  }

  async saveEvalRunWithDataset(
    userId: string,
    run: EvalRun,
    datasetName: string
  ): Promise<EvalRunEntry> {
    const data: NewEvalRunEntry = {
      userId,
      name: run.name,
      model: run.model,
      datasetName,
      evaluators: run.evaluators,
      results: run.results,
      summary: run.summary,
    };

    const result = await this.db.insert(evalRuns).values(data).returning();

    dbLogger.info(
      { runId: result[0].id, userId, model: run.model, datasetName },
      'Eval run saved'
    );
    return result[0];
  }

  async getEvalRuns(userId: string, limit: number = 20): Promise<EvalRunEntry[]> {
    return this.db
      .select()
      .from(evalRuns)
      .where(eq(evalRuns.userId, userId))
      .orderBy(desc(evalRuns.createdAt))
      .limit(limit);
  }

  async getEvalRun(id: string): Promise<EvalRunEntry | null> {
    const result = await this.db
      .select()
      .from(evalRuns)
      .where(eq(evalRuns.id, id))
      .limit(1);
    return result[0] ?? null;
  }

  /**
   * Aggregate summary scores across all eval runs for a user.
   * Returns a map of model -> evaluator -> aggregated stats, useful for
   * cross-model comparison.
   */
  async getEvalSummary(
    userId: string
  ): Promise<Record<string, Record<string, { mean: number; passRate: number; count: number }>>> {
    const runs = await this.db
      .select()
      .from(evalRuns)
      .where(eq(evalRuns.userId, userId))
      .orderBy(desc(evalRuns.createdAt));

    // Aggregate: model -> evaluator -> accumulated values
    const accumulator: Record<
      string,
      Record<string, { scoreSum: number; passCount: number; count: number }>
    > = {};

    for (const run of runs) {
      const model = run.model;
      if (!accumulator[model]) accumulator[model] = {};

      const summary = run.summary as Record<
        string,
        { mean: number; passRate: number; count: number }
      >;

      for (const [evaluator, stats] of Object.entries(summary)) {
        if (!accumulator[model][evaluator]) {
          accumulator[model][evaluator] = { scoreSum: 0, passCount: 0, count: 0 };
        }
        const acc = accumulator[model][evaluator];
        acc.scoreSum += stats.mean * stats.count;
        acc.passCount += Math.round(stats.passRate * stats.count);
        acc.count += stats.count;
      }
    }

    // Compute final aggregated stats
    const result: Record<
      string,
      Record<string, { mean: number; passRate: number; count: number }>
    > = {};

    for (const [model, evaluators] of Object.entries(accumulator)) {
      result[model] = {};
      for (const [evaluator, acc] of Object.entries(evaluators)) {
        result[model][evaluator] = {
          mean: acc.count > 0 ? Math.round((acc.scoreSum / acc.count) * 1000) / 1000 : 0,
          passRate:
            acc.count > 0 ? Math.round((acc.passCount / acc.count) * 1000) / 1000 : 0,
          count: acc.count,
        };
      }
    }

    return result;
  }
}

export const evaluationRepository = new EvaluationRepository();
