import React from 'react';
import { render } from 'ink';
import { TuiApp } from './app';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

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
export function launchTui(options?: { gatewayUrl?: string }): void {
  const port = getApiPort();
  const gatewayUrl = options?.gatewayUrl || `ws://localhost:${port}/gateway`;

  render(
    <TuiApp gatewayUrl={gatewayUrl} />,
    { exitOnCtrlC: true },
  );
}

// Allow direct invocation: bun run src/tui/index.tsx
if (import.meta.main) {
  launchTui();
}
