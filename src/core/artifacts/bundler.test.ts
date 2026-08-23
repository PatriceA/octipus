import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildAndStoreBundle, pruneArtifactBundles, readBundleSha, validateUserBundle } from './bundler';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'artifact-bundles-'));
  process.env.ARTIFACT_BUNDLES_DIR = dir;
});
afterEach(() => {
  // keep dir between tests; cleanup at end of process
});

describe('validateUserBundle', () => {
  test('rejects disallowed imports', () => {
    expect(() => validateUserBundle("import x from 'fs'")).toThrow(/import not allowed/);
    expect(() => validateUserBundle("require('child_process')")).toThrow();
  });
  test('accepts plain code with no imports', () => {
    expect(() => validateUserBundle('const x = 1; console.log(x);')).not.toThrow();
  });
});

describe('buildAndStoreBundle', () => {
  test('builds, persists, and returns sha256', async () => {
    const r = await buildAndStoreBundle({
      artifactId: 'a1',
      versionId: 'v1',
      source: 'const greeting = "hi"; document.body.innerText = greeting;',
    });
    expect(r.sha256Hex).toMatch(/^[0-9a-f]{64}$/);
    expect(r.bytes).toBeGreaterThan(0);
    const reread = await readBundleSha('a1', 'v1');
    expect(reread).toBe(r.sha256Hex);
  });

  test('rejects malicious source', async () => {
    await expect(
      buildAndStoreBundle({ artifactId: 'a2', versionId: 'v1', source: "import fs from 'fs';" }),
    ).rejects.toThrow();
  });
});

afterEach(() => {});
process.on('exit', () => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('pruneArtifactBundles', () => {
  test('keeps exactly the named versions, drops the rest', async () => {
    for (const v of ['v1', 'v2', 'v3', 'v4']) {
      await buildAndStoreBundle({ artifactId: 'prune-me', versionId: v, source: `const v = "${v}";` });
    }
    // The live version is the OLDEST here — recency on disk is not the rule.
    const removed = await pruneArtifactBundles('prune-me', ['v4', 'v1']);
    expect(removed).toBe(2);
    expect(await readBundleSha('prune-me', 'v4')).not.toBeNull();
    expect(await readBundleSha('prune-me', 'v1')).not.toBeNull();
    expect(await readBundleSha('prune-me', 'v2')).toBeNull();
    expect(await readBundleSha('prune-me', 'v3')).toBeNull();
  });

  test('no-op when every version is kept', async () => {
    await buildAndStoreBundle({ artifactId: 'under-cap', versionId: 'a', source: 'const a=1;' });
    await buildAndStoreBundle({ artifactId: 'under-cap', versionId: 'b', source: 'const b=1;' });
    expect(await pruneArtifactBundles('under-cap', ['a', 'b'])).toBe(0);
    expect(await readBundleSha('under-cap', 'a')).not.toBeNull();
  });

  test('no-op on an artifact that never had a bundle', async () => {
    expect(await pruneArtifactBundles('never-built', [])).toBe(0);
  });
});
