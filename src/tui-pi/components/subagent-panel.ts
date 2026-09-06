/**
 * Subagents, folded into one line.
 *
 * A swarm run interleaved every child's tool calls with the root agent's in
 * the transcript, so a three-child fan-out buried the conversation under
 * somebody else's `→ websearch`. Here each child is one row — role, iteration,
 * what it is doing right now — and the whole block collapses to a single line
 * until you ask for it (`alt+s`).
 *
 * Deliberately timer-free: it re-renders on the events it is fed and on the
 * activity line's spinner ticks, so there is no second animation loop to stop.
 */
import { type Component, truncateToWidth } from '@mariozechner/pi-tui';
import { chalk, getPalette } from '../theme/defaults';
import type { ToolEventState } from '../gateway-adapter';

/** How long a finished subagent stays on screen before it is dropped. */
const DONE_LINGER_MS = 8000;
/**
 * How long a *running* row may go without any event before it is dropped as
 * abandoned. A child killed as a cross-process zombie (backend restart, orphan
 * reaper) never publishes a completion, and its row would otherwise sit here
 * counting upwards forever. The reaper's own window is ~10 minutes, so this is
 * deliberately longer than any live child's silence.
 */
const STALE_RUNNING_MS = 15 * 60 * 1000;

interface Entry {
  id: string;
  role: string;
  model?: string;
  iteration: number;
  toolCount: number;
  tool: ToolEventState | null;
  startedAt: number;
  /** Last event about this subagent — staleness is measured from here. */
  updatedAt: number;
  endedAt?: number;
  failed?: boolean;
}

export class SubagentPanel implements Component {
  private readonly agents = new Map<string, Entry>();
  private expanded = false;
  /** Injected for tests; the real clock otherwise. */
  constructor(private readonly now: () => number = Date.now) {}

  invalidate(): void { /* no cached state */ }

  /** True when at least one subagent is worth rendering. */
  get size(): number {
    this.prune();
    return this.agents.size;
  }

  /** Whether this id is a subagent we are tracking (so its events stay out of the feed). */
  has(id: string | undefined): boolean {
    return id !== undefined && this.agents.has(id);
  }

  isExpanded(): boolean { return this.expanded; }

  /** Flip collapsed/expanded. Returns the new state. */
  toggle(): boolean {
    this.expanded = !this.expanded;
    return this.expanded;
  }

  start(id: string, role: string, model?: string): void {
    this.agents.set(id, {
      id, role, model,
      iteration: 0,
      toolCount: 0,
      tool: null,
      startedAt: this.now(),
      updatedAt: this.now(),
    });
  }

  iteration(id: string, iteration: number): void {
    const entry = this.agents.get(id);
    if (!entry) return;
    entry.iteration = iteration;
    entry.updatedAt = this.now();
  }

  tool(id: string, tool: ToolEventState): void {
    const entry = this.agents.get(id);
    if (!entry) return;
    entry.tool = tool;
    entry.updatedAt = this.now();
    // Count starts, not results — a pending/executing pair plus its completion
    // is one call.
    if (tool.state === 'pending' || tool.state === 'executing') entry.toolCount++;
  }

  end(id: string, opts?: { failed?: boolean }): void {
    const entry = this.agents.get(id);
    if (!entry) return;
    entry.endedAt = this.now();
    entry.failed = opts?.failed;
    entry.tool = null;
  }

  /** Forget everything (a `/clear`, or a new turn after all children finished). */
  reset(): void {
    this.agents.clear();
  }

  render(width: number): string[] {
    this.prune();
    if (this.agents.size === 0) return [];
    const palette = getPalette();
    const dim = (text: string) => chalk.hex(palette.dim)(text);
    const entries = [...this.agents.values()];
    const running = entries.filter((e) => e.endedAt === undefined);

    if (!this.expanded) {
      const label = running.length === 1 ? '1 subagent' : `${running.length} subagents`;
      const heads = running
        .slice(0, 3)
        .map((e) => `${e.role} iter ${e.iteration}`)
        .join(' · ');
      const summary = running.length > 0
        ? `${label} · ${heads}${running.length > 3 ? ' · …' : ''}`
        : `${entries.length} subagent${entries.length === 1 ? '' : 's'} finished`;
      return [truncateToWidth(
        `${chalk.hex(palette.accent)('▸')} ${chalk.hex(palette.statusFg)(summary)} ${dim('· alt+s')}`,
        width,
      )];
    }

    const lines = [truncateToWidth(
      `${chalk.hex(palette.accent)('▾')} ${chalk.hex(palette.statusFg)(`subagents (${entries.length})`)} ${dim('· alt+s to collapse')}`,
      width,
    )];
    for (const entry of entries) {
      lines.push(truncateToWidth(`  ${this.row(entry)}`, width));
    }
    return lines;
  }

  private row(entry: Entry): string {
    const palette = getPalette();
    const done = entry.endedAt !== undefined;
    const symbol = done
      ? (entry.failed ? chalk.hex(palette.error)('✗') : chalk.hex(palette.ok)('✓'))
      : chalk.hex(palette.accent)('•');
    const parts = [chalk.hex(palette.statusFg)(entry.role)];
    if (!done) parts.push(`iter ${entry.iteration}`);
    if (entry.toolCount > 0) parts.push(`${entry.toolCount} tool${entry.toolCount === 1 ? '' : 's'}`);
    parts.push(formatElapsed((entry.endedAt ?? this.now()) - entry.startedAt));
    if (entry.tool) {
      const preview = entry.tool.preview ? ` → ${entry.tool.preview}` : '';
      parts.push(chalk.hex(palette.dim)(`${entry.tool.name}${preview}`));
    }
    return `${symbol} ${parts.join(chalk.hex(palette.dim)(' · '))}`;
  }

  /**
   * Drop finished subagents once they have been on screen long enough to read,
   * and running ones that stopped saying anything at all (their backend is
   * gone — see STALE_RUNNING_MS).
   */
  private prune(): void {
    const doneCutoff = this.now() - DONE_LINGER_MS;
    const staleCutoff = this.now() - STALE_RUNNING_MS;
    for (const [id, entry] of this.agents) {
      const finished = entry.endedAt !== undefined && entry.endedAt < doneCutoff;
      const abandoned = entry.endedAt === undefined && entry.updatedAt < staleCutoff;
      if (finished || abandoned) this.agents.delete(id);
    }
  }
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}
