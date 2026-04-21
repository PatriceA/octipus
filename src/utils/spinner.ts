/**
 * KawaiiSpinner — terminal spinner with TTY detection.
 *
 * - TTY + not piped  → animated frames (classic or kawaii, via SPINNER_STYLE env)
 * - Non-TTY (pipe)   → static "..." line, no ANSI escapes
 *
 * Update rate is 80 ms.
 */

const CLASSIC_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const KAWAII_FRAMES = [
  '(｡･ω･｡)ﾉ♡',
  '(｡･ω･｡)ﾉ♡⋆',
  '(｡･ω･｡)ﾉ♡⋆｡',
  '(｡･ω･｡)ﾉ♡⋆｡ﾟ',
  '(｡･ω･｡)ﾉ ♡⋆｡ﾟ',
  '(｡･ω･｡)ﾉ  ⋆｡ﾟ',
  '(｡･ω･｡)ﾉ   ｡ﾟ',
  '(｡･ω･｡)ﾉ    ﾟ',
];

const UPDATE_MS = 80;

// ANSI
const CSI = '\u001b[';
const RESET = `${CSI}0m`;
const GREEN = `${CSI}32m`;
const RED = `${CSI}31m`;
const DIM = `${CSI}2m`;
const CLEAR_LINE = `${CSI}2K\r`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;

export type SpinnerStyle = 'classic' | 'kawaii';

export interface SpinnerOptions {
  /** Destination stream; defaults to `process.stdout`. Injectable for tests. */
  stream?: NodeJS.WriteStream;
  /** Force a style; otherwise reads `SPINNER_STYLE` env (default `classic`). */
  style?: SpinnerStyle;
  /** Override TTY detection (tests). */
  isTTY?: boolean;
  /** Override update interval (tests). */
  intervalMs?: number;
}

function resolveStyle(opts: SpinnerOptions): SpinnerStyle {
  if (opts.style) return opts.style;
  const envStyle = process.env.SPINNER_STYLE;
  if (envStyle === 'kawaii' || envStyle === 'classic') return envStyle;
  return 'classic';
}

export class KawaiiSpinner {
  private readonly stream: NodeJS.WriteStream;
  private readonly isTTY: boolean;
  private readonly frames: string[];
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameIdx = 0;
  private label = '';
  private active = false;

  constructor(opts: SpinnerOptions = {}) {
    this.stream = opts.stream ?? (process.stdout as NodeJS.WriteStream);
    this.isTTY = opts.isTTY ?? Boolean((this.stream as NodeJS.WriteStream).isTTY);
    const style = resolveStyle(opts);
    this.frames = style === 'kawaii' ? KAWAII_FRAMES : CLASSIC_FRAMES;
    this.intervalMs = opts.intervalMs ?? UPDATE_MS;
  }

  /** Begin spinning (or emit static line on non-TTY). */
  start(label: string): this {
    this.label = label;
    if (this.active) {
      // Already running — treat as label update
      return this.update(label);
    }
    this.active = true;
    if (!this.isTTY) {
      this.stream.write(`${label}...\n`);
      return this;
    }
    this.stream.write(HIDE_CURSOR);
    this.render();
    this.timer = setInterval(() => {
      this.frameIdx = (this.frameIdx + 1) % this.frames.length;
      this.render();
    }, this.intervalMs);
    // Don't keep the event loop alive just for animation
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
    return this;
  }

  /** Replace the active label (no flicker — just redraws the current frame). */
  update(label: string): this {
    this.label = label;
    if (this.active && this.isTTY) this.render();
    return this;
  }

  /** Stop with a green check; label optional. */
  succeed(label?: string): this {
    if (label !== undefined) this.label = label;
    return this.finish(`${GREEN}✓${RESET}`);
  }

  /** Stop with a red cross; label optional. */
  fail(label?: string): this {
    if (label !== undefined) this.label = label;
    return this.finish(`${RED}✗${RESET}`);
  }

  /** Silently tear down the spinner (no final line). */
  stop(): this {
    if (!this.active) return this;
    this.teardown();
    if (this.isTTY) {
      this.stream.write(CLEAR_LINE);
      this.stream.write(SHOW_CURSOR);
    }
    this.active = false;
    return this;
  }

  private finish(symbol: string): this {
    if (!this.active) return this;
    this.teardown();
    if (this.isTTY) {
      this.stream.write(CLEAR_LINE);
      this.stream.write(`${symbol} ${this.label}\n`);
      this.stream.write(SHOW_CURSOR);
    } else {
      // Strip ANSI from symbol for non-TTY
      const plain = symbol.replace(/\u001b\[[0-9;]*m/g, '');
      this.stream.write(`${plain} ${this.label}\n`);
    }
    this.active = false;
    return this;
  }

  private teardown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private render(): void {
    if (!this.isTTY) return;
    const frame = this.frames[this.frameIdx] ?? '';
    this.stream.write(`${CLEAR_LINE}${DIM}${frame}${RESET} ${this.label}`);
  }
}

/** Convenience: build and start a spinner in one call. */
export function createSpinner(label: string, opts?: SpinnerOptions): KawaiiSpinner {
  return new KawaiiSpinner(opts).start(label);
}
