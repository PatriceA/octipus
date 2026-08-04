/**
 * Recipe parameters — typed, validated inputs for parameterized pipeline
 * templates ("recipes"). Pure validation + templating helpers so they're fully
 * unit-testable and reused by the meta-tools, API, and pipeline manager.
 */

import { z } from 'zod';
import type { PipelineStepConfig, RecipeParameter } from '@/db/schema/pipeline-templates';
import { coreLogger as logger } from '@/utils/logger';

/** Zod schema for a single recipe parameter definition (validate on create). */
export const recipeParameterSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'key must be a valid identifier (letters, digits, underscore)'),
    description: z.string().optional(),
    inputType: z.enum(['string', 'number', 'boolean', 'date', 'select']),
    requirement: z.enum(['required', 'optional', 'user_prompt']),
    default: z.string().optional(),
    options: z.array(z.string()).optional(),
  })
  .refine((p) => p.inputType !== 'select' || (p.options && p.options.length > 0), {
    message: 'a select parameter must define non-empty options',
  });

export const recipeParametersSchema = z.array(recipeParameterSchema);

/** Validate a recipe's parameter definitions. Throws with a specific message. */
export function validateRecipeParameterDefs(defs: unknown): RecipeParameter[] {
  const parsed = recipeParametersSchema.parse(defs);
  const keys = new Set<string>();
  for (const p of parsed) {
    if (keys.has(p.key)) throw new Error(`duplicate recipe parameter key: ${p.key}`);
    keys.add(p.key);
  }
  return parsed as RecipeParameter[];
}

/** Matches a `{{param.<key>}}` reference, capturing the key. */
const PARAM_REF_RE = /\{\{\s*param\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Validate that every `{{param.<key>}}` reference in a recipe's stage prompt
 * templates resolves to a DECLARED parameter. An undeclared reference would
 * otherwise be left as a literal `{{param.typo}}` in the worker input (silent
 * footgun) — so we fail loud at create/validate time with a specific message.
 *
 * `defs` is the already-validated parameter list (see validateRecipeParameterDefs).
 * Throws on the first undeclared reference; no-op when there are no references.
 */
export function validateRecipeParameterRefs(
  steps: Array<Pick<PipelineStepConfig, 'name' | 'promptTemplate'>>,
  defs: RecipeParameter[],
): void {
  const declared = new Set(defs.map((d) => d.key));
  for (const step of steps) {
    const template = step.promptTemplate;
    if (!template) continue;
    for (const match of template.matchAll(PARAM_REF_RE)) {
      const key = match[1];
      if (!declared.has(key)) {
        throw new Error(
          `stage "${step.name}" references undeclared recipe parameter "{{param.${key}}}"; ` +
            `declare it in the recipe's parameters or fix the typo`,
        );
      }
    }
  }
}

/** Coerce + validate one provided value against its definition. Returns the string form. */
function coerceValue(def: RecipeParameter, raw: unknown): string {
  const s = typeof raw === 'string' ? raw : String(raw);
  switch (def.inputType) {
    case 'number':
      if (!Number.isFinite(Number(s))) throw new Error(`parameter "${def.key}" must be a number, got "${s}"`);
      return s;
    case 'boolean':
      if (s !== 'true' && s !== 'false') throw new Error(`parameter "${def.key}" must be "true" or "false", got "${s}"`);
      return s;
    case 'date':
      if (Number.isNaN(Date.parse(s))) throw new Error(`parameter "${def.key}" must be a valid date, got "${s}"`);
      return s;
    case 'select':
      if (!def.options?.includes(s)) {
        throw new Error(`parameter "${def.key}" must be one of [${(def.options ?? []).join(', ')}], got "${s}"`);
      }
      return s;
    default:
      return s;
  }
}

/**
 * Resolve provided parameter values against the recipe's parameter definitions:
 * - required / user_prompt params must be present (fail loud if missing) —
 *   `user_prompt` is identical at resolve time; the *caller* is responsible for
 *   prompting the user and passing the answer in.
 * - optional params fall back to `default` (or are omitted if no default).
 * - unknown provided keys are rejected.
 * - each value is coerced/validated by inputType.
 *
 * Returns a `{ key: stringValue }` map ready for templating.
 */
export function resolveRecipeParams(
  defs: RecipeParameter[],
  provided: Record<string, unknown> = {},
): Record<string, string> {
  const defByKey = new Map(defs.map((d) => [d.key, d]));

  // A template that declares NO parameters cannot consume any, so params handed
  // to it are noise, not a typo — there is nothing to have mistyped. Dropping
  // them is strictly better than failing: rejecting killed whole runs. A model
  // told "do not pause for approval" invented `{skipApproval: true}` on a
  // parameterless template, `create_pipeline` threw, the seven-stage run never
  // started, and the user saw "I was unable to generate a response".
  //
  // Recipes WITH parameters keep the strict check, which is where it earns its
  // keep: there, an unknown key really is a typo for a real one.
  if (defs.length === 0) {
    if (Object.keys(provided).length > 0) {
      logger.warn(
        { ignored: Object.keys(provided) },
        'Template declares no parameters — ignoring the supplied params instead of failing the run',
      );
    }
    return {};
  }

  // Reject unknown keys — fail loud rather than silently ignore a typo.
  for (const key of Object.keys(provided)) {
    if (!defByKey.has(key)) {
      throw new Error(
        `unknown recipe parameter: ${key}. This recipe accepts: ${[...defByKey.keys()].join(', ')}`,
      );
    }
  }

  const resolved: Record<string, string> = {};
  for (const def of defs) {
    const has = Object.prototype.hasOwnProperty.call(provided, def.key) && provided[def.key] != null;
    if (has) {
      resolved[def.key] = coerceValue(def, provided[def.key]);
    } else if (def.default != null) {
      resolved[def.key] = coerceValue(def, def.default);
    } else if (def.requirement === 'required' || def.requirement === 'user_prompt') {
      throw new Error(`missing required recipe parameter: ${def.key}`);
    }
    // optional with no default + not provided ⇒ omitted
  }
  return resolved;
}

/** Build the `{{param.<key>}}` template-var map from resolved param values. */
export function paramTemplateVars(resolved: Record<string, string>): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(resolved)) vars[`param.${k}`] = v;
  return vars;
}
