/**
 * Model rows a trusted extension registered at runtime (`octi.registerProvider`,
 * src/extensions/providers.ts). They never touch the database: they live here
 * for as long as the extension is loaded and are removed on its dispose.
 *
 * Each row is an ordinary install row on one of the existing custom-provider
 * kinds (`custom-openai`, `custom-anthropic`, `custom-gemini`), so the router,
 * the custom providers, the rate limiter and the circuit breakers serve it the
 * way they serve a custom provider an admin configured. What sets it apart:
 *
 * - it is named in the reserved `ext/` namespace (`ext/<extension>/<id>/<model>`),
 *   which no database row may take (`ModelRegistry.registerModel` refuses it);
 * - it is reached only by explicit choice (by name or model id): never a
 *   default, a topic binding, a fallback, nor in `getAllModels()` (the list
 *   automatic selection picks from);
 * - its endpoint is reached through the SSRF-guarded fetch personal rows use
 *   (https, public addresses only, no redirects), and its key comes from the
 *   system vault by name with no env fallback (`base-custom-provider.ts`).
 */
import type { ModelConfigEntry } from '@/db/schema/models';

/** The namespace extension rows are named in. No database row may use it. */
export const EXTENSION_MODEL_PREFIX = 'ext/';

/** Whether `name` is in the extension namespace (whether or not such a row is loaded). */
export function isExtensionModelName(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.startsWith(EXTENSION_MODEL_PREFIX);
}

/** Whether `row` is an extension row (by its reserved name). */
export function isExtensionModel(row: Pick<ModelConfigEntry, 'name'> | null | undefined): boolean {
  return isExtensionModelName(row?.name);
}

const rows = new Map<string, ModelConfigEntry>();

/**
 * Add rows, all or none. Throws when a name or a model id is already served
 * by another extension row: a model id must resolve to one row.
 */
export function addExtensionModels(entries: readonly ModelConfigEntry[]): void {
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!isExtensionModelName(entry.name)) throw new Error(`extension model '${entry.name}' must be named under '${EXTENSION_MODEL_PREFIX}'`);
    if (rows.has(entry.name) || names.has(entry.name)) throw new Error(`extension model '${entry.name}' is already registered`);
    const owner = findExtensionModelByModelId(entry.modelId);
    if (owner || ids.has(entry.modelId)) throw new Error(`model id '${entry.modelId}' is already served by extension model '${owner?.name ?? entry.name}'`);
    names.add(entry.name);
    ids.add(entry.modelId);
  }
  for (const entry of entries) rows.set(entry.name, Object.freeze({ ...entry }) as ModelConfigEntry);
}

export function removeExtensionModels(names: readonly string[]): void {
  for (const name of names) rows.delete(name);
}

export function getExtensionModel(name: string): ModelConfigEntry | null {
  return rows.get(name) ?? null;
}

export function findExtensionModelByModelId(modelId: string): ModelConfigEntry | null {
  for (const row of rows.values()) if (row.modelId === modelId) return row;
  return null;
}

export function listExtensionModels(): ModelConfigEntry[] {
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Test seam. */
export function _clearExtensionModelsForTesting(): void {
  rows.clear();
}
