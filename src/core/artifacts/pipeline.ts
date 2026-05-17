/**
 * Pipeline runner — builds an artifact's data bus by reading latest source
 * snapshots and applying transforms in `position` order. Pure functions
 * over the snapshot store; no I/O of its own.
 *
 * The data bus is `{ [sourceOrTransformName]: value }`. Templates bind via
 * `{{data.<name>.…}}`; widgets via `bind: { input: "<name>.path" }`.
 *
 * Errors in one transform do not poison the whole bus — the failing entry
 * is set to `null` and an error message is collected in the returned
 * `errors` map. Loud failure (CLAUDE.md house rule #1) is preserved via
 * the structured log line per failed transform.
 */

import { artifactsRepository } from '@/db/repositories/artifacts-repository';
import { coreLogger } from '@/utils/logger';
import { ensureToolboxLoaded, getToolboxRegistry } from './toolbox';

export interface DataBus {
  data: Record<string, unknown>;
  errors: Record<string, string>;
}

export interface BuildOptions {
  /**
   * Override source snapshots — used by tests and the dry-run preview to
   * avoid touching the DB. When set, source rows are still fetched (for
   * names) but their snapshots come from this map keyed by source name.
   */
  sourceOverrides?: Record<string, unknown>;
}

export async function buildDataBus(
  artifactId: string,
  options: BuildOptions = {},
): Promise<DataBus> {
  await ensureToolboxLoaded();

  const data: Record<string, unknown> = {};
  const previousBySource: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  // 1. Sources — pull latest + second-newest snapshot (or override) per source.
  //    The previous snapshot powers diff-style transforms.
  const sources = await artifactsRepository.listSources(artifactId);
  for (const source of sources) {
    if (options.sourceOverrides && source.name in options.sourceOverrides) {
      data[source.name] = options.sourceOverrides[source.name];
      continue;
    }
    const recent = await artifactsRepository.getRecentSnapshots(source.id, 2);
    data[source.name] = recent[0]?.payloadJson ?? null;
    if (recent[1]) previousBySource[source.name] = recent[1].payloadJson;
  }

  // 2. Transforms — run in position order; later transforms see earlier outputs.
  const transforms = await artifactsRepository.listTransforms(artifactId);
  const artifact = transforms.length > 0
    ? await artifactsRepository.getById(artifactId)
    : null;
  const workspaceId = artifact?.workspaceId ?? '';

  for (const t of transforms) {
    if (t.name in data) {
      errors[t.name] = `transform name "${t.name}" collides with an upstream source`;
      data[t.name] = null;
      continue;
    }
    const tool = getToolboxRegistry().get(t.toolId);
    if (!tool) {
      errors[t.name] = `unknown transform tool "${t.toolId}"`;
      data[t.name] = null;
      continue;
    }
    if (tool.family !== 'transform') {
      errors[t.name] = `tool "${t.toolId}" is a ${tool.family}, expected transform`;
      data[t.name] = null;
      continue;
    }
    if (!(t.inputName in data)) {
      errors[t.name] = `input "${t.inputName}" not found in data bus`;
      data[t.name] = null;
      continue;
    }

    try {
      data[t.name] = await tool.execute(t.paramsJson ?? {}, {
        principalId: '',
        workspaceId,
        artifactId,
        nodeName: t.name,
        input: data[t.inputName],
        previousInput: previousBySource[t.inputName],
      });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      errors[t.name] = message;
      data[t.name] = null;
      coreLogger.error(
        { artifactId, transform: t.name, toolId: t.toolId, error: message },
        'artifact.pipeline.transform_failed',
      );
    }
  }

  return { data, errors };
}
