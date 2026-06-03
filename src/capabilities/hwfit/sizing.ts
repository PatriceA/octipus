/**
 * Live model sizing from the Ollama registry. The curated catalog (catalog.json)
 * deliberately carries no authoritative size — the real weights size is fetched
 * here from the OCI manifest at recommend-time, so sizing never goes stale.
 *
 * There is NO list-all API on registry.ollama.ai (/v2/_catalog and tags/list
 * both 404), which is why the *set* of models stays curated. But per-model
 * manifests are public, and the `vnd.ollama.image.model` layer's `size` is the
 * exact weights byte count — that's what we resolve.
 *
 * Falls back to the catalog's `vramHintMB` when the registry is unreachable, so
 * recommendations still work offline / airgapped.
 */
import { modelLogger } from '@/utils/logger';
import { MODEL_CATALOG } from './catalog';
import type { ModelCatalogEntry, SizedModel } from './types';

const DEFAULT_REGISTRY = 'https://registry.ollama.ai';
const OLLAMA_MODEL_LAYER = 'application/vnd.ollama.image.model';
const MANIFEST_TIMEOUT_MS = 5000;
/** Sizes change only when a tag is re-published; a day-long cache is plenty. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BYTES_PER_MB = 1024 * 1024;

interface OciLayer {
  mediaType: string;
  size: number;
}
interface OciManifest {
  layers?: OciLayer[];
}

interface CacheEntry {
  mb: number;
  at: number;
}
const sizeCache = new Map<string, CacheEntry>();

/** Split an Ollama id into registry name + tag. 'llama3.2:3b-q4' → {name,tag}. */
export function parseModelId(id: string): { name: string; tag: string } {
  const idx = id.indexOf(':');
  if (idx === -1) return { name: id, tag: 'latest' };
  return { name: id.slice(0, idx), tag: id.slice(idx + 1) };
}

/**
 * Extract the model-weights size (MB) from an OCI manifest. Pure + exported so
 * it can be tested against captured registry responses. Returns null if the
 * manifest has no recognizable model layer.
 */
export function parseManifestSizeMB(manifest: unknown): number | null {
  const layers = (manifest as OciManifest)?.layers;
  if (!Array.isArray(layers)) return null;
  const modelLayer = layers.find((l) => l?.mediaType === OLLAMA_MODEL_LAYER);
  if (!modelLayer || !Number.isFinite(modelLayer.size) || modelLayer.size <= 0) return null;
  return Math.round(modelLayer.size / BYTES_PER_MB);
}

/**
 * Resolve one model's live weights size (MB), cached. Returns null on any
 * failure (caller falls back to the hint) — never throws.
 */
async function fetchSizeMB(id: string, registry: string): Promise<number | null> {
  const cached = sizeCache.get(id);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.mb;

  const { name, tag } = parseModelId(id);
  const url = `${registry}/v2/library/${name}/manifests/${tag}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' },
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      modelLogger.debug({ id, status: res.status }, 'hwfit: manifest fetch non-OK, using hint');
      return null;
    }
    const mb = parseManifestSizeMB(await res.json());
    if (mb === null) return null;
    sizeCache.set(id, { mb, at: Date.now() });
    return mb;
  } catch (err) {
    modelLogger.debug({ id, err: (err as Error).message }, 'hwfit: manifest fetch failed, using hint');
    return null;
  }
}

/**
 * Hydrate catalog entries with a resolved VRAM size. Fetches live sizes in
 * parallel; any entry whose live lookup fails keeps its `vramHintMB`.
 */
export async function resolveSizes(
  catalog: readonly ModelCatalogEntry[] = MODEL_CATALOG,
  opts?: { registry?: string },
): Promise<SizedModel[]> {
  const registry = opts?.registry ?? DEFAULT_REGISTRY;
  return Promise.all(
    catalog.map(async (entry): Promise<SizedModel> => {
      const live = await fetchSizeMB(entry.id, registry);
      return live !== null
        ? { ...entry, vramMB: live, sizeSource: 'live' }
        : { ...entry, vramMB: entry.vramHintMB, sizeSource: 'hint' };
    }),
  );
}

/** Test/maintenance hook — clear the in-process size cache. */
export function clearSizeCache(): void {
  sizeCache.clear();
}
