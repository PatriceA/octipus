/**
 * Minimal e2e harness for the pi-tui chat shell + editor surface.
 *
 * Spawns the entry script under a fixed COLUMNS/LINES window, lets the
 * test push key bytes into stdin, and exposes the captured terminal
 * stream — both raw (with ANSI) and stripped (for visual snapshots).
 *
 * The test never relies on stdin being a real TTY: pi-tui's terminal
 * falls back to env vars when the size isn't reported, which keeps
 * the harness reproducible across machines.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface HarnessOptions {
  /** Path to the entry script, relative to the project root. */
  entry: string;
  /** Width in columns (default 120). */
  cols?: number;
  /** Height in rows (default 30). */
  rows?: number;
  /** Extra CLI args (forwarded after the entry). */
  args?: string[];
  /** Override the working directory (default: project root). */
  cwd?: string;
}

export class TuiHarness {
  readonly proc: ChildProcessWithoutNullStreams;
  private buffer = '';

  constructor(options: HarnessOptions) {
    this.proc = spawn('bun', ['run', options.entry, ...(options.args ?? [])], {
      cwd: options.cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        COLUMNS: String(options.cols ?? 120),
        LINES: String(options.rows ?? 30),
      },
    });
    this.proc.stdout.on('data', (data) => { this.buffer += data.toString(); });
    // Surface stderr through the test stream so failures aren't silent.
    this.proc.stderr.on('data', (data) => { process.stderr.write(`[harness] ${data}`); });
  }

  /** Push raw bytes to stdin (use \x0f for Ctrl+O, \r for Enter, \x1c for Ctrl+\\). */
  send(bytes: string): void {
    this.proc.stdin.write(bytes);
  }

  /** Wait for `ms` milliseconds — used to let the render queue settle. */
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Resolves once the captured stream contains `needle` (after stripping ANSI). */
  async waitFor(needle: string, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.stripped().includes(needle)) return;
      await this.wait(50);
    }
    throw new Error(`Timed out waiting for "${needle}". Captured tail:\n${this.tail(40)}`);
  }

  /** Full ANSI-stripped output from launch to now. */
  stripped(): string {
    return this.buffer
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b_[^\x07]*\x07/g, '');
  }

  /** Last `n` lines of the stripped stream (for snapshot diffs / debugging). */
  tail(n = 30): string {
    return this.stripped().split('\n').slice(-n).join('\n');
  }

  /** Visual snapshot: stripped, with trailing whitespace and blank lines collapsed. */
  snapshot(): string {
    return this.stripped()
      .split('\n')
      .map((line) => line.replace(/\s+$/, ''))
      .filter((line) => line.length > 0)
      .join('\n');
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    this.proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.proc.kill('SIGKILL'); resolve(); }, 1500);
      this.proc.on('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

/**
 * Probe the gateway. Returns true when the API is up — tests that need
 * a live backend skip gracefully when it isn't.
 */
export async function backendUp(port = Number(process.env.API_PORT ?? 3005)): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Common key sequences (bytes, not pi-tui ids). */
export const KEY = {
  Enter: '\r',
  Esc: '\x1b',
  Tab: '\t',
  Backspace: '\x7f',
  CtrlO: '\x0f',
  CtrlP: '\x10',
  CtrlQ: '\x11',
  CtrlBackslash: '\x1c',
  F6: '\x1b[17~',
} as const;
