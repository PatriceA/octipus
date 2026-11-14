/**
 * The pinned manifest of the optional local embedding engine
 * (docs/RAG.md → Local embeddings): the llama.cpp release and its per-platform
 * asset, and the GGUF embedding models with their exact revision and SHA-256.
 */
import manifest from './manifest.json';

export type PlatformKey = 'linux-x64' | 'linux-arm64' | 'darwin-arm64' | 'darwin-x64' | 'win32-x64' | 'win32-arm64';

export interface EngineAsset { pattern: string; sha256: string | null }

export interface LocalEmbeddingModel {
  id: string;
  label: string;
  repo: string;
  revision: string;
  file: string;
  sha256: string;
  size: number;
  dims: number;
  pooling: 'mean' | 'cls' | 'last';
  contextLength: number;
  prefixes: { query: string; document: string };
  license: string;
}

/** `cpu`: the default build (Metal on Apple silicon). `vulkan`: opt-in GPU build where one exists. */
export type EngineVariant = 'cpu' | 'vulkan';

export interface LocalEngineManifest {
  engine: {
    name: string; repo: string; tag: string; binary: string;
    assets: Record<PlatformKey, EngineAsset>;
    /** Opt-in GPU builds (`octi capabilities install local-embedding --gpu vulkan`). */
    gpu?: { vulkan?: Partial<Record<PlatformKey, EngineAsset>> };
  };
  defaultModel: string;
  models: LocalEmbeddingModel[];
}

export const LOCAL_ENGINE_MANIFEST = manifest as unknown as LocalEngineManifest;

/** This machine's key in the manifest, or null where no build exists. */
export function platformKey(platform = process.platform, arch = process.arch): PlatformKey | null {
  const key = `${platform}-${arch}`;
  return key in LOCAL_ENGINE_MANIFEST.engine.assets ? (key as PlatformKey) : null;
}

export function localEmbeddingModel(id?: string): LocalEmbeddingModel | undefined {
  return LOCAL_ENGINE_MANIFEST.models.find((m) => m.id === (id ?? LOCAL_ENGINE_MANIFEST.defaultModel));
}

/** The release asset for a platform and variant, or undefined where none is built. */
export function engineAsset(key: PlatformKey, variant: EngineVariant = 'cpu', m: LocalEngineManifest = LOCAL_ENGINE_MANIFEST): EngineAsset | undefined {
  return variant === 'cpu' ? m.engine.assets[key] : m.engine.gpu?.[variant]?.[key];
}

/** The model's download URL at its pinned revision (never `main`). */
export function modelUrl(model: LocalEmbeddingModel): string {
  return `https://huggingface.co/${model.repo}/resolve/${model.revision}/${model.file}`;
}

/** Problems with the manifest (the conformance test asserts none). */
export function manifestProblems(m: LocalEngineManifest = LOCAL_ENGINE_MANIFEST): string[] {
  const problems: string[] = [];
  if (!/^b\d+$/.test(m.engine.tag)) problems.push(`engine tag ${m.engine.tag} is not a llama.cpp build tag`);
  const gpu = Object.entries(m.engine.gpu?.vulkan ?? {}).map(([key, a]) => [`vulkan ${key}`, a] as const);
  for (const [key, asset] of [...Object.entries(m.engine.assets), ...gpu]) {
    if (!asset) continue;
    try { new RegExp(asset.pattern); } catch { problems.push(`${key}: pattern is not a regular expression`); }
    if (asset.sha256 !== null && !/^[0-9a-f]{64}$/.test(asset.sha256)) problems.push(`${key}: sha256 is not a SHA-256`);
  }
  const ids = new Set<string>();
  for (const model of m.models) {
    if (ids.has(model.id)) problems.push(`duplicate model ${model.id}`);
    ids.add(model.id);
    if (!/^[0-9a-f]{40}$/.test(model.revision)) problems.push(`${model.id}: revision is not a commit`);
    if (!/^[0-9a-f]{64}$/.test(model.sha256)) problems.push(`${model.id}: sha256 is not a SHA-256`);
    if (!model.file.endsWith('.gguf')) problems.push(`${model.id}: not a GGUF file`);
    if (!(model.size > 0) || !(model.dims > 0)) problems.push(`${model.id}: size and dims must be positive`);
  }
  if (!ids.has(m.defaultModel)) problems.push(`default model ${m.defaultModel} is not listed`);
  return problems;
}
