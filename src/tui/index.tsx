import React from 'react';
import { render } from 'ink';
import { TuiApp } from './app';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

// ── Synchronized output (CSI 2026) ─────────────────────────────
// Wraps each render frame in sync markers so the terminal can
// composite the whole frame atomically, eliminating flicker.
const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

function installSyncOutput(): void {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let inRender = false;
  process.stdout.write = function (chunk: any, ...args: any[]) {
    if (!inRender) {
      inRender = true;
      originalWrite(SYNC_START);
      queueMicrotask(() => {
        originalWrite(SYNC_END);
        inRender = false;
      });
    }
    return originalWrite(chunk, ...args);
  } as any;
}

/**
 * Read API port from .env file (same as the backend uses).
 */
function getApiPort(): string {
  // Check environment first
  if (process.env.API_PORT) return process.env.API_PORT;

  // Read from .env in project root
  const envPath = resolve(import.meta.dir, '../../.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    const match = content.match(/^API_PORT=(\d+)/m);
    if (match) return match[1];
    // Also check PORT= as fallback
    const portMatch = content.match(/^PORT=(\d+)/m);
    if (portMatch) return portMatch[1];
  }

  return '3005'; // Default API port
}

/**
 * Launch the TUI.
 * Connects to the gateway on the API server port (default 3005).
 */
export function launchTui(options?: { gatewayUrl?: string; projectPath?: string }): void {
  const port = getApiPort();
  const gatewayUrl = options?.gatewayUrl || `ws://localhost:${port}/gateway`;

  // Install synchronized output before first render
  installSyncOutput();

  render(
    <TuiApp gatewayUrl={gatewayUrl} projectPath={options?.projectPath} />,
    { exitOnCtrlC: true },
  );
}

// Allow direct invocation: bun run src/tui/index.tsx [--project /path/to/project]
if (import.meta.main) {
  const args = process.argv.slice(2);
  let projectPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--project' || args[i] === '-p') && args[i + 1]) {
      projectPath = resolve(args[i + 1]);
      i++;
    }
  }

  launchTui({ projectPath });
}
