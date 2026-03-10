import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { pipelines, pipelineStages } from '@/db/schema/pipelines';
import { pipelineTemplates } from '@/db/schema/pipeline-templates';
import type { Pipeline, NewPipeline, PipelineStageRow, NewPipelineStage } from '@/db/schema/pipelines';
import type { PipelineStepConfig } from '@/db/schema/pipeline-templates';
import type { AgentContext } from '@/core/types';
import { getModelRegistry } from '@/models/model-registry';
import { generateId } from '@/utils/crypto';
import { coreLogger } from '@/utils/logger';
import { getNotificationService } from '@/core/notification-service';
import { getOrchestratorService } from './service';
import { getPipelineTemplate, expandPromptTemplate, buildStagesFromTemplate } from './templates';
import type { PipelineStatus, StageStatus } from './types';

export class PipelineManager {
  private get db() { return getDb(); }

  /**
   * Create a pipeline from a template type and start it.
   */
  async createAndRun(
    orchestratorAgentId: string,
    sessionId: string,
    userId: string,
    title: string,
    type: string,
    description: string,
    context: AgentContext,
  ): Promise<{ pipelineId: string; result: string }> {
    const template = getPipelineTemplate(type);
    const stageConfigs = buildStagesFromTemplate(template, description);

    // Create pipeline record
    const [pipeline] = await this.db.insert(pipelines).values({
      orchestratorAgentId,
      sessionId,
      userId,
      title,
      type,
      description,
      status: 'running',
      currentStageIndex: 0,
    }).returning();

    // Create stage records
    for (const stageConfig of stageConfigs) {
      await this.db.insert(pipelineStages).values({
        pipelineId: pipeline.id,
        name: stageConfig.name,
        role: stageConfig.role,
        toolIds: stageConfig.toolIds,
        systemPrompt: stageConfig.systemPrompt,
        input: '',
        requiresApproval: stageConfig.requiresApproval,
        stageIndex: stageConfig.stageIndex,
      });
    }

    const orchestrator = getOrchestratorService();
    orchestrator['emit']({
      type: 'pipeline_event',
      sessionId,
      data: { event: 'pipeline_created', pipelineId: pipeline.id, title, type, stageCount: stageConfigs.length },
      timestamp: new Date(),
    });

    coreLogger.info({ pipelineId: pipeline.id, type, stages: stageConfigs.length }, 'Pipeline created');

    // Run stages sequentially
    let previousOutput = '';
    const stages = await this.getStages(pipeline.id);

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const stageTemplate = template.stages[i];

      // Build input from template
      const input = expandPromptTemplate(stageTemplate.promptTemplate, {
        description,
        previousOutput,
      });

      // Update stage input
      await this.updateStage(stage.id, { input, status: 'running' });
      await this.updatePipeline(pipeline.id, { currentStageIndex: i, status: 'running' });

      orchestrator['emit']({
        type: 'pipeline_event',
        sessionId,
        data: { event: 'stage_started', pipelineId: pipeline.id, stageId: stage.id, name: stage.name, index: i },
        timestamp: new Date(),
      });

      // Check if this stage requires approval
      if (stage.requiresApproval && previousOutput) {
        await this.updateStage(stage.id, { status: 'awaiting_approval' });
        await this.updatePipeline(pipeline.id, { status: 'awaiting_approval' });

        orchestrator['emit']({
          type: 'pipeline_event',
          sessionId,
          data: { event: 'approval_required', pipelineId: pipeline.id, stageId: stage.id, name: stage.name },
          timestamp: new Date(),
        });

        // Request approval from user
        const prevStageName = i > 0 ? stages[i - 1].name : 'Initial';
        const approvalResult = await orchestrator.requestApproval(
          `Pipeline "${title}" — Stage "${prevStageName}" completed.\n\nResult:\n${(previousOutput || '').slice(0, 2000)}`,
          `Proceed with next stage: "${stage.name}"?`,
          context,
          ['Approve', 'Skip', 'Stop Pipeline'],
        ) as { approved: boolean; response?: string };

        if (!approvalResult.approved || approvalResult.response === 'Stop Pipeline') {
          await this.updateStage(stage.id, { status: 'skipped' });
          await this.updatePipeline(pipeline.id, { status: 'paused', summary: `Stopped by user at stage: ${stage.name}` });
          return { pipelineId: pipeline.id, result: `Pipeline stopped at "${stage.name}".` };
        }

        if (approvalResult.response === 'Skip') {
          await this.updateStage(stage.id, { status: 'skipped' });
          continue;
        }

        await this.updateStage(stage.id, { status: 'approved', approvedAt: new Date() });
        await this.updatePipeline(pipeline.id, { status: 'running' });
      }

      // Spawn worker for this stage
      try {
        const result = await orchestrator.spawnWorker(
          stage.role,
          input,
          previousOutput,
          context,
        );

        previousOutput = String(result || '');

        await this.updateStage(stage.id, {
          status: 'completed',
          output: previousOutput,
          completedAt: new Date(),
        });

        orchestrator['emit']({
          type: 'pipeline_event',
          sessionId,
          data: { event: 'stage_completed', pipelineId: pipeline.id, stageId: stage.id, name: stage.name },
          timestamp: new Date(),
        });
      } catch (error) {
        const errorMsg = (error as Error).message;
        await this.updateStage(stage.id, { status: 'failed', error: errorMsg });
        await this.updatePipeline(pipeline.id, { status: 'failed', summary: `Failed at stage: ${stage.name} — ${errorMsg}` });

        coreLogger.error({ error, pipelineId: pipeline.id, stage: stage.name }, 'Pipeline stage failed');
        getNotificationService().notify(
          pipeline.userId,
          'pipeline_error',
          `Pipeline "${title}" failed`,
          `Failed at stage "${stage.name}": ${errorMsg}`,
          { pipelineId: pipeline.id, stage: stage.name },
        ).catch(() => {});
        return { pipelineId: pipeline.id, result: `Pipeline failed at "${stage.name}": ${errorMsg}` };
      }
    }

    // All stages complete
    const summary = `Pipeline "${title}" completed successfully. Final output:\n\n${previousOutput}`;
    await this.updatePipeline(pipeline.id, {
      status: 'completed',
      summary,
      completedAt: new Date(),
    });

    orchestrator['emit']({
      type: 'pipeline_event',
      sessionId,
      data: { event: 'pipeline_completed', pipelineId: pipeline.id, title },
      timestamp: new Date(),
    });

    getNotificationService().notify(
      pipeline.userId,
      'pipeline_complete',
      `Pipeline "${title}" completed`,
      (previousOutput || '').slice(0, 200),
      { pipelineId: pipeline.id },
    ).catch(() => {});

    return { pipelineId: pipeline.id, result: summary };
  }

  /**
   * Create and run a pipeline from a DB template.
   */
  async createFromTemplate(
    templateId: string,
    orchestratorAgentId: string,
    sessionId: string,
    userId: string,
    description: string,
    context: AgentContext,
  ): Promise<{ pipelineId: string; result: string }> {
    const [template] = await this.db
      .select()
      .from(pipelineTemplates)
      .where(eq(pipelineTemplates.id, templateId))
      .limit(1);

    if (!template) {
      return { pipelineId: '', result: `Template "${templateId}" not found.` };
    }

    const steps = template.steps as PipelineStepConfig[];
    const registry = getModelRegistry();

    // Create pipeline record
    const [pipeline] = await this.db.insert(pipelines).values({
      orchestratorAgentId,
      sessionId,
      userId,
      title: template.name,
      type: 'template',
      description,
      status: 'running',
      currentStageIndex: 0,
    }).returning();

    // Create stages from template steps
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const model = await registry.getModelForTopic(step.topic);
      await this.db.insert(pipelineStages).values({
        pipelineId: pipeline.id,
        name: step.name,
        role: step.topic,
        model: model?.modelId || undefined,
        toolIds: step.toolIds || [],
        systemPrompt: step.promptTemplate || `Execute: ${step.name}`,
        input: '',
        requiresApproval: step.requiresApproval,
        stageIndex: i,
      });
    }

    coreLogger.info({ pipelineId: pipeline.id, template: template.name, stages: steps.length }, 'Pipeline created from template');

    // Run using the same stage execution logic as createAndRun
    return this.runStages(pipeline, context, description, sessionId);
  }

  /**
   * List pipeline templates for a user.
   */
  async listTemplates(userId: string) {
    return this.db
      .select()
      .from(pipelineTemplates)
      .where(eq(pipelineTemplates.userId, userId))
      .orderBy(desc(pipelineTemplates.createdAt));
  }

  /**
   * Run pipeline stages sequentially (shared logic).
   */
  private async runStages(
    pipeline: Pipeline,
    context: AgentContext,
    description: string,
    sessionId: string,
  ): Promise<{ pipelineId: string; result: string }> {
    const orchestrator = getOrchestratorService();
    const stages = await this.getStages(pipeline.id);
    let previousOutput = '';

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const input = stage.systemPrompt ? `${stage.systemPrompt}\n\nContext: ${description}\n\n${previousOutput}` : description;

      await this.updateStage(stage.id, { input, status: 'running' });
      await this.updatePipeline(pipeline.id, { currentStageIndex: i, status: 'running' });

      if (stage.requiresApproval && previousOutput) {
        await this.updateStage(stage.id, { status: 'awaiting_approval' });
        await this.updatePipeline(pipeline.id, { status: 'awaiting_approval' });

        const approvalResult = await orchestrator.requestApproval(
          `Pipeline "${pipeline.title}" — Stage "${stage.name}" ready.\n\nPrevious result:\n${(previousOutput || '').slice(0, 2000)}`,
          `Proceed with "${stage.name}"?`,
          context,
          ['Approve', 'Skip', 'Stop Pipeline'],
        ) as { approved: boolean; response?: string };

        if (!approvalResult.approved || approvalResult.response === 'Stop Pipeline') {
          await this.updateStage(stage.id, { status: 'skipped' });
          await this.updatePipeline(pipeline.id, { status: 'paused', summary: `Stopped at: ${stage.name}` });
          return { pipelineId: pipeline.id, result: `Pipeline stopped at "${stage.name}".` };
        }
        if (approvalResult.response === 'Skip') {
          await this.updateStage(stage.id, { status: 'skipped' });
          continue;
        }
        await this.updateStage(stage.id, { status: 'approved', approvedAt: new Date() });
        await this.updatePipeline(pipeline.id, { status: 'running' });
      }

      try {
        const result = await orchestrator.spawnWorker(
          stage.role,
          input,
          previousOutput,
          context,
        );

        previousOutput = String(result || '');
        await this.updateStage(stage.id, {
          status: 'completed',
          output: previousOutput,
          completedAt: new Date(),
        });
      } catch (error) {
        const errorMsg = (error as Error).message;
        await this.updateStage(stage.id, { status: 'failed', error: errorMsg });
        await this.updatePipeline(pipeline.id, { status: 'failed', summary: `Failed at: ${stage.name} — ${errorMsg}` });
        return { pipelineId: pipeline.id, result: `Pipeline failed at "${stage.name}": ${errorMsg}` };
      }
    }

    const summary = `Pipeline "${pipeline.title}" completed.\n\n${previousOutput}`;
    await this.updatePipeline(pipeline.id, { status: 'completed', summary, completedAt: new Date() });

    getNotificationService().notify(
      pipeline.userId,
      'pipeline_complete',
      `Pipeline "${pipeline.title}" completed`,
      (previousOutput || '').slice(0, 200),
      { pipelineId: pipeline.id },
    ).catch(() => {});

    return { pipelineId: pipeline.id, result: summary };
  }

  /**
   * Get pipeline by ID with stages.
   */
  async getPipeline(id: string): Promise<Pipeline | null> {
    const result = await this.db.select().from(pipelines).where(eq(pipelines.id, id)).limit(1);
    return result[0] ?? null;
  }

  /**
   * Get stages for a pipeline, ordered by index.
   */
  async getStages(pipelineId: string): Promise<PipelineStageRow[]> {
    return this.db
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, pipelineId))
      .orderBy(pipelineStages.stageIndex);
  }

  /**
   * List pipelines for a user.
   */
  async listByUser(userId: string): Promise<Pipeline[]> {
    return this.db
      .select()
      .from(pipelines)
      .where(eq(pipelines.userId, userId))
      .orderBy(desc(pipelines.createdAt));
  }

  /**
   * List all pipelines (admin).
   */
  async listAll(): Promise<Pipeline[]> {
    return this.db
      .select()
      .from(pipelines)
      .orderBy(desc(pipelines.createdAt));
  }

  /**
   * Stop a running pipeline.
   */
  async stop(pipelineId: string): Promise<boolean> {
    const pipeline = await this.getPipeline(pipelineId);
    if (!pipeline || pipeline.status === 'completed' || pipeline.status === 'failed') {
      return false;
    }

    await this.updatePipeline(pipelineId, {
      status: 'paused',
      summary: 'Pipeline stopped by user.',
    });

    // Mark running stages as skipped
    const stages = await this.getStages(pipelineId);
    for (const stage of stages) {
      if (stage.status === 'running' || stage.status === 'awaiting_approval') {
        await this.updateStage(stage.id, { status: 'skipped' });
      }
    }

    return true;
  }

  private async updatePipeline(id: string, data: Partial<NewPipeline>) {
    await this.db
      .update(pipelines)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(pipelines.id, id));
  }

  private async updateStage(id: string, data: Partial<NewPipelineStage>) {
    await this.db
      .update(pipelineStages)
      .set(data)
      .where(eq(pipelineStages.id, id));
  }
}

// Singleton
let instance: PipelineManager | null = null;

export function getPipelineManager(): PipelineManager {
  if (!instance) {
    instance = new PipelineManager();
  }
  return instance;
}
