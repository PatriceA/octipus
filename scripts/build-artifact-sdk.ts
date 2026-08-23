/**
 * Build the live-artifacts browser SDK and write its sha256 to a sidecar
 * file. The hash is pinned in CSP `script-src` at embed render time
 * (read by `src/api/routes/artifact-pages.ts`).
 *
 * Run via `npx tsx scripts/build-artifact-sdk.ts`. Output:
 *   web/public/octipus-artifact-client.js
 *   web/public/octipus-artifact-client.sha256.txt
 */

import { createHash } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { build as esbuild } from 'esbuild';

async function main(): Promise<void> {
  const root = process.cwd();
  const srcPath = join(root, 'web/public/octipus-artifact-client.src.js');
  const outPath = join(root, 'web/public/octipus-artifact-client.js');
  const shaPath = join(root, 'web/public/octipus-artifact-client.sha256.txt');

  const built = await esbuild({
    entryPoints: [srcPath],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    minify: true,
    sourcemap: false,
    write: false,
  });
  const first = built.outputFiles?.[0];
  if (!first) throw new Error('SDK build failed: no output produced');
  const out = Buffer.from(first.contents);
  await writeFile(outPath, out);
  const sha = createHash('sha256').update(out).digest('hex');
  await writeFile(shaPath, sha + '\n');
  // eslint-disable-next-line no-console
  console.log(`SDK built: ${out.length} bytes, sha256=${sha}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
