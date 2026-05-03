#!/usr/bin/env node
/**
 * Cross-platform CLI launcher.
 * Delegates to bin/octi (bash) on Unix or bin/octi.cmd on Windows.
 */
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (process.platform === 'win32') {
  const child = spawn('cmd.exe', ['/c', join(__dirname, 'octi.cmd'), ...args], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const child = spawn('bash', [join(__dirname, 'octi'), ...args], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}
