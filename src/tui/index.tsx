import React from 'react';
import { render } from 'ink';
import { TuiApp } from './app';

/**
 * Launch the TUI.
 * Connects to the gateway at the given URL (defaults to localhost:3007).
 */
export function launchTui(options?: { gatewayUrl?: string }): void {
  const gatewayUrl = options?.gatewayUrl || `ws://localhost:${process.env.PORT || 3007}/gateway`;

  render(
    <TuiApp gatewayUrl={gatewayUrl} />,
    { exitOnCtrlC: true },
  );
}

// Allow direct invocation: bun run src/tui/index.tsx
if (import.meta.main) {
  launchTui();
}
