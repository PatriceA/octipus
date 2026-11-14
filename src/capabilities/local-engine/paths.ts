/**
 * Where the local embedding engine lives: beside whisper under the install
 * root (Docker: the data volume mounted there).
 *
 *   models/engines/llama.cpp/<tag>/<platform-arch>[-vulkan]/   the extracted release
 *   models/engines/llama.cpp/active.json               the build in use (tag, variant)
 *   models/embeddings/<model-id>/<file>.gguf           the verified model
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { octipusRoot } from '@/utils/install-root';
import { type EngineVariant, LOCAL_ENGINE_MANIFEST, type LocalEmbeddingModel, type PlatformKey } from './manifest';

export function modelsRoot(): string {
  return process.env.OCTIPUS_MODELS_DIR ? resolve(process.env.OCTIPUS_MODELS_DIR) : resolve(octipusRoot(), 'models');
}

export function enginesRoot(): string {
  return join(modelsRoot(), 'engines', 'llama.cpp');
}

export function engineDir(key: PlatformKey, tag = LOCAL_ENGINE_MANIFEST.engine.tag, variant: EngineVariant = 'cpu'): string {
  return join(enginesRoot(), tag, variant === 'cpu' ? key : `${key}-${variant}`);
}

export interface ActiveEngine { tag: string; variant: EngineVariant }

/** The build last installed and probed (written only after its probe passed). */
export function activeEngine(): ActiveEngine | null {
  try {
    const raw = JSON.parse(readFileSync(join(enginesRoot(), 'active.json'), 'utf8')) as Partial<ActiveEngine>;
    if (typeof raw.tag !== 'string' || !/^b\d+$/.test(raw.tag)) return null;
    return { tag: raw.tag, variant: raw.variant === 'vulkan' ? 'vulkan' : 'cpu' };
  } catch {
    return null;
  }
}

export function modelDir(model: LocalEmbeddingModel): string {
  return join(modelsRoot(), 'embeddings', model.id);
}

export function modelFilePath(model: LocalEmbeddingModel): string {
  return join(modelDir(model), model.file);
}
