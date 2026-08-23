#!/usr/bin/env tsx
/**
 * One-shot launcher for the TUI editor.
 *
 * Delegates to `src/tui-editor/index.ts` so the editor surface has a
 * stable command-line entry independent of the file path. Forwards
 * every argument unchanged — the editor accepts `[--project /path]`
 * today; future flags slot in there.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'src', 'tui-editor', 'index.ts');

const child = spawn('bun', ['run', entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
});

child.on('exit', (code) => process.exit(code ?? 1));
