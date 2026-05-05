/**
 * pi-tui runtime bootstrap for octipus.
 *
 * Wraps `new TUI(new ProcessTerminal())` with the bits the chat shell
 * needs: SIGINT cleanup, terminal title, API port resolution, and a
 * place to swap in `BunProcessTerminal` later if Bun's stdin raw mode
 * trips ProcessTerminal.
 *
 * For Phase 1 the stock ProcessTerminal works on Bun (verified by
 * bun-runtime smoke test). If a regression appears, drop a custom
 * Terminal implementation here that conforms to pi-tui's `Terminal`
 * interface — the rest of the app sees only the TUI handle.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type KeybindingsManager, ProcessTerminal, TUI } from '@mariozechner/pi-tui';
import { installOctipusKeybindings } from './keybindings';

export interface RuntimeOptions {
  /** Override the default WebSocket URL (otherwise built from the API port). */
  gatewayUrl?: string;
  /** Show the OS-level hardware cursor. Default false (we render our own). */
  showHardwareCursor?: boolean;
  /** Title set on the terminal window. */
  title?: string;
}

export interface Runtime {
  tui: TUI;
  gatewayUrl: string;
  keybindings: KeybindingsManager;
  shutdown: () => Promise<void>;
}

/**
 * Read API port from .env (mirrors src/tui/index.tsx:32-48).
 */
export function getApiPort(): string {
  if (process.env.API_PORT) return process.env.API_PORT;
  const envPath = resolve(import.meta.dir, '../../.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    const match = content.match(/^API_PORT=(\d+)/m);
    if (match) return match[1];
    const portMatch = content.match(/^PORT=(\d+)/m);
    if (portMatch) return portMatch[1];
  }
  return '3005';
}

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const port = getApiPort();
  const gatewayUrl = options.gatewayUrl || `ws://localhost:${port}/gateway`;

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, options.showHardwareCursor ?? false);
  const keybindings = installOctipusKeybindings();

  if (options.title) terminal.setTitle(options.title);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { tui.stop(); } catch { /* terminal already torn down */ }
    try { await terminal.drainInput(800, 50); } catch { /* drain failure is non-fatal */ }
  };

  process.on('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });

  return { tui, gatewayUrl, keybindings, shutdown };
}
