#!/usr/bin/env tsx
/**
 * Bundle `bin/octi.ts` into a single self-contained script at `dist/octi`.
 *
 * Not a static binary: the previous runtime could compile one, Node cannot
 * without shipping a whole runtime alongside it. A bundled script with a
 * `node` shebang is the equivalent that costs nothing — the installer links it
 * onto PATH exactly as before, and `bin/octi` (bash) stays the fallback.
 */
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

const result = await build({
  entryPoints: ['bin/octi.ts'],
  outfile: 'dist/octi',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});

if (result.errors.length > 0) process.exit(1);
chmodSync('dist/octi', 0o755);
