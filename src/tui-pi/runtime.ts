/** Node terminal bootstrap: pi-tui, keybindings, connection defaults and shutdown. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type KeybindingsManager, ProcessTerminal, TUI } from '@mariozechner/pi-tui';
import { mouseReportFilter, setMouseCapture } from './terminal-actions';
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
  setExitHandler: (handler: (signal: 'SIGINT' | 'SIGTERM') => void) => void;
}

/**
 * Read API port from the environment or checkout configuration.
 */
export function getApiPort(): string {
  if (process.env.API_PORT) return process.env.API_PORT;
  const envPath = resolve(import.meta.dirname, '../../.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    const match = content.match(/^API_PORT=(\d+)/m);
    if (match) return match[1];
    const portMatch = content.match(/^PORT=(\d+)/m);
    if (portMatch) return portMatch[1];
  }
  return '3005';
}

/** The part of `process` the exit guards use; a fake stands in for it in tests. */
export interface GuardedProcess {
  on(event: 'uncaughtException' | 'unhandledRejection' | 'exit' | 'SIGHUP', listener: (value: unknown) => void): unknown;
  exit(code: number): void;
  stderr: { write(text: string): unknown };
}

/**
 * Put the terminal back on every way out, not only SIGINT and SIGTERM.
 *
 * Without this a crash left the user's shell in raw mode with mouse reporting
 * on and the cursor hidden: every click printed an escape sequence and typing
 * did not echo. `restore` must be synchronous and idempotent — on `exit` only
 * synchronous work runs. The error is printed after the restore, so it lands
 * on a working terminal instead of inside the frame.
 */
export function installExitGuards(restore: () => void, proc: GuardedProcess = process): void {
  const fatal = (kind: string) => (error: unknown) => {
    restore();
    proc.stderr.write(`\n${kind}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    proc.exit(1);
  };
  proc.on('uncaughtException', fatal('Uncaught exception'));
  proc.on('unhandledRejection', fatal('Unhandled rejection'));
  proc.on('exit', () => restore());
  // The terminal went away (window closed, SSH dropped): restore what can be, exit as a hangup.
  proc.on('SIGHUP', () => { restore(); proc.exit(129); });
}

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const port = getApiPort();
  const gatewayUrl = options.gatewayUrl || `ws://localhost:${port}/gateway`;

  const terminal = new class extends ProcessTerminal {
    // Keep wheel events available. Shift+drag remains native terminal selection.
    override start(...args: Parameters<ProcessTerminal['start']>): void {
      super.start(...args);
      setMouseCapture(this, true);
    }
    override stop(): void {
      setMouseCapture(this, false);
      super.stop();
    }
  }();
  const tui = new TUI(terminal, options.showHardwareCursor ?? false);
  const keybindings = installOctipusKeybindings();
  tui.addInputListener(mouseReportFilter(tui));

  if (options.title) terminal.setTitle(options.title);

  // tui.stop() shows the cursor, then the terminal turns off mouse reporting,
  // bracketed paste and the keyboard protocol, and leaves raw mode.
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    try { tui.stop(); } catch (error) {
      process.stderr.write(`Could not restore the terminal: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
  installExitGuards(restore);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    restore();
    try { await terminal.drainInput(800, 50); } catch { /* drain failure is non-fatal */ }
  };

  let exitHandler = (_signal: 'SIGINT' | 'SIGTERM') => { void shutdown().then(() => process.exit(0)); };
  process.on('SIGINT', () => exitHandler('SIGINT'));
  process.on('SIGTERM', () => exitHandler('SIGTERM'));
  return { tui, gatewayUrl, keybindings, shutdown, setExitHandler: handler => { exitHandler = handler; } };
}
