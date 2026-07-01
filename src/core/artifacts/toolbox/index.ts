/**
 * Public entrypoint for the live-artifacts toolbox. Other code (refresh
 * pipeline, agent-facing discovery tools) imports from here, not directly
 * from internal files.
 */

import { coreLogger } from '@/utils/logger';
import { discoverToolbox } from './discovery';
import { getToolboxRegistry } from './registry';
import type { ToolboxContext } from './types';

export { getToolboxRegistry, _resetToolboxRegistryForTests } from './registry';
export { discoverToolbox } from './discovery';
export { validatePipeline } from './validator';
export type {
  PipelineSourceSpec,
  PipelineSpec,
  ValidationIssue,
  ValidationResult,
} from './validator';
export type {
  ToolboxContext,
  ToolboxDescription,
  ToolboxExample,
  ToolboxFamily,
  ToolboxIndexEntry,
  ToolboxParamSpec,
  ToolboxPermissionLevel,
  ToolboxTool,
} from './types';

/**
 * Lazy load. Safe to call repeatedly — `discoverToolbox` is idempotent.
 */
export async function ensureToolboxLoaded(): Promise<void> {
  await discoverToolbox();
}

/**
 * Dispatch a collector by id. Loud failure if the tool isn't registered
 * or the family is wrong (AGENT.md house rule #1 — no silent fallbacks).
 */
export async function dispatchCollector(
  toolId: string,
  params: Record<string, unknown>,
  ctx: ToolboxContext,
): Promise<unknown> {
  await ensureToolboxLoaded();
  const tool = getToolboxRegistry().get(toolId);
  if (!tool) {
    throw new Error(`toolbox: collector "${toolId}" is not registered`);
  }
  if (tool.family !== 'collect') {
    throw new Error(
      `toolbox: "${toolId}" is a ${tool.family} tool, not a collector`,
    );
  }
  coreLogger.debug(
    { toolId, principalId: ctx.principalId, artifactId: ctx.artifactId },
    'toolbox.dispatch.collector',
  );
  return tool.execute(params, ctx);
}
