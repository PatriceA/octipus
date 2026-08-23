#!/usr/bin/env tsx
/**
 * Production build: one bundled ESM file the real runtime executes.
 *
 * `start` runs the artifact this produces rather than the source under a
 * loader, because the published artifact is what ships — module resolution
 * failures, settle races and swallowed load errors all hide behind a
 * development loader, and this repository has paid for that once already.
 *
 * Native and browser-driver packages stay external: they load platform
 * binaries at runtime and cannot be inlined.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const EXTERNAL = [
  'playwright',
  'playwright-core',
  'chromium-bidi',
  'electron',
  '@electric-sql/pglite',
  '@electric-sql/pglite-pgvector',
  'esbuild',
  'tree-sitter-go',
  'tree-sitter-java',
  'tree-sitter-python',
  'tree-sitter-rust',
  'tree-sitter-typescript',
  'web-tree-sitter',
];

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies?: Record<string, string> };

const result = await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  // Dependencies resolve from node_modules at runtime, as they do today; only
  // our own source is bundled, which keeps the build fast and the stack traces
  // pointing at real files.
  external: [...Object.keys(pkg.dependencies ?? {}), ...EXTERNAL],
  // Role prompts are imported as text so they travel inside the bundle. The
  // registry used to read them off disk relative to `import.meta.url`, which
  // resolves inside `dist/` once bundled and found nothing.
  loader: { '.md': 'text' },
  // `import.meta` and top-level await both survive into the output.
  banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
  logLevel: 'info',
});

if (result.errors.length > 0) process.exit(1);
