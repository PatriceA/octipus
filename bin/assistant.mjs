#!/usr/bin/env node
/**
 * Cross-platform CLI launcher.
 * Delegates to bin/assistant (bash) on Unix or bin/assistant.cmd on Windows.
 */
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (process.platform === 'win32') {
  const child = spawn('cmd.exe', ['/c', join(__dirname, 'assistant.cmd'), ...args], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const child = spawn('bash', [join(__dirname, 'assistant'), ...args], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}
