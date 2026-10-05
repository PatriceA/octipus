import type { ModelConfigEntry } from '@/db/schema/models';
import { getModelRegistry } from '@/models/model-registry';
import { CLI_TOOLS, type CLIToolConfig } from '@/models/providers/cli-provider';
import { canResume } from '@/shared/cli-capabilities';

/**
 * Check if a provider string indicates a CLI model
 */
export function isCLIProvider(provider: string): boolean {
  return provider === 'cli';
}

/**
 * Resolve a model id to its registry row the same way everywhere: `getModel`
 * (keyed by the unique `name`) first, `getModelByModelId` (keyed by the
 * non-unique `modelId`) as the fallback. `name` and `modelId` collapse onto
 * the same row for the default bootstrap data today, but nothing enforces
 * that — a model config edited mid-session can make them diverge. Any two
 * call sites that need "the same model" (e.g. a CLI resume fingerprint
 * computed once in cli-agent-worker.ts and once in root-runner.ts) must
 * share this lookup rather than each re-deriving it, or they can silently
 * resolve to different rows.
 */
export async function resolveCliModelEntry(
  modelId: string,
  /**
   * The row the agent runs on (`AgentContext.modelName`) and its requester.
   * With a row name the lookup is exact; without one, a name lookup accepts
   * install rows only and the modelId lookup the requester's own personal rows
   * at most (coworking spec §8.1) — a modelId must never reach another user's
   * personal row by spelling its name.
   */
  row: { modelName?: string; userId?: string } = {},
): Promise<ModelConfigEntry | null> {
  const registry = getModelRegistry();
  if (row.modelName) return registry.getModel(row.modelName);
  const byName = await registry.getModel(modelId);
  if (byName && !byName.ownerUserId) return byName;
  return registry.getModelByModelId(modelId, { userId: row.userId });
}

/**
 * Get the CLIToolConfig for a given modelId (e.g. 'cli/claude-code', 'cli/gemini')
 */
export function getCLIToolConfig(modelId: string): CLIToolConfig | null {
  return (
    CLI_TOOLS.find((tool) =>
      tool.modelPatterns.some((p) => modelId === p || modelId.startsWith(p + '/'))
    ) || null
  );
}

/** A CLI model whose adapter can resume a vendor session — the only kind a resume key affects. */
export function isResumableCliModel(modelId: string): boolean {
  const tool = getCLIToolConfig(modelId);
  return !!tool && canResume(tool.adapter ?? tool.name);
}
