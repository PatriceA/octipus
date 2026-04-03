#!/usr/bin/env bun
/**
 * Cross-platform CLI dispatcher.
 *
 * Detects the OS and spawns the appropriate platform script:
 *   - Windows  → bin/assistant.cmd
 *   - macOS / Linux → bin/assistant (bash)
 *
 * This file is the "bin" entry point in package.json so that
 * `bun link` produces a working global command on every platform.
 */

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const binDir = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';

const script = isWindows
  ? resolve(binDir, 'assistant.cmd')
  : resolve(binDir, 'assistant');

const args = process.argv.slice(2);

const result = isWindows
  ? spawnSync('cmd', ['/c', script, ...args], { stdio: 'inherit' })
  : spawnSync('bash', [script, ...args], { stdio: 'inherit' });

process.exit(result.status ?? 1);
