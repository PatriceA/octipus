/**
 * Model rows a trusted extension registered at runtime (`octi.registerProvider`,
 * src/extensions/providers.ts). They never touch the database: they live here
 * for as long as the extension is loaded and are removed on its dispose.
 *
 * Each row is an ordinary install row on one of the existing custom-provider
 * kinds (`custom-openai`, `custom-anthropic`, `custom-gemini`), so the router
 * and the custom providers serve it the way they serve a custom provider an
 * admin configured. What sets it apart:
 *
 * - it is reachable ONLY by its exact name, `ext/<extension>/<id>/<model>`.
 *   Its `modelId` is that same name: a bare vendor id (`gpt-4o`,
 *   `llama-3.3-70b`) never matches it, so it can neither capture a request
 *   meant for a built-in provider or a personal row, nor be picked by a
 *   lookup by model id. The id sent upstream is kept beside it
 *   (`getExtensionRoute`) and swapped in by the custom provider;
 * - the `ext/` namespace is reserved: no database row may take it as a name
 *   or a model id (`ModelRegistry`);
 * - it is never a default, a topic binding, a fallback, nor in
 *   `getAllModels()` (the list automatic selection picks from);
 * - it has its own rate-limit bucket and circuit breaker, keyed by its
 *   logical provider id `ext:<extension>:<id>` (`providerKey`), so a flaky
 *   extension endpoint never opens the breaker of an admin's custom models;
 * - its endpoint is reached through the SSRF-guarded fetch personal rows use,
 *   and its key comes from the extension's own vault namespace with no env
 *   fallback (`base-custom-provider.ts`).
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

/** How an extension row is served: the id sent upstream and its rate-limit / breaker key. */
export interface ExtensionRoute {
  upstreamModelId: string;
  /** `ext:<extension>:<id>`. */
  providerKey: string;
}

export interface ExtensionModelEntry extends ExtensionRoute {
  row: ModelConfigEntry;
}

const entries = new Map<string, { row: ModelConfigEntry; route: ExtensionRoute }>();

/** Add rows, all or none. Throws when a name is already registered. */
export function addExtensionModels(add: readonly ExtensionModelEntry[]): void {
  const names = new Set<string>();
  for (const { row } of add) {
    if (!isExtensionModelName(row.name)) throw new Error(`extension model '${row.name}' must be named under '${EXTENSION_MODEL_PREFIX}'`);
    if (row.modelId !== row.name) throw new Error(`extension model '${row.name}' must use its name as its model id`);
    if (entries.has(row.name) || names.has(row.name)) throw new Error(`extension model '${row.name}' is already registered`);
    names.add(row.name);
  }
  for (const { row, upstreamModelId, providerKey } of add) {
    entries.set(row.name, { row: Object.freeze({ ...row }) as ModelConfigEntry, route: Object.freeze({ upstreamModelId, providerKey }) });
  }
}

export function removeExtensionModels(names: readonly string[]): void {
  for (const name of names) entries.delete(name);
}

/** The row with exactly this name. */
export function getExtensionModel(name: string | null | undefined): ModelConfigEntry | null {
  return (name && entries.get(name)?.row) || null;
}

/** How the row with exactly this name is served. */
export function getExtensionRoute(name: string | null | undefined): ExtensionRoute | null {
  return (name && entries.get(name)?.route) || null;
}

export function listExtensionModels(): ModelConfigEntry[] {
  return [...entries.values()].map((e) => e.row).sort((a, b) => a.name.localeCompare(b.name));
}

/** Test seam. */
export function _clearExtensionModelsForTesting(): void {
  entries.clear();
}
