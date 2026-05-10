import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildAndStoreBundle, readBundleSha, validateUserBundle } from './bundler';

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
