/**
 * One-line top status bar: app name, connection dot, project label,
 * cumulative token/cost/turn counters, optional active expert.
 */
import { type Component, truncateToWidth } from '@mariozechner/pi-tui';
import type { ConnectionStatus } from '@/core/gateway/client';
import { chalk, getPalette } from '../theme/defaults';
import { getGlyphs } from '../theme/glyphs';

export interface CumulativeStats { tokens: number; cost: number; turns: number }

/** Last prompt's context fill. `window` absent ⇒ the model's size is unknown. */
export interface ContextFill { used: number; window?: number }

export interface McpSummary { connected: number; total: number }

export class StatusBar implements Component {
  private status: ConnectionStatus = 'disconnected';
  private project?: string;
  private expert: string | null = null;
  private stats: CumulativeStats = { tokens: 0, cost: 0, turns: 0 };
  private mcp: McpSummary | null = null;
  private context: ContextFill | null = null;
  private user: string | null = null;
  private mode: string | null = null;

  setStatus(status: ConnectionStatus): void { this.status = status; }
  setProject(project: string | undefined): void { this.project = project; }
  setExpert(expert: string | null): void { this.expert = expert; }
  setStats(stats: CumulativeStats): void { this.stats = stats; }
  setMcp(summary: McpSummary | null): void { this.mcp = summary; }
  setContext(fill: ContextFill | null): void { this.context = fill; }
  /** Signed-in username, or null while running as the local machine account. */
  setUser(user: string | null): void { this.user = user; }
  /** Free-form status segment; null hides it. Not wired to anything today —
   *  the run-mode badge it used to carry named a routing hop that no longer
   *  exists, and derived the prompt tier from a second, divergent threshold. */
  setMode(mode: string | null): void { this.mode = mode; }

  invalidate(): void { /* no cached state */ }

  render(width: number): string[] {
    const palette = getPalette();
    const dot = this.status === 'connected'
      ? chalk.hex(palette.ok)('●')
      : this.status === 'connecting' || this.status === 'authenticating'
        ? chalk.hex(palette.warn)('●')
        : chalk.hex(palette.error)('●');
    const title = chalk.bold.hex(palette.accent)('Octipus');
    const parts: string[] = [`${dot} ${title}`];
    if (this.mode) parts.push(chalk.hex(palette.accent)(`[${this.mode}]`));
    // Whose account this terminal is acting as. `local` is not a user: it
    // reaches no personal memories, vault secrets or account settings, so the
    // difference has to be visible without asking.
    parts.push(this.user
      ? chalk.hex(palette.ok)(`@${this.user}`)
      : chalk.hex(palette.dim)('@local'));
    if (this.project) parts.push(chalk.hex(palette.statusFg)(`${getGlyphs().project}${this.project}`));
    if (this.expert)  parts.push(chalk.hex(palette.accent)(`⟨${this.expert}⟩`));
    if (this.mcp && this.mcp.total > 0) {
      const colour = this.mcp.connected === this.mcp.total ? palette.ok
                   : this.mcp.connected === 0              ? palette.error
                   :                                         palette.warn;
      parts.push(chalk.hex(colour)(`mcp:${this.mcp.connected}/${this.mcp.total}`));
    }
    if (this.stats.tokens > 0 || this.stats.turns > 0) {
      const summary = `${formatTokens(this.stats.tokens)} · ${this.stats.turns} turns`
        + (this.stats.cost > 0 ? ` · $${this.stats.cost.toFixed(4)}` : '');
      parts.push(chalk.hex(palette.statusFg)(summary));
    }
    if (this.context && this.context.used > 0) {
      // Percentage when the window is known, raw size otherwise — an unknown
      // window is common for a self-hosted model with no metadata, and a made-up
      // denominator would read as a real one.
      if (this.context.window && this.context.window > 0) {
        const pct = Math.round((this.context.used / this.context.window) * 100);
        const colour = pct >= 90 ? palette.error : pct >= 70 ? palette.warn : palette.statusFg;
        parts.push(chalk.hex(colour)(`ctx ${pct}% (${formatTokens(this.context.used)})`));
      } else {
        parts.push(chalk.hex(palette.statusFg)(`ctx ${formatTokens(this.context.used)}`));
      }
    }
    parts.push(chalk.hex(palette.dim)(this.status));
    return [truncateToWidth(parts.join('  '), width)];
  }
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tok`;
  if (tokens >= 1_000)     return `${(tokens / 1_000).toFixed(1)}k tok`;
  return `${tokens} tok`;
}
