import { eq, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import type { PipelineStepConfig } from '@/db/schema/pipeline-templates';
import { pipelineTemplates } from '@/db/schema/pipeline-templates';
import { getRoleConfig } from './roles';
import type { AgentRole, PipelineStageType } from './types';

export interface StageTemplate {
  name: string;
  role: AgentRole;
  requiresApproval: boolean;
  promptTemplate: string;
  stageType?: PipelineStageType;
  maxRetries?: number;
  retryTargetStage?: number;
}

export interface PipelineTemplate {
  type: string;
  stages: StageTemplate[];
}

/**
 * Convert a DB PipelineStepConfig to a StageTemplate.
 */
function stepConfigToStageTemplate(step: PipelineStepConfig): StageTemplate {
  return {
    name: step.name,
    role: step.topic as AgentRole,
    requiresApproval: step.requiresApproval,
    promptTemplate: step.promptTemplate || `Execute: ${step.name}\n\n{{description}}\n\n{{previousOutput}}`,
    stageType: step.stageType,
    maxRetries: step.maxRetries,
    retryTargetStage: step.retryTargetStage,
  };
}

/**
 * Get a pipeline template by name or ID from the database.
 * Falls back to a single-stage general template if not found.
 */
export async function getPipelineTemplate(nameOrId: string): Promise<PipelineTemplate> {
  const db = getDb();
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nameOrId);

  // 1. Exact match by name or UUID
  const exactConditions = isUUID
    ? or(eq(pipelineTemplates.name, nameOrId), eq(pipelineTemplates.id, nameOrId))
    : eq(pipelineTemplates.name, nameOrId);

  const results = await db
    .select()
    .from(pipelineTemplates)
    .where(exactConditions)
    .limit(1);

  if (results.length > 0) {
    const template = results[0];
    const steps = template.steps as PipelineStepConfig[];
    return {
      type: template.name,
      stages: steps.map(stepConfigToStageTemplate),
    };
  }

  // 2. Fuzzy match: case-insensitive LIKE search (handles "Full Development Cycle" → "full-development-cycle")
  const fuzzyResults = await db
    .select()
    .from(pipelineTemplates)
    .where(sql`LOWER(${pipelineTemplates.name}) LIKE LOWER(${'%' + nameOrId.replace(/\s+/g, '%') + '%'})`)
    .limit(1);

  if (fuzzyResults.length > 0) {
    const template = fuzzyResults[0];
    const steps = template.steps as PipelineStepConfig[];
    return {
      type: template.name,
      stages: steps.map(stepConfigToStageTemplate),
    };
  }

  // Fallback: single-stage general pipeline
  return {
    type: 'general',
    stages: [
      {
        name: 'Execute',
        role: 'general',
        requiresApproval: false,
        promptTemplate: `Complete the following task:\n\n{{description}}`,
      },
    ],
  };
}

/**
 * List all available pipeline templates for a user (their own + presets).
 */
export async function listAvailableTemplates(userId?: string): Promise<Array<{ id: string; name: string; description: string | null; stageCount: number; isPreset: boolean }>> {
  const db = getDb();

  const conditions = userId
    ? or(eq(pipelineTemplates.userId, userId), eq(pipelineTemplates.isPreset, true), isNull(pipelineTemplates.userId))
    : or(eq(pipelineTemplates.isPreset, true), isNull(pipelineTemplates.userId));

  const templates = await db
    .select()
    .from(pipelineTemplates)
    .where(conditions);

  return templates.map(t => ({
    id: t.id,
    name: t.name,
    description: t.description,
    stageCount: (t.steps as PipelineStepConfig[]).length,
    isPreset: t.isPreset,
  }));
}

/**
 * Expand a stage's prompt template with context variables.
 */
export function expandPromptTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

/**
 * Build stage configs from a template for a specific pipeline description.
 */
export function buildStagesFromTemplate(
  template: PipelineTemplate,
  description: string,
) {
  return template.stages.map((stage, index) => {
    const roleConfig = getRoleConfig(stage.role);
    return {
      name: stage.name,
      role: stage.role,
      toolIds: roleConfig.toolIds,
      systemPrompt: roleConfig.systemPromptTemplate,
      requiresApproval: stage.requiresApproval,
      stageIndex: index,
      promptTemplate: stage.promptTemplate,
      stageType: stage.stageType || 'standard',
      maxRetries: stage.maxRetries ?? 3,
      retryTargetStage: stage.retryTargetStage,
    };
  });
}
