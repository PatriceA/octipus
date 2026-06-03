/**
 * Loads and types the curated model catalog (catalog.json). The JSON is the
 * reviewable source of truth; this module gives it a typed surface. A
 * conformance test (catalog.test.ts) asserts every entry is well-formed.
 */
import catalogData from './catalog.json';
import type { ModelCatalogEntry } from './types';

interface CatalogFile {
  version: number;
  note?: string;
  models: ModelCatalogEntry[];
}

const data = catalogData as CatalogFile;

export const CATALOG_VERSION: number = data.version;

/** The curated catalog, frozen so callers cannot mutate the shared array. */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = Object.freeze(data.models);

/** Look up a catalog entry by its Ollama id. Returns undefined if not present. */
export function getCatalogEntry(id: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}
