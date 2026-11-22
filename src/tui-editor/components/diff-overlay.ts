/**
 * Diff overlay shown when an agent edit lands on a buffer running
 * in `'lock'` mode (the Phase 4 TODO from the prototype inventory).
 *
 * Renders a unified-style LCS diff (`editor/diff.ts`) with line
 * markers (`+` / `-` / ` `) coloured by the palette. Scrolls
 * independently so large diffs stay reviewable on a single screen.
 *
 * The box is as tall as the rows the overlay is given (`setMaxRows`, from
 * the overlay frame), never taller: the diff body shrinks so the header,
 * the keys and the borders stay on screen. Below 8 rows the stats line and
 * the separators go first.
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
  visibleWidth,
} from '@/tui-kit';
import { drawBox } from '@/tui-kit/overlay-frame';
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
/** Top border, header, stats, two separators, keys, bottom border. */
const CHROME_ROWS = 7;
/** Top border, header, keys, bottom border. */
const COMPACT_CHROME_ROWS = 4;

export class DiffOverlay implements Component, Focusable {
  focused = false;
  readonly hunks: readonly Hunk[];
  readonly stats: { adds: number; dels: number };
  private scroll = 0;
  private bodyRows: number;
  private compact = false;

  constructor(private readonly options: DiffOverlayOptions) {
    this.hunks = diffLines(options.before, options.after);
    this.stats = diffStats(this.hunks);
    this.bodyRows = Math.max(4, options.height ?? DEFAULT_BODY_ROWS);
  }

  invalidate(): void { /* hunks computed once at construction */ }

  /** Fit the box into `rows` terminal rows. */
  setMaxRows(rows: number): void {
    if (!Number.isFinite(rows)) return;
    this.compact = rows < CHROME_ROWS + 1;
    this.bodyRows = Math.max(1, Math.min(this.options.height ?? Number.POSITIVE_INFINITY, rows - (this.compact ? COMPACT_CHROME_ROWS : CHROME_ROWS)));
    this.scrollBy(0);
  }

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

    const headerLines = this.compact ? [`${header} ${stats}`] : [header, stats];

    const innerWidth = Math.max(
      visibleWidth(header),
      visibleWidth(stats),
      visibleWidth(help),
      40,
    );
    const boxWidth = Math.min(width, innerWidth + 4);

    const visibleHunks = this.hunks.slice(this.scroll, this.scroll + this.bodyRows);
    const bodyLines = visibleHunks.map((h) => renderHunk(h, palette, ok, error));

    // A short diff still fills its rows, so the box does not jump as it scrolls.
    while (bodyLines.length < Math.min(this.bodyRows, this.hunks.length)) bodyLines.push('');
    const sections = this.compact ? [[...headerLines, ...bodyLines, help]] : [headerLines, bodyLines, [help]];
    return drawBox(sections, boxWidth, border);
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
