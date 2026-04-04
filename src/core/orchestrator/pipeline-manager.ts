import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { pipelines, pipelineStages } from '@/db/schema/pipelines';
import { pipelineTemplates } from '@/db/schema/pipeline-templates';
import type { Pipeline, NewPipeline, PipelineStageRow, NewPipelineStage } from '@/db/schema/pipelines';
import type { PipelineStepConfig } from '@/db/schema/pipeline-templates';
import type { AgentContext } from '@/core/types';
import type { QAValidationResult } from './types';
import { getModelRegistry } from '@/models/model-registry';
import { generateId } from '@/utils/crypto';
import { coreLogger } from '@/utils/logger';
import { getNotificationService } from '@/core/notification-service';
import { getOrchestratorService } from './service';
import { getPipelineTemplate, expandPromptTemplate, buildStagesFromTemplate } from './templates';
import { createHandoffContext, formatHandoffChain, type HandoffContext } from './handoff';
import { messageRepository } from '@/db/repositories/message-repository';
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
    options?: { maxRetries?: number },
  ): Promise<{ pipelineId: string; result: string }> {
    const template = await getPipelineTemplate(type);
    // Override maxRetries if provided
    if (options?.maxRetries != null) {
      for (const stage of template.stages) {
        if (stage.stageType === 'qa_validation') {
          stage.maxRetries = options.maxRetries;
        }
      }
    }
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

    // Run stages sequentially with structured handoff context
    let previousOutput = '';
    const handoffChain: HandoffContext[] = [];
    const stages = await this.getStages(pipeline.id);
    const stageConfBuilt = buildStagesFromTemplate(template, description);
    const retryCounts: Record<number, number> = {}; // Track retries per stage index

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const stageTemplate = template.stages[i];
      const builtStage = stageConfBuilt[i];

      // Build input from template, using structured handoff chain when available
      const handoffText = handoffChain.length > 0 ? formatHandoffChain(handoffChain) : '';
      const input = expandPromptTemplate(stageTemplate.promptTemplate, {
        description,
        previousOutput: handoffText || previousOutput,
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

      // Persist stage start as system message so it survives page reloads
      messageRepository.create({
        sessionId,
        role: 'system',
        content: `**Stage ${i + 1}: ${stage.name}** (${stage.role || 'agent'}) started`,
        metadata: { pipelineId: pipeline.id, stageId: stage.id, pipelineEvent: 'stage_started' },
      }).catch(() => {});

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

        // Request approval from user — show handoff summary if available
        const prevStageName = i > 0 ? stages[i - 1].name : 'Initial';
        const latestHandoff = handoffChain[handoffChain.length - 1];
        const approvalSummary = latestHandoff
          ? `Stage "${prevStageName}" completed.\n\n**Work done:** ${latestHandoff.completedWork.slice(0, 1500)}`
            + (latestHandoff.decisions.length > 0 ? `\n\n**Decisions:** ${latestHandoff.decisions.join('; ')}` : '')
          : `Stage "${prevStageName}" completed.\n\nResult:\n${(previousOutput || '').slice(0, 2000)}`;
        const approvalResult = await orchestrator.requestApproval(
          `Pipeline "${title}" — ${approvalSummary}`,
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

      // Emit stage_started so UI can show which pipeline stage is active
      orchestrator['emit']({
        type: 'pipeline_event',
        sessionId,
        data: { event: 'stage_started', pipelineId: pipeline.id, stageId: stage.id, name: stage.name, role: stage.role, index: i },
        timestamp: new Date(),
      });

      // Spawn worker for this stage with structured handoff context
      try {
        const result = await orchestrator.spawnWorker(
          stage.role,
          input,
          handoffText || previousOutput,
          { ...context, stageName: stage.name } as any,
        );

        previousOutput = String(result || '');

        await this.updateStage(stage.id, {
          status: 'completed',
          output: previousOutput,
          completedAt: new Date(),
        });

        // Build structured handoff for the next stage
        if (i < stages.length - 1) {
          const nextStage = stages[i + 1];
          const handoff = await createHandoffContext({
            from: { role: stage.role, stageName: stage.name, stageIndex: i },
            to: { role: nextStage.role, stageName: nextStage.name, stageIndex: i + 1 },
            originalRequest: description,
            stageOutput: previousOutput,
          });
          handoffChain.push(handoff);
        }

        // Generate a brief summary of what this stage accomplished
        const stageSummary = previousOutput.length > 300
          ? previousOutput.slice(0, 300).replace(/\n/g, ' ').trim() + '...'
          : previousOutput.replace(/\n/g, ' ').trim();

        orchestrator['emit']({
          type: 'pipeline_event',
          sessionId,
          data: {
            event: 'stage_completed',
            pipelineId: pipeline.id,
            stageId: stage.id,
            name: stage.name,
            role: stage.role,
            summary: stageSummary.slice(0, 200),
          },
          timestamp: new Date(),
        });

        // Persist stage completion as system message
        messageRepository.create({
          sessionId,
          role: 'system',
          content: `**${stage.name}** (${stage.role || 'agent'}) completed: ${stageSummary.slice(0, 200)}`,
          metadata: { pipelineId: pipeline.id, stageId: stage.id, pipelineEvent: 'stage_completed' },
        }).catch(() => {});

        // --- QA Validation retry loop ---
        if (builtStage.stageType === 'qa_validation') {
          const maxRetries = builtStage.maxRetries ?? 3;
          const retryTargetIndex = builtStage.retryTargetStage ?? (i > 0 ? i - 1 : 0);
          const retryTargetStage = stages[retryTargetIndex];
          const retryTargetTemplate = template.stages[retryTargetIndex];

          if (!retryTargetStage || !retryTargetTemplate) {
            coreLogger.warn({ pipelineId: pipeline.id, stageIndex: i, retryTargetIndex }, 'QA retry target stage not found, skipping retry logic');
          } else {
            // Store the original input for the retry target stage
            const originalTargetInput = expandPromptTemplate(retryTargetTemplate.promptTemplate, {
              description,
              previousOutput: retryTargetIndex > 0 ? (stages[retryTargetIndex - 1] as any).output || '' : '',
            });

            let qaResult = this.parseQAResult(previousOutput);
            retryCounts[i] = retryCounts[i] || 0;

            while (qaResult && !qaResult.passed && retryCounts[i] < maxRetries) {
              retryCounts[i]++;
              const attempt = retryCounts[i];

              coreLogger.info(
                { pipelineId: pipeline.id, qaStage: stage.name, retryTarget: retryTargetStage.name, attempt, maxRetries },
                'QA validation failed, retrying implementation stage',
              );

              orchestrator['emit']({
                type: 'pipeline_event',
                sessionId,
                data: {
                  event: 'qa_retry',
                  pipelineId: pipeline.id,
                  qaStageId: stage.id,
                  retryTargetStageId: retryTargetStage.id,
                  attempt,
                  maxRetries,
                  issues: qaResult.issues,
                },
                timestamp: new Date(),
              });

              // Re-run the target stage with QA feedback
              const retryInput = `Previous attempt had issues:\n${qaResult.feedback}\n\nPlease fix these issues:\n${qaResult.issues.join('\n')}\n\nOriginal task:\n${originalTargetInput}`;

              await this.updateStage(retryTargetStage.id, { input: retryInput, status: 'running' });

              try {
                const retryResult = await orchestrator.spawnWorker(
                  retryTargetStage.role,
                  retryInput,
                  '',
                  context,
                );

                const retryOutput = String(retryResult || '');
                await this.updateStage(retryTargetStage.id, {
                  status: 'completed',
                  output: retryOutput,
                  completedAt: new Date(),
                });

                orchestrator['emit']({
                  type: 'pipeline_event',
                  sessionId,
                  data: { event: 'stage_completed', pipelineId: pipeline.id, stageId: retryTargetStage.id, name: retryTargetStage.name, note: `retry attempt ${attempt}` },
                  timestamp: new Date(),
                });

                // Re-run QA stage with the new output
                const qaRetryInput = expandPromptTemplate(stageTemplate.promptTemplate, {
                  description,
                  previousOutput: retryOutput,
                });

                await this.updateStage(stage.id, { input: qaRetryInput, status: 'running' });

                const qaRetryResult = await orchestrator.spawnWorker(
                  stage.role,
                  qaRetryInput,
                  retryOutput,
                  context,
                );

                previousOutput = String(qaRetryResult || '');
                await this.updateStage(stage.id, {
                  status: 'completed',
                  output: previousOutput,
                  completedAt: new Date(),
                });

                qaResult = this.parseQAResult(previousOutput);
              } catch (retryError) {
                const errorMsg = (retryError as Error).message;
                coreLogger.error({ error: retryError, pipelineId: pipeline.id, attempt }, 'QA retry stage failed');
                await this.updateStage(retryTargetStage.id, { status: 'failed', error: errorMsg });
                await this.updatePipeline(pipeline.id, { status: 'failed', summary: `Failed during QA retry attempt ${attempt}: ${errorMsg}` });
                return { pipelineId: pipeline.id, result: `Pipeline failed during QA retry attempt ${attempt}: ${errorMsg}` };
              }
            }

            // If still failing after max retries, escalate for human approval
            if (qaResult && !qaResult.passed && retryCounts[i] >= maxRetries) {
              coreLogger.warn({ pipelineId: pipeline.id, attempts: retryCounts[i] }, 'QA validation exhausted retries, requesting human approval');

              orchestrator['emit']({
                type: 'pipeline_event',
                sessionId,
                data: {
                  event: 'qa_escalation',
                  pipelineId: pipeline.id,
                  qaStageId: stage.id,
                  attempts: retryCounts[i],
                  issues: qaResult.issues,
                },
                timestamp: new Date(),
              });

              await this.updatePipeline(pipeline.id, { status: 'awaiting_approval' });

              const escalationResult = await orchestrator.requestApproval(
                `QA validation failed after ${retryCounts[i]} attempts.\n\nRemaining issues:\n${qaResult.issues.join('\n')}\n\nFeedback: ${qaResult.feedback}`,
                `Continue pipeline despite QA failures, or abort?`,
                context,
                ['Continue Anyway', 'Abort Pipeline'],
              ) as { approved: boolean; response?: string };

              if (!escalationResult.approved || escalationResult.response === 'Abort Pipeline') {
                await this.updatePipeline(pipeline.id, {
                  status: 'failed',
                  summary: `QA failed after ${retryCounts[i]} attempts. Aborted by user.\n\nIssues:\n${qaResult.issues.join('\n')}`,
                });
                return {
                  pipelineId: pipeline.id,
                  result: `Pipeline aborted: QA failed after ${retryCounts[i]} attempts.\n\nUnresolved issues:\n${qaResult.issues.join('\n')}`,
                };
              }

              await this.updatePipeline(pipeline.id, { status: 'running' });
              coreLogger.info({ pipelineId: pipeline.id }, 'User approved continuing despite QA failures');
            }
          }
        }
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

    // Auto-update project summary after pipeline completion
    try {
      const { autoUpdateProjectSummary } = await import('./project-summary');
      autoUpdateProjectSummary(context, title, previousOutput).catch(() => {});
    } catch {}

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
   * Run pipeline stages sequentially (shared logic for DB template pipelines).
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
    const handoffChain: HandoffContext[] = [];

    // Retrieve step configs from the DB template to check stageType
    const [templateRecord] = await this.db
      .select()
      .from(pipelineTemplates)
      .where(eq(pipelineTemplates.name, pipeline.title))
      .limit(1);
    const stepConfigs = (templateRecord?.steps as PipelineStepConfig[]) || [];
    const retryCounts: Record<number, number> = {};

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const stepConfig = stepConfigs[i];
      // Build input using structured handoff chain when available
      const handoffText = handoffChain.length > 0 ? formatHandoffChain(handoffChain) : '';
      const contextInput = handoffText || previousOutput;
      const input = stage.systemPrompt ? `${stage.systemPrompt}\n\nContext: ${description}\n\n${contextInput}` : description;

      await this.updateStage(stage.id, { input, status: 'running' });
      await this.updatePipeline(pipeline.id, { currentStageIndex: i, status: 'running' });

      // Emit stage_started event for UI
      orchestrator['emit']({
        type: 'pipeline_event',
        sessionId,
        data: { event: 'stage_started', pipelineId: pipeline.id, stageId: stage.id, name: stage.name, role: stage.role, index: i },
        timestamp: new Date(),
      });

      // Persist stage start as system message
      messageRepository.create({
        sessionId,
        role: 'system',
        content: `**Stage ${i + 1}: ${stage.name}** (${stage.role || 'agent'}) started`,
        metadata: { pipelineId: pipeline.id, stageId: stage.id, pipelineEvent: 'stage_started' },
      }).catch(() => {});

      if (stage.requiresApproval && previousOutput) {
        await this.updateStage(stage.id, { status: 'awaiting_approval' });
        await this.updatePipeline(pipeline.id, { status: 'awaiting_approval' });

        // Show handoff summary in approval message if available
        const latestHandoff = handoffChain[handoffChain.length - 1];
        const approvalSummary = latestHandoff
          ? `Stage "${stage.name}" ready.\n\n**Previous work:** ${latestHandoff.completedWork.slice(0, 1500)}`
            + (latestHandoff.decisions.length > 0 ? `\n\n**Decisions:** ${latestHandoff.decisions.join('; ')}` : '')
          : `Stage "${stage.name}" ready.\n\nPrevious result:\n${(previousOutput || '').slice(0, 2000)}`;

        const approvalResult = await orchestrator.requestApproval(
          `Pipeline "${pipeline.title}" — ${approvalSummary}`,
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
          handoffText || previousOutput,
          context,
        );

        previousOutput = String(result || '');
        await this.updateStage(stage.id, {
          status: 'completed',
          output: previousOutput,
          completedAt: new Date(),
        });

        // Build structured handoff for the next stage
        if (i < stages.length - 1) {
          const nextStage = stages[i + 1];
          const handoff = await createHandoffContext({
            from: { role: stage.role, stageName: stage.name, stageIndex: i },
            to: { role: nextStage.role, stageName: nextStage.name, stageIndex: i + 1 },
            originalRequest: description,
            stageOutput: previousOutput,
          });
          handoffChain.push(handoff);
        }

        // Emit stage_completed event for UI
        const stageSummary = previousOutput.length > 300
          ? previousOutput.slice(0, 300).replace(/\n/g, ' ').trim() + '...'
          : previousOutput.replace(/\n/g, ' ').trim();

        orchestrator['emit']({
          type: 'pipeline_event',
          sessionId,
          data: {
            event: 'stage_completed',
            pipelineId: pipeline.id,
            stageId: stage.id,
            name: stage.name,
            role: stage.role,
            summary: stageSummary.slice(0, 200),
          },
          timestamp: new Date(),
        });

        // Persist stage completion as system message
        messageRepository.create({
          sessionId,
          role: 'system',
          content: `**${stage.name}** (${stage.role || 'agent'}) completed: ${stageSummary.slice(0, 200)}`,
          metadata: { pipelineId: pipeline.id, stageId: stage.id, pipelineEvent: 'stage_completed' },
        }).catch(() => {});

        // --- QA Validation retry loop for DB template pipelines ---
        if (stepConfig?.stageType === 'qa_validation') {
          const maxRetries = stepConfig.maxRetries ?? 3;
          const retryTargetIndex = stepConfig.retryTargetStage ?? (i > 0 ? i - 1 : 0);
          const retryTargetStage = stages[retryTargetIndex];

          if (!retryTargetStage) {
            coreLogger.warn({ pipelineId: pipeline.id, stageIndex: i, retryTargetIndex }, 'QA retry target stage not found');
          } else {
            const originalTargetInput = retryTargetStage.systemPrompt
              ? `${retryTargetStage.systemPrompt}\n\nContext: ${description}\n\n${retryTargetIndex > 0 ? (stages[retryTargetIndex - 1] as any).output || '' : ''}`
              : description;

            let qaResult = this.parseQAResult(previousOutput);
            retryCounts[i] = retryCounts[i] || 0;

            while (qaResult && !qaResult.passed && retryCounts[i] < maxRetries) {
              retryCounts[i]++;
              const attempt = retryCounts[i];

              coreLogger.info(
                { pipelineId: pipeline.id, qaStage: stage.name, retryTarget: retryTargetStage.name, attempt, maxRetries },
                'QA validation failed, retrying implementation stage',
              );

              const retryInput = `Previous attempt had issues:\n${qaResult.feedback}\n\nPlease fix these issues:\n${qaResult.issues.join('\n')}\n\nOriginal task:\n${originalTargetInput}`;
              await this.updateStage(retryTargetStage.id, { input: retryInput, status: 'running' });

              const retryResult = await orchestrator.spawnWorker(
                retryTargetStage.role,
                retryInput,
                '',
                context,
              );

              const retryOutput = String(retryResult || '');
              await this.updateStage(retryTargetStage.id, {
                status: 'completed',
                output: retryOutput,
                completedAt: new Date(),
              });

              // Re-run QA stage
              const qaRetryInput = stage.systemPrompt
                ? `${stage.systemPrompt}\n\nContext: ${description}\n\n${retryOutput}`
                : `${description}\n\n${retryOutput}`;

              await this.updateStage(stage.id, { input: qaRetryInput, status: 'running' });

              const qaRetryResult = await orchestrator.spawnWorker(
                stage.role,
                qaRetryInput,
                retryOutput,
                context,
              );

              previousOutput = String(qaRetryResult || '');
              await this.updateStage(stage.id, {
                status: 'completed',
                output: previousOutput,
                completedAt: new Date(),
              });

              qaResult = this.parseQAResult(previousOutput);
            }

            // Escalate if max retries exhausted
            if (qaResult && !qaResult.passed && retryCounts[i] >= maxRetries) {
              coreLogger.warn({ pipelineId: pipeline.id, attempts: retryCounts[i] }, 'QA validation exhausted retries');

              await this.updatePipeline(pipeline.id, { status: 'awaiting_approval' });

              const escalationResult = await orchestrator.requestApproval(
                `QA validation failed after ${retryCounts[i]} attempts.\n\nRemaining issues:\n${qaResult.issues.join('\n')}\n\nFeedback: ${qaResult.feedback}`,
                `Continue pipeline despite QA failures, or abort?`,
                context,
                ['Continue Anyway', 'Abort Pipeline'],
              ) as { approved: boolean; response?: string };

              if (!escalationResult.approved || escalationResult.response === 'Abort Pipeline') {
                await this.updatePipeline(pipeline.id, {
                  status: 'failed',
                  summary: `QA failed after ${retryCounts[i]} attempts. Aborted by user.\n\nIssues:\n${qaResult.issues.join('\n')}`,
                });
                return {
                  pipelineId: pipeline.id,
                  result: `Pipeline aborted: QA failed after ${retryCounts[i]} attempts.`,
                };
              }

              await this.updatePipeline(pipeline.id, { status: 'running' });
            }
          }
        }
      } catch (error) {
        const errorMsg = (error as Error).message;
        await this.updateStage(stage.id, { status: 'failed', error: errorMsg });
        await this.updatePipeline(pipeline.id, { status: 'failed', summary: `Failed at: ${stage.name} — ${errorMsg}` });
        return { pipelineId: pipeline.id, result: `Pipeline failed at "${stage.name}": ${errorMsg}` };
      }
    }

    const summary = `Pipeline "${pipeline.title}" completed.\n\n${previousOutput}`;
    await this.updatePipeline(pipeline.id, { status: 'completed', summary, completedAt: new Date() });

    // Emit pipeline_completed event for UI
    orchestrator['emit']({
      type: 'pipeline_event',
      sessionId,
      data: { event: 'pipeline_completed', pipelineId: pipeline.id, title: pipeline.title },
      timestamp: new Date(),
    });

    // Auto-update project summary after pipeline completion
    try {
      const { autoUpdateProjectSummary } = await import('./project-summary');
      autoUpdateProjectSummary(context, pipeline.title, previousOutput).catch(() => {});
    } catch {}

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

  /**
   * Parse QA validation output into a structured result.
   * Attempts to extract JSON from the agent's response (with or without markdown fences).
   */
  private parseQAResult(output: string): QAValidationResult | null {
    try {
      // Try to extract JSON from markdown code fences first
      const fenceMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      const jsonStr = fenceMatch ? fenceMatch[1].trim() : output.trim();

      // Try parsing the extracted or raw string
      const parsed = JSON.parse(jsonStr);

      if (typeof parsed.passed === 'boolean') {
        return {
          passed: parsed.passed,
          issues: Array.isArray(parsed.issues) ? parsed.issues : [],
          feedback: typeof parsed.feedback === 'string' ? parsed.feedback : '',
          retryCount: typeof parsed.retryCount === 'number' ? parsed.retryCount : 0,
        };
      }

      return null;
    } catch {
      // If the output contains clear pass/fail indicators but isn't valid JSON,
      // try a best-effort parse
      const passedMatch = output.match(/"passed"\s*:\s*(true|false)/);
      if (passedMatch) {
        const passed = passedMatch[1] === 'true';
        const issuesMatch = output.match(/"issues"\s*:\s*\[([\s\S]*?)\]/);
        const feedbackMatch = output.match(/"feedback"\s*:\s*"([\s\S]*?)"/);

        return {
          passed,
          issues: issuesMatch
            ? issuesMatch[1].split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean)
            : [],
          feedback: feedbackMatch ? feedbackMatch[1] : '',
          retryCount: 0,
        };
      }

      coreLogger.debug({ outputSnippet: output.slice(0, 200) }, 'Could not parse QA validation output as JSON');
      return null;
    }
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
