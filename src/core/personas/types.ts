import { z } from 'zod';

/**
 * Persona = the root agent's identity. Loaded from YAML at startup,
 * then per-user overrides land in the `profiles` table with
 * `category='assistant'`.
 *
 * The base persona (the octopus-machine) lives at
 * `personas/octipus.yaml` and is the default when a user has no
 * override.
 */

export const PersonaTone = z.enum([
  'dry',
  'playful',
  'neutral',
  'professional',
  'terse',
  'verbose',
]);
export type PersonaTone = z.infer<typeof PersonaTone>;

export const PersonaNarration = z.enum(['off', 'minimal', 'chatty']);
export type PersonaNarration = z.infer<typeof PersonaNarration>;

export const PersonaHumorRate = z.enum(['none', 'low', 'medium', 'high']);
export type PersonaHumorRate = z.infer<typeof PersonaHumorRate>;

export const PersonaDemandRate = z.enum(['none', 'low', 'medium', 'high']);
export type PersonaDemandRate = z.infer<typeof PersonaDemandRate>;

export const NarrationTemplates = z.object({
  spawn_single: z.string().optional(),
  spawn_parallel: z.string().optional(),
  completion_ok: z.string().optional(),
  completion_error: z.string().optional(),
  approval_request: z.string().optional(),
  budget_warning: z.string().optional(),
});
export type NarrationTemplates = z.infer<typeof NarrationTemplates>;

export const PersonaDefaults = z.object({
  narration: PersonaNarration.default('minimal'),
  reply_target_lines: z.number().int().positive().default(3),
  humor_rate: PersonaHumorRate.default('low'),
  demand_more_input_rate: PersonaDemandRate.default('medium'),
});
export type PersonaDefaults = z.infer<typeof PersonaDefaults>;

export const PersonaExchange = z.object({
  user: z.string(),
  // Renderer-agnostic — preset YAMLs use the persona id as the key
  // (`octipus:`, `mentor:`). Accept both `octipus` and a generic
  // `assistant` field so renames don't break calibration files.
  octipus: z.string().optional(),
  assistant: z.string().optional(),
});
export type PersonaExchange = z.infer<typeof PersonaExchange>;

export const Persona = z.object({
  id: z.string().min(1),
  is_default: z.boolean().default(false),
  display_name: z.string(),
  name: z.string(),
  pronouns: z.string().default('it/we'),
  tone: PersonaTone.default('neutral'),
  persona_prompt: z.string().min(20),
  signature_phrases: z.array(z.string()).default([]),
  narration_templates: NarrationTemplates.default({}),
  example_exchanges: z.array(PersonaExchange).default([]),
  defaults: PersonaDefaults.default({
    narration: 'minimal',
    reply_target_lines: 3,
    humor_rate: 'low',
    demand_more_input_rate: 'medium',
  }),
});
export type Persona = z.infer<typeof Persona>;

/**
 * The resolved persona for a user — the YAML preset merged with the
 * per-user profile overrides from the `profiles` table.
 */
export interface ResolvedPersona {
  // Stable identifiers
  id: string;               // preset id, e.g. "octipus"
  profileId?: string;       // db row id if a user override exists

  // Renderable identity
  name: string;             // "Octipus" or whatever the user renamed to
  pronouns: string;         // "it/we"
  tone: PersonaTone;

  // Rendered prompt block (already has {{name}} interpolated)
  promptBlock: string;

  // Knobs for the runtime
  narration: PersonaNarration;
  narrationTemplates: NarrationTemplates;
  signaturePhrases: string[];

  // Free-form user facts (extra rules the user added via /persona say)
  userFacts: string[];

  // Source preset for /persona personas display
  presetId: string;
}
