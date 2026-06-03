import { describe, expect, test } from 'bun:test';
import { parseManifestSizeMB, parseModelId } from './sizing';

// Captured live from registry.ollama.ai/v2/library/llama3.2/manifests/3b-instruct-q4_K_M.
// The vnd.ollama.image.model layer carries the real weights size in bytes.
const REAL_MANIFEST = {
  schemaVersion: 2,
  mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
  config: { mediaType: 'application/vnd.docker.container.image.v1+json', digest: 'sha256:34bb', size: 561 },
  layers: [
    { mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:dde5', size: 2019377376 },
    { mediaType: 'application/vnd.ollama.image.template', digest: 'sha256:966d', size: 1429 },
    { mediaType: 'application/vnd.ollama.image.license', digest: 'sha256:fcc5', size: 7711 },
    { mediaType: 'application/vnd.ollama.image.params', digest: 'sha256:56bb', size: 96 },
  ],
};

describe('parseManifestSizeMB', () => {
  test('extracts the model-layer size in MB from a real manifest', () => {
    // 2019377376 bytes / 1024^2 ≈ 1926 MB.
    expect(parseManifestSizeMB(REAL_MANIFEST)).toBe(Math.round(2019377376 / (1024 * 1024)));
  });

  test('returns null when no model layer is present', () => {
    expect(parseManifestSizeMB({ layers: [{ mediaType: 'application/vnd.ollama.image.license', size: 100 }] })).toBeNull();
  });

  test('returns null for malformed input', () => {
    expect(parseManifestSizeMB(null)).toBeNull();
    expect(parseManifestSizeMB({})).toBeNull();
    expect(parseManifestSizeMB({ layers: 'nope' })).toBeNull();
  });

  test('ignores a model layer with non-positive size', () => {
    expect(parseManifestSizeMB({ layers: [{ mediaType: 'application/vnd.ollama.image.model', size: 0 }] })).toBeNull();
  });
});

describe('parseModelId', () => {
  test('splits name and tag on the first colon', () => {
    expect(parseModelId('llama3.2:3b-instruct-q4_K_M')).toEqual({ name: 'llama3.2', tag: '3b-instruct-q4_K_M' });
  });

  test('defaults to latest when no tag', () => {
    expect(parseModelId('nomic-embed-text')).toEqual({ name: 'nomic-embed-text', tag: 'latest' });
  });
});
