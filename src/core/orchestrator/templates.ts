import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import type { PipelineStepConfig, RecipeParameter } from '@/db/schema/pipeline-templates';
import { pipelineTemplates } from '@/db/schema/pipeline-templates';
import { validateRecipeParameterDefs, validateRecipeParameterRefs } from './recipe-params';
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
  /** Per-stage model override (bound model name/id). Empty ⇒ topic binding. */
  model?: string;
  /** Declares the stage must leave files behind — see PipelineStepConfig. */
  producesArtifacts?: boolean;
}

export interface PipelineTemplate {
  type: string;
  stages: StageTemplate[];
  /** Recipe parameters this template accepts (empty for unparameterized templates). */
  parameters: RecipeParameter[];
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
    model: step.model,
    producesArtifacts: step.producesArtifacts,
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
      parameters: (template.parameters as RecipeParameter[]) ?? [],
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
      parameters: (template.parameters as RecipeParameter[]) ?? [],
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
    parameters: [],
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

/** Like listAvailableTemplates but includes each recipe's typed parameters. */
export async function listRecipes(userId?: string): Promise<
  Array<{ id: string; name: string; description: string | null; stageCount: number; isPreset: boolean; parameters: RecipeParameter[] }>
> {
  const db = getDb();
  const conditions = userId
    ? or(eq(pipelineTemplates.userId, userId), eq(pipelineTemplates.isPreset, true), isNull(pipelineTemplates.userId))
    : or(eq(pipelineTemplates.isPreset, true), isNull(pipelineTemplates.userId));
  const templates = await db.select().from(pipelineTemplates).where(conditions);
  return templates.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    stageCount: (t.steps as PipelineStepConfig[]).length,
    isPreset: t.isPreset,
    parameters: (t.parameters as RecipeParameter[]) ?? [],
  }));
}

/** Portable recipe shape for export/import (no ids, no ownership, no timestamps). */
export interface RecipeExport {
  octipusRecipe: 1;
  name: string;
  description: string | null;
  steps: PipelineStepConfig[];
  parameters: RecipeParameter[];
}

/** Serialize a recipe to a portable JSON string for sharing. */
export async function exportRecipe(nameOrId: string, userId?: string): Promise<string> {
  const db = getDb();
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nameOrId);
  const match = isUUID
    ? or(eq(pipelineTemplates.id, nameOrId), eq(pipelineTemplates.name, nameOrId))
    : eq(pipelineTemplates.name, nameOrId);
  // Ownership scope: a user can export their own recipes + presets/global ones,
  // never another user's private recipe (else any UUID leaks it).
  const where = userId
    ? and(match, or(eq(pipelineTemplates.userId, userId), eq(pipelineTemplates.isPreset, true), isNull(pipelineTemplates.userId)))
    : match;
  const [row] = await db.select().from(pipelineTemplates).where(where).limit(1);
  if (!row) throw new Error(`Recipe "${nameOrId}" not found`);
  const payload: RecipeExport = {
    octipusRecipe: 1,
    name: row.name,
    description: row.description,
    steps: (row.steps as PipelineStepConfig[]) ?? [],
    parameters: (row.parameters as RecipeParameter[]) ?? [],
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Parse + validate an exported recipe JSON string. Throws (fail loud) on a bad
 * envelope or invalid parameter defs. Returns the rows for insertion (caller
 * supplies userId).
 */
export function parseRecipeExport(json: string): RecipeExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('invalid recipe JSON');
  }
  const obj = parsed as Partial<RecipeExport>;
  if (!obj || obj.octipusRecipe !== 1 || typeof obj.name !== 'string' || !Array.isArray(obj.steps)) {
    throw new Error('not a valid octipus recipe export (expected { octipusRecipe: 1, name, steps })');
  }
  // Light shape-check each step — a malformed import shouldn't reach the runtime
  // with a non-string topic/name (deeper role validation falls back to general).
  for (const [i, step] of (obj.steps as unknown[]).entries()) {
    const s = step as Partial<PipelineStepConfig>;
    if (!s || typeof s.name !== 'string' || typeof s.topic !== 'string') {
      throw new Error(`recipe step ${i} is malformed (name and topic must be strings)`);
    }
  }
  // Validate parameter defs with the same schema used at create time.
  const parameters = validateRecipeParameterDefs(obj.parameters ?? []);
  // Reject an import whose stages reference an undeclared {{param.x}} — same
  // fail-loud rule as the create/update API paths.
  validateRecipeParameterRefs(obj.steps as PipelineStepConfig[], parameters);
  return {
    octipusRecipe: 1,
    name: obj.name,
    description: obj.description ?? null,
    steps: obj.steps as PipelineStepConfig[],
    parameters,
  };
}

/** Import a recipe (from parseRecipeExport output) for a user. Returns the new id. */
export async function importRecipe(userId: string, recipe: RecipeExport): Promise<{ id: string; name: string }> {
  const db = getDb();
  // Avoid clobbering an existing same-named recipe for THIS user — suffix on
  // collision. Scope to the user's own names so another user's identically
  // named recipe doesn't force a needless suffix.
  const existing = await db
    .select({ name: pipelineTemplates.name })
    .from(pipelineTemplates)
    .where(eq(pipelineTemplates.userId, userId));
  const taken = new Set(existing.map((r) => r.name));
  let name = recipe.name;
  for (let n = 2; taken.has(name); n++) name = `${recipe.name} (${n})`;

  const [row] = await db
    .insert(pipelineTemplates)
    .values({
      userId,
      name,
      description: recipe.description,
      isPreset: false,
      steps: recipe.steps,
      parameters: recipe.parameters,
    })
    .returning({ id: pipelineTemplates.id, name: pipelineTemplates.name });
  return row;
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
    // Escape regex metachars in the key so dotted keys like `param.foo` match
    // literally (the `.` would otherwise match any char). `$` in the value is
    // escaped so it isn't interpreted as a replacement special. Allow optional
    // whitespace inside the braces (`{{ param.foo }}`) so the runtime accepts
    // the same forms the recipe-param validator (PARAM_REF_RE) recognizes.
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`\\{\\{\\s*${escapedKey}\\s*\\}\\}`, 'g'), () => value);
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
      model: stage.model,
      producesArtifacts: stage.producesArtifacts,
    };
  });
}
