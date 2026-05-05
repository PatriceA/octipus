/**
 * MCP server list overlay.
 *
 * Read-only snapshot of the configured MCP servers and their
 * connection state. Useful for spotting "MCP brought down a server"
 * during a long-running session without leaving the TUI.
 *
 * The component takes a small provider interface rather than a
 * direct dependency on `src/mcp/bridge.ts` so it can be tested
 * without wiring up the real bridge.
 */
import {
  type Component,
  type Focusable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from '@mariozechner/pi-tui';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

export type MCPConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

export interface MCPServerSummary {
  id: string;
  name: string;
  /** Transport label, e.g. 'stdio', 'sse', 'http'. */
  transport?: string;
  status: MCPConnectionStatus;
  toolCount?: number;
  error?: string;
}

export interface MCPServerListProvider {
  list(): readonly MCPServerSummary[];
  /** Optional: triggers a force-reconnect for the highlighted server. */
  reload?(serverId: string): Promise<void>;
}

export interface MCPServerListOptions {
  provider: MCPServerListProvider;
  onClose: () => void;
}

export class MCPServerList implements Component, Focusable {
  focused = false;
  private selected = 0;
  private summaries: readonly MCPServerSummary[] = [];

  constructor(private readonly options: MCPServerListOptions) {
    this.summaries = options.provider.list();
  }

  invalidate(): void {
    this.summaries = this.options.provider.list();
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) { this.options.onClose(); return; }
    if (matchesKey(data, 'up'))   { this.move(-1); return; }
    if (matchesKey(data, 'down')) { this.move( 1); return; }
    if (matchesKey(data, 'home')) { this.selected = 0; return; }
    if (matchesKey(data, 'end'))  { this.selected = Math.max(0, this.summaries.length - 1); return; }
    if (matchesKey(data, 'r') && this.options.provider.reload) {
      const target = this.summaries[this.selected];
      if (target) void this.options.provider.reload(target.id);
    }
  }

  render(width: number): string[] {
    const palette = getPalette();
    const border = (text: string) => chalk.hex(palette.border)(text);
    const dim = (text: string) => chalk.hex(palette.dim)(text);
    const accent = (text: string) => chalk.hex(palette.accent)(text);

    const summaries = this.summaries;
    const header = accent(`MCP servers · ${summaries.filter((s) => s.status === 'connected').length}/${summaries.length} connected`);
    const help = dim('↑↓ navigate · r reload · Esc close');

    const rows = summaries.length === 0
      ? [dim('No MCP servers configured.')]
      : summaries.map((s, i) => renderRow(s, i === this.selected, palette));

    const innerWidth = Math.max(visibleWidth(header), visibleWidth(help), ...rows.map(visibleWidth));
    const boxWidth = Math.min(width, innerWidth + 4);
    const inner = boxWidth - 4;
    const top    = border('┌' + '─'.repeat(boxWidth - 2) + '┐');
    const middle = (text: string) => border('│ ') + padTo(truncateToWidth(text, inner), inner) + border(' │');
    const bottom = border('└' + '─'.repeat(boxWidth - 2) + '┘');
    return [top, middle(header), ...rows.map(middle), middle(help), bottom];
  }

  private move(delta: number): void {
    if (this.summaries.length === 0) return;
    this.selected = Math.min(this.summaries.length - 1, Math.max(0, this.selected + delta));
  }

  // ── Test helpers ───────────────────────────────────────────────

  getSelectedIndex(): number { return this.selected; }
}

function renderRow(summary: MCPServerSummary, selected: boolean, palette: ReturnType<typeof getPalette>): string {
  const dot = chalk.hex(statusColor(summary.status, palette))('●');
  const name = chalk.hex(palette.fg)(summary.name);
  const meta = chalk.hex(palette.dim)(
    `${summary.transport ?? 'unknown'}${summary.toolCount !== undefined ? ` · ${summary.toolCount} tools` : ''}`
    + (summary.error ? ` · ${summary.error}` : ''),
  );
  const text = `${dot} ${name}  ${meta}`;
  return selected ? chalk.bgHex(palette.selection)(text) : text;
}

function statusColor(status: MCPConnectionStatus, palette: ReturnType<typeof getPalette>): string {
  switch (status) {
    case 'connected':    return palette.ok;
    case 'connecting':   return palette.warn;
    case 'disconnected': return palette.dim;
    case 'error':        return palette.error;
  }
}

function padTo(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return text;
  return text + ' '.repeat(width - w);
}

/**
 * Adapter that turns the runtime `MCPBridge` into a provider this
 * overlay understands. Imported lazily by the app so unit tests for
 * the overlay don't pull in the bridge module.
 */
export function bridgeProvider(bridge: {
  getAllConnections(): { id: string; server: { name?: string; type?: string }; status: MCPConnectionStatus; tools: unknown[]; error?: string }[];
  reconnect?: (id: string) => Promise<void>;
}): MCPServerListProvider {
  return {
    list: () => bridge.getAllConnections().map((c) => ({
      id: c.id,
      name: c.server.name ?? c.id,
      transport: c.server.type,
      status: c.status,
      toolCount: c.tools.length,
      error: c.error,
    })),
    reload: bridge.reconnect ? (id: string) => (bridge.reconnect as (i: string) => Promise<void>)(id) : undefined,
  };
}
