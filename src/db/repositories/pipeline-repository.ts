import { eq } from 'drizzle-orm';
import { getDb } from '../postgres';
import {
  pipelines,
  pipelineStages,
  type Pipeline,
  type NewPipeline,
  type PipelineStageRow,
  type NewPipelineStage,
} from '../schema/pipelines';

/**
 * Repository for pipeline + pipeline-stage rows. Pipeline business logic
 * (stage execution, retry loops, approval gates) lives in
 * `src/core/orchestrator/pipeline-manager.ts`; that module now goes through
 * this repository instead of touching `getDb()` directly so the data layer
 * stays swappable and conforms to the rest of the codebase.
 */
export class PipelineRepository {
  private get db() { return getDb(); }

  async create(data: NewPipeline): Promise<Pipeline> {
    const [row] = await this.db.insert(pipelines).values(data).returning();
    return row;
  }

  async createStage(data: NewPipelineStage): Promise<PipelineStageRow> {
    const [row] = await this.db.insert(pipelineStages).values(data).returning();
    return row;
  }

  async createStages(rows: NewPipelineStage[]): Promise<PipelineStageRow[]> {
    if (rows.length === 0) return [];
    return this.db.insert(pipelineStages).values(rows).returning();
  }

  async findById(id: string): Promise<Pipeline | null> {
    const result = await this.db
      .select()
      .from(pipelines)
      .where(eq(pipelines.id, id))
      .limit(1);
    return result[0] ?? null;
  }
}

export const pipelineRepository = new PipelineRepository();
