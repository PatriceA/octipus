/**
 * Diff overlay shown when an agent edit lands on a buffer running
 * in `'lock'` mode (the Phase 4 TODO from the prototype inventory).
 *
 * Renders a unified-style LCS diff (`editor/diff.ts`) with line
 * markers (`+` / `-` / ` `) coloured by the palette. Scrolls
 * independently so large diffs stay reviewable on a single screen.
 *
 * Keys:
 *   a / Enter / Ctrl+] — accept (apply the agent edit to the buffer)
 *   r / Esc / Ctrl+[   — reject (release the lock, leave buffer alone)
 *   ↑ / ↓             — scroll one line
 *   PageUp / PageDown  — scroll one page
 */
import {
  type Component,
  type Focusable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from '@mariozechner/pi-tui';
import { diffLines, diffStats, type Hunk } from '../editor/diff';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

export interface DiffOverlayOptions {
  bufferLabel: string;
  before: string;
  after: string;
  /** Number of visible diff body rows (excluding the header/footer chrome). */
  height?: number;
  onAccept: () => void;
  onReject: () => void;
}

const DEFAULT_BODY_ROWS = 18;

export class DiffOverlay implements Component, Focusable {
  focused = false;
  readonly hunks: readonly Hunk[];
  readonly stats: { adds: number; dels: number };
  private scroll = 0;
  private bodyRows: number;

  constructor(private readonly options: DiffOverlayOptions) {
    this.hunks = diffLines(options.before, options.after);
    this.stats = diffStats(this.hunks);
    this.bodyRows = Math.max(4, options.height ?? DEFAULT_BODY_ROWS);
  }

  invalidate(): void { /* hunks computed once at construction */ }

  handleInput(data: string): void {
    if (matchesKey(data, 'a') || matchesKey(data, 'enter') || matchesKey(data, 'ctrl+]')) {
      this.options.onAccept();
      return;
    }
    if (matchesKey(data, 'r') || matchesKey(data, 'escape') || matchesKey(data, 'ctrl+[')) {
      this.options.onReject();
      return;
    }
    if (matchesKey(data, 'down')) { this.scrollBy( 1); return; }
    if (matchesKey(data, 'up'))   { this.scrollBy(-1); return; }
    if (matchesKey(data, 'pageDown')) { this.scrollBy( this.bodyRows); return; }
    if (matchesKey(data, 'pageUp'))   { this.scrollBy(-this.bodyRows); return; }
    if (matchesKey(data, 'home')) { this.scroll = 0; return; }
    if (matchesKey(data, 'end'))  { this.scroll = Math.max(0, this.hunks.length - this.bodyRows); return; }
  }

  render(width: number): string[] {
    const palette = getPalette();
    const border = (text: string) => chalk.hex(palette.warn)(text);
    const dim = (text: string) => chalk.hex(palette.dim)(text);
    const accent = (text: string) => chalk.hex(palette.accent)(text);
    const ok = (text: string) => chalk.hex(palette.ok)(text);
    const error = (text: string) => chalk.hex(palette.error)(text);

    const header = accent(`Agent edit: ${this.options.bufferLabel}`);
    const stats = `${ok(`+${this.stats.adds}`)} ${error(`-${this.stats.dels}`)}`;
    const help = dim('a/Enter accept · r/Esc reject · ↑↓/PgUp/PgDn scroll');

    const headerLines = [header, stats];

    const innerWidth = Math.max(
      visibleWidth(header),
      visibleWidth(stats),
      visibleWidth(help),
      40,
    );
    const boxWidth = Math.min(width, innerWidth + 4);
    const inner = boxWidth - 4;

    const visibleHunks = this.hunks.slice(this.scroll, this.scroll + this.bodyRows);
    const bodyLines = visibleHunks.map((h) => renderHunk(h, palette, ok, error));

    const top    = border('┌' + '─'.repeat(boxWidth - 2) + '┐');
    const middle = (text: string) => border('│ ') + padTo(truncateToWidth(text, inner), inner) + border(' │');
    const sep    = border('├' + '─'.repeat(boxWidth - 2) + '┤');
    const bottom = border('└' + '─'.repeat(boxWidth - 2) + '┘');

    return [
      top,
      ...headerLines.map(middle),
      sep,
      ...bodyLines.map(middle),
      sep,
      middle(help),
      bottom,
    ];
  }

  private scrollBy(delta: number): void {
    const max = Math.max(0, this.hunks.length - this.bodyRows);
    this.scroll = Math.min(max, Math.max(0, this.scroll + delta));
  }

  // ── Test helpers ───────────────────────────────────────────────

  getScroll(): number { return this.scroll; }
  setBodyRows(n: number): void { this.bodyRows = Math.max(1, n); }
}

function renderHunk(
  hunk: Hunk,
  palette: ReturnType<typeof getPalette>,
  ok: (text: string) => string,
  error: (text: string) => string,
): string {
  const text = hunk.text.length === 0 ? '' : hunk.text;
  if (hunk.op === 'add') return ok(`+ ${text}`);
  if (hunk.op === 'del') return error(`- ${text}`);
  return chalk.hex(palette.dim)(`  ${text}`);
}

function padTo(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return text;
  return text + ' '.repeat(width - w);
}
