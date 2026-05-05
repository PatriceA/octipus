/**
 * Single-line widget that renders the live agent activity:
 *
 *   ⠋ Running edit … bash output preview
 *   ✓ edit                                    (briefly, then clears)
 *   ✗ bash                                    (briefly, then clears)
 *
 * Renders nothing when idle. Owns its own animation timer; the timer
 * is started when a tool transitions to executing/pending and stopped
 * once the slot returns to idle.
 *
 * Replaces the chat-line tool noise from Phase 1: tool state is
 * ephemeral by design (it shouldn't pollute the assistant transcript).
 */
import { type Component, truncateToWidth, type TUI } from '@mariozechner/pi-tui';
import { chalk, getPalette } from '../theme/defaults';
import type { ToolEventState, ToolState } from '../gateway-adapter';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;
const COMPLETED_HOLD_MS = 1500;

export class ActivityLine implements Component {
  private current: ToolEventState | null = null;
  private frame = 0;
  private interval?: ReturnType<typeof setInterval>;
  private clearTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly tui: TUI) {}

  invalidate(): void { /* no cached state */ }

  setTool(tool: ToolEventState | null): void {
    this.current = tool;
    if (this.clearTimer) { clearTimeout(this.clearTimer); this.clearTimer = undefined; }

    if (!tool) {
      this.stopSpinner();
      this.tui.requestRender();
      return;
    }

    if (tool.state === 'pending' || tool.state === 'executing') {
      this.startSpinner();
    } else {
      this.stopSpinner();
      // Hold completed/error briefly so the user sees the result.
      this.clearTimer = setTimeout(() => {
        this.current = null;
        this.tui.requestRender();
      }, COMPLETED_HOLD_MS);
    }
    this.tui.requestRender();
  }

  /** Stop animation timers (used on shutdown). */
  dispose(): void {
    this.stopSpinner();
    if (this.clearTimer) { clearTimeout(this.clearTimer); this.clearTimer = undefined; }
  }

  render(width: number): string[] {
    const tool = this.current;
    if (!tool) return [];
    const palette = getPalette();
    const symbol = symbolFor(tool.state, this.frame);
    const colour = colourFor(tool.state, palette);
    const badge = tool.mcpServer ? chalk.hex(palette.accent)(`[mcp:${tool.mcpServer}] `) : '';
    const preview = tool.preview ? chalk.hex(palette.dim)(` — ${tool.preview}`) : '';
    const line = `${colour(symbol)} ${badge}${tool.name}${preview}`;
    return [truncateToWidth(line, width)];
  }

  private startSpinner(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.tui.requestRender();
    }, SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = undefined;
  }
}

function symbolFor(state: ToolState, frame: number): string {
  switch (state) {
    case 'pending':
    case 'executing': return SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    case 'completed': return '✓';
    case 'error':     return '✗';
  }
}

function colourFor(state: ToolState, palette: ReturnType<typeof getPalette>): (text: string) => string {
  switch (state) {
    case 'completed': return chalk.hex(palette.ok);
    case 'error':     return chalk.hex(palette.error);
    default:          return chalk.hex(palette.accent);
  }
}
