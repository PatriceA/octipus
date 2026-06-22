#!/usr/bin/env bun
/**
 * Compile the Octipus backend into a single self-contained executable and
 * place it where Tauri expects a sidecar binary:
 *
 *   web/src-tauri/binaries/octipus-server-<target-triple>[.exe]
 *
 * Tauri resolves the `<target-triple>` suffix at build time (see
 * `bundle.externalBin` in tauri.conf.json), so the file must carry the host
 * triple. We derive it from `rustc -vV` to stay in lock-step with the Rust
 * toolchain that will bundle it.
 *
 * The backend is a Bun app, so `bun build --compile` gives us the binary.
 * Embedded PGlite is bundled, which lets the desktop app run zero-config
 * (STORAGE_MODE=embedded). External pgvector + Valkey remain available by
 * setting DATABASE_URL / REDIS_URL / STORAGE_MODE at runtime — the sidecar
 * just inherits whatever the Rust launcher passes through.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const entry = join(repoRoot, 'src', 'index.ts');
const outDir = join(repoRoot, 'web', 'src-tauri', 'binaries');

function hostTargetTriple(): string {
  const res = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout) {
    throw new Error(
      'Could not run `rustc -vV` to determine the target triple. Install the Rust toolchain (https://rustup.rs).'
    );
  }
  const match = res.stdout.match(/^host:\s*(.+)$/m);
  if (!match) {
    throw new Error('Could not parse host target triple from `rustc -vV` output.');
  }
  return match[1].trim();
}

const triple = hostTargetTriple();
const ext = triple.includes('windows') ? '.exe' : '';
const outFile = join(outDir, `octipus-server-${triple}${ext}`);

if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

console.log(`Building backend sidecar → ${outFile}`);

// Externals mirror the backend `build` script (root package.json): these are
// optional/native and must not be statically bundled into the binary.
const result = spawnSync(
  'bun',
  [
    'build',
    '--compile',
    '--minify',
    '--sourcemap',
    '--target',
    'bun',
    '--external',
    'playwright',
    '--external',
    'playwright-core',
    '--external',
    'chromium-bidi',
    '--external',
    'electron',
    entry,
    '--outfile',
    outFile,
  ],
  { stdio: 'inherit', cwd: repoRoot }
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log('Sidecar build complete.');
