/**
 * Where the local embedding engine lives: beside whisper under the install
 * root (Docker: the data volume mounted there).
 *
 *   models/engines/llama.cpp/<tag>/<platform-arch>/   the extracted release
 *   models/embeddings/<model-id>/<file>.gguf           the verified model
 */
import { join, resolve } from 'node:path';
import { octipusRoot } from '@/utils/install-root';
import { LOCAL_ENGINE_MANIFEST, type LocalEmbeddingModel, type PlatformKey } from './manifest';

export function modelsRoot(): string {
  return process.env.OCTIPUS_MODELS_DIR ? resolve(process.env.OCTIPUS_MODELS_DIR) : resolve(octipusRoot(), 'models');
}

export function engineDir(key: PlatformKey, tag = LOCAL_ENGINE_MANIFEST.engine.tag): string {
  return join(modelsRoot(), 'engines', 'llama.cpp', tag, key);
}

export function modelDir(model: LocalEmbeddingModel): string {
  return join(modelsRoot(), 'embeddings', model.id);
}

export function modelFilePath(model: LocalEmbeddingModel): string {
  return join(modelDir(model), model.file);
}
