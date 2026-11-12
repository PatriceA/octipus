/**
 * The manifest's `model` field (docs/PLUGIN-PACKAGES.md#model-calls-on-cli-lanes):
 * what a package says about the prompts of its `model:complete` calls. Kept
 * apart from ./manifest.ts, which spreads `MODEL_FIELDS` into its schema and
 * calls `refineModel`.
 *
 * `trustedInput: true` claims the prompts carry no outside data, with a
 * `reason` the admin reads. It grants nothing by itself: an admin approves it
 * as `model:cli-tools`. Refused where the claim cannot hold or cannot matter:
 * without `model:complete` (no model calls), with `web:read` (a fetched page
 * is outside data by definition), and on runtime `in-process` (no sandbox,
 * no host API token).
 */
import { z } from 'zod';
import { MAX_MODEL_TRUST_REASON_CHARS, PLUGIN_MODEL_CLI_TOOLS_APPROVAL } from '@/shared/plugin-package';

export const modelSchema = z.object({
  trustedInput: z.boolean().optional(),
  reason: z.string().trim().min(1, 'model.reason: say why the prompts carry no outside data')
    .max(MAX_MODEL_TRUST_REASON_CHARS, `model.reason: at most ${MAX_MODEL_TRUST_REASON_CHARS} characters`).optional(),
}).strict();

/** Spread into the manifest's object schema. */
export const MODEL_FIELDS = {
  model: modelSchema.optional(),
};

/** The checks across fields, as messages (each one refuses the install). */
export function modelProblems(m: { model?: z.infer<typeof modelSchema>; host?: readonly string[]; runtime?: string }): string[] {
  if (m.model?.trustedInput !== true) return [];
  const problems: string[] = [];
  const host = m.host ?? [];
  if (!m.model.reason) {
    problems.push(`model.reason: required with model.trustedInput (at most ${MAX_MODEL_TRUST_REASON_CHARS} characters, shown to the admin): why the prompts carry no outside data`);
  }
  if (!host.includes('model:complete')) {
    problems.push('model.trustedInput: needs the host scope model:complete (it is about the prompts of model:complete calls)');
  }
  if (host.includes('web:read')) {
    problems.push(`model.trustedInput: not with the host scope web:read; a fetched page is outside data, so its model calls stay off CLI lanes (${PLUGIN_MODEL_CLI_TOOLS_APPROVAL} cannot be approved)`);
  }
  if (m.runtime === 'in-process') {
    problems.push('model.trustedInput: applies to the package runtime only; an in-process plugin has no host API calls');
  }
  return problems;
}
