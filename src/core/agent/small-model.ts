import type { ModelMetadata } from '@/db/schema/models';
import { coreLogger } from '@/utils/logger';
import { deriveParamCount } from './mode-selector';

/**
 * Worker-side small-model adaptation. The orchestrator already shrinks itself
 * for small models via `mode-selector` (router/lite/full). This is the missing
 * mirror image for *workers*: when the model bound to a worker's topic is small
 * (the ≤~10B router tier), the worker prompt and tool list are trimmed so a
 * weak local model isn't handed a 14-tool surface and a multi-section expert
 * scaffold it can't reliably drive.
 *
 * The two levers, in order of leverage:
 *   1. Tool-count cap — fewer tools means more reliable tool-call JSON and a
 *      smaller prompt (a 14-tool role is ~1.6k tokens of schema alone).
 *   2. Prompt trim — drop the optional expert scaffolding (success metrics,
 *      deliverable template) and collapse the verbose MCP guidance.
 *
 * Both are gated on `isSmallModel`, which keys off the same param-count
 * threshold the orchestrator router mode uses, so a single bound model produces
 * a consistent tier everywhere.
 */

/** Minimal model shape the small-model gate needs. */
export interface SmallModelMeta {
  modelId: string;
  metadata?: ModelMetadata | null;
}

/**
 * Is this model in the small (router) tier? Mirrors the orchestrator's
 * `paramCountToMode` router threshold so the worker tier and orchestrator tier
 * agree for the same bound model.
 *
 * Returns `false` when the size can't be determined — we only *reduce*
 * capability when we're confident the model is small, so an unknown-size cloud
 * model keeps the full surface rather than being silently degraded.
 */
export function isSmallModel(model: SmallModelMeta, routerMaxParams: number): boolean {
  const params = deriveParamCount(model.modelId, model.metadata);
  if (params === undefined) return false;
  return params < routerMaxParams;
}

/**
 * Cap a worker's tool list for a small model. The list is *flat function
 * handlers* — one tool (e.g. `filesystem`) expands into many handlers
 * (`read_file`, `write_file`, …) that all share a `toolId`. We must cap by
 * tool *group* (toolId), keeping every handler of the first N groups, not by
 * handler count — otherwise we'd keep a partial `filesystem` and drop `shell`
 * and `git` wholesale, breaking the worker. Roles list their tools in rough
 * priority order, so the first N groups are the core ones. Returns the kept
 * handlers plus the names dropped (for logging). No-op when within the cap.
 */
export function capToolsForSmallModel<T extends { name: string; toolId?: string }>(
  tools: T[],
  maxTools: number,
): { tools: T[]; dropped: string[] } {
  if (maxTools <= 0) {
    return { tools, dropped: [] };
  }
  const keptGroups = new Set<string>();
  const kept: T[] = [];
  const dropped: string[] = [];
  for (const t of tools) {
    const group = t.toolId ?? t.name;
    if (keptGroups.has(group) || keptGroups.size < maxTools) {
      keptGroups.add(group);
      kept.push(t);
    } else {
      dropped.push(t.name);
    }
  }
  // Return the original reference when nothing was dropped (no needless copy).
  return dropped.length === 0 ? { tools, dropped } : { tools: kept, dropped };
}

/**
 * Convenience wrapper: cap and log in one call. Keeps `worker-spawner` tidy and
 * makes the "we dropped tools because the model is small" decision auditable.
 */
export function applyToolCap<T extends { name: string; toolId?: string }>(
  tools: T[],
  maxTools: number,
  ctx: { role: string; modelId: string },
): T[] {
  const { tools: kept, dropped } = capToolsForSmallModel(tools, maxTools);
  if (dropped.length > 0) {
    coreLogger.info(
      { role: ctx.role, modelId: ctx.modelId, kept: kept.length, dropped },
      'Small-model worker: capped tool list',
    );
  }
  return kept;
}
