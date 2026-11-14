import { describe, expect, test } from 'vitest';
import { LOCAL_ENGINE_MANIFEST, localEmbeddingModel, manifestProblems, modelUrl, platformKey } from './manifest';

describe('local engine manifest', () => {
  test('the shipped manifest is pinned and well formed', () => {
    expect(manifestProblems()).toEqual([]);
    expect(localEmbeddingModel()?.id).toBe(LOCAL_ENGINE_MANIFEST.defaultModel);
  });

  test('every platform with a build is listed, and others have none', () => {
    expect(platformKey('linux', 'x64')).toBe('linux-x64');
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64');
    expect(platformKey('win32', 'x64')).toBe('win32-x64');
    expect(platformKey('freebsd', 'x64')).toBeNull();
    expect(platformKey('linux', 'ia32')).toBeNull();
  });

  test('models download at their pinned revision, never a branch', () => {
    for (const m of LOCAL_ENGINE_MANIFEST.models) {
      const url = modelUrl(m);
      expect(url).toContain(`/resolve/${m.revision}/`);
      expect(url).not.toMatch(/\/resolve\/main\//);
    }
  });

  test('problems are reported', () => {
    const bad = structuredClone(LOCAL_ENGINE_MANIFEST);
    bad.engine.tag = 'latest';
    bad.models[0]!.revision = 'main';
    bad.models[0]!.sha256 = 'abc';
    bad.defaultModel = 'nope';
    expect(manifestProblems(bad)).toEqual(expect.arrayContaining([
      'engine tag latest is not a llama.cpp build tag',
      `${bad.models[0]!.id}: revision is not a commit`,
      `${bad.models[0]!.id}: sha256 is not a SHA-256`,
      'default model nope is not listed',
    ]));
  });
});
