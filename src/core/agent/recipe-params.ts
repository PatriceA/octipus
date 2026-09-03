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
 * Validate that every `{{param.<key>}}` reference in a recipe's stages resolves
 * to a DECLARED parameter. An undeclared reference would otherwise be left as a
 * literal `{{param.typo}}` in the worker input (silent footgun) — so we fail
 * loud at create/validate time with a specific message.
 *
 * EVERY templated field is walked, not just the prompt. `verifyCommand` is
 * expanded the same way and then EXECUTED, so an undeclared reference there is
 * the worse of the two: the shell gets a literal `{{param.x}}`, and the
 * non-zero exit is handed to the auditor as ground truth it is told not to
 * re-check. A guard that only reads prompts is one the field that matters most
 * never reaches.
 *
 * `defs` is the already-validated parameter list (see validateRecipeParameterDefs).
 * Throws on the first undeclared reference; no-op when there are no references.
 */
export function validateRecipeParameterRefs(
  steps: Array<Pick<PipelineStepConfig, 'name' | 'promptTemplate' | 'verifyCommand'>>,
  defs: RecipeParameter[],
): void {
  const declared = new Set(defs.map((d) => d.key));
  for (const step of steps) {
    for (const template of [step.promptTemplate, step.verifyCommand]) {
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
 * Levenshtein distance. Small enough to write, and the only question asked of
 * it is "is this a misspelling of that", so no library earns its place here.
 */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** A misspelling of a declared key, rather than a key from somewhere else. */
function isNearMiss(provided: string, declared: string): boolean {
  const a = provided.toLowerCase();
  const b = declared.toLowerCase();
  return a === b || editDistance(a, b) <= 2;
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

  // An unknown provided key is one of two things, and only one is worth failing
  // a run over: a TYPO for a declared parameter, or noise a model invented. The
  // key itself tells them apart — `rebo` for `repo` is a near miss,
  // `skipApproval` on a recipe that takes `verifyCommand` is not.
  //
  // Rejecting every unknown key killed whole runs: a model told "do not pause
  // for approval" invented `{skipApproval: true}`, `create_pipeline` threw, the
  // seven-stage run never started, and the user saw "I was unable to generate a
  // response" with nothing in the log. That was survivable only while the
  // recipes such a key gets aimed at declared none — and `Full Development
  // Cycle`, the recipe the orchestrator is told to prefer, now declares one. So
  // the lenient case has to key on the KEY, not on whether the recipe happens
  // to be parameterless.
  //
  // Dropping noise cannot fabricate a result: parameters are inputs, and an
  // ignored one leaves the recipe running exactly as it does with none supplied
  // — while a real typo still fails loud, here for an optional parameter and at
  // `missing required recipe parameter` for a required one.
  for (const key of Object.keys(provided)) {
    if (defByKey.has(key)) continue;
    const nearMiss = [...defByKey.keys()].find((declared) => isNearMiss(key, declared));
    if (nearMiss) {
      throw new Error(
        `unknown recipe parameter: ${key}. Did you mean "${nearMiss}"? ` +
          `This recipe accepts: ${[...defByKey.keys()].join(', ')}`,
      );
    }
    logger.warn(
      { ignored: key, accepts: [...defByKey.keys()] },
      'Recipe does not declare this parameter and nothing close to it — ignoring it instead of failing the run',
    );
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
