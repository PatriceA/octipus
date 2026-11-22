/**
 * Review of an agent edit, hunk by hunk.
 *
 * Shows the diff of the buffer (`before`) against the agent's text
 * (`after`) as `- old` / `+ new` rows. Given the buffer's saved text
 * (`base`), it is a three-way review (`editor/merge.ts`): only the agent's
 * changes are hunks, the user's unsaved edits are kept, and a change that
 * overlaps them is marked as a conflict (`!`) and starts rejected. Every run of changed lines is a hunk
 * that is accepted or rejected on its own; the text that results — the
 * accepted hunks from the agent, the rest as they were — is handed to
 * `onApply`. Within a changed line paired with its replacement, the words
 * that changed are highlighted. Long runs of unchanged lines are folded to a
 * `⋯ N unchanged lines` row (`z` unfolds), keeping three lines of context
 * around each hunk.
 *
 * The box is as tall as the rows the overlay is given (`setMaxRows`, from
 * the overlay frame), never taller: the diff body shrinks so the header,
 * the keys and the borders stay on screen. Below 8 rows the stats line and
 * the separators go first.
 *
 * Keys:
 *   y / n              — accept / reject the current hunk, then go to the next
 *   Space              — accept ⇄ reject the current hunk
 *   ] / Tab, [ / S-Tab — next / previous hunk
 *   z                  — fold ⇄ unfold unchanged lines
 *   Enter              — apply: every hunk not rejected is taken
 *   a / Ctrl+]         — accept every hunk and apply
 *   r / Esc / Ctrl+[   — reject every hunk and apply (the buffer stays as it was)
 *   ↑ / ↓, PgUp / PgDn, Home / End — scroll
 */
import { type Component, type Focusable, matchesKey, visibleWidth } from '@/tui-kit';
import { drawBox } from '@/tui-kit/overlay-frame';
import { displayText } from '../editor/columns';
import { diffLines, diffStats, type LineOp } from '../editor/diff';
import { applyHunks, buildHunks, type Hunk, intraLineChanges, type Span } from '../editor/hunks';
import { reviewDiff } from '../editor/merge';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

export interface ReviewResult {
  /** The buffer's text after the review. */
  text: string;
  accepted: number;
  rejected: number;
  total: number;
}

export interface DiffOverlayOptions {
  bufferLabel: string;
  before: string;
  after: string;
  /** The text the buffer was read or saved as, which the agent's text is based on: a three-way review. */
  base?: string;
  /** Number of visible diff body rows (excluding the header/footer chrome). */
  height?: number;
  /** The review is done; `result.text` is what the buffer should hold. */
  onApply: (result: ReviewResult) => void;
}

type Decision = 'pending' | 'accepted' | 'rejected';
type Row = { kind: 'op'; op: number } | { kind: 'fold'; count: number };

const DEFAULT_BODY_ROWS = 18;
/** Top border, header, stats, two separators, keys, bottom border. */
const CHROME_ROWS = 7;
/** Top border, header, keys, bottom border. */
const COMPACT_CHROME_ROWS = 4;
/** Unchanged lines kept on each side of a hunk when folding. */
const CONTEXT = 3;

export class DiffOverlay implements Component, Focusable {
  focused = false;
  readonly ops: readonly LineOp[];
  readonly hunks: readonly Hunk[];
  readonly stats: { adds: number; dels: number };
  /** The diff was too large to compare line by line and shows the change as one replacement. */
  readonly coarse: boolean;
  /** Per hunk: it overlaps the user's unsaved edits (starts rejected). */
  readonly conflicts: readonly boolean[];
  private readonly decisions: Decision[];
  /** The hunk each op belongs to (-1 for an unchanged line). */
  private readonly hunkOf: Int32Array;
  private rows: Row[] = [];
  private folded = true;
  private current = 0;
  private scroll = 0;
  private bodyRows: number;
  private compact = false;
  private readonly spans = new Map<number, Span[] | null>();

  constructor(private readonly options: DiffOverlayOptions) {
    if (options.base !== undefined && options.base !== options.before) {
      const review = reviewDiff(options.base, options.before, options.after);
      this.ops = review.ops;
      this.coarse = review.coarse;
      this.hunks = review.hunks;
      this.conflicts = review.conflicts;
    } else {
      const diff = diffLines(options.before, options.after);
      this.ops = diff.ops;
      this.coarse = diff.coarse;
      this.hunks = buildHunks(this.ops);
      this.conflicts = this.hunks.map(() => false);
    }
    this.stats = diffStats(this.ops);
    // A conflict replaces the user's own unsaved lines: rejected unless they say otherwise.
    this.decisions = this.hunks.map((h) => (this.conflicts[h.index] ? 'rejected' : 'pending'));
    this.hunkOf = new Int32Array(this.ops.length).fill(-1);
    for (const h of this.hunks) for (let i = h.start; i < h.end; i++) this.hunkOf[i] = h.index;
    this.bodyRows = Math.max(4, options.height ?? DEFAULT_BODY_ROWS);
    this.buildRows();
  }

  invalidate(): void { /* the diff is computed once at construction */ }

  /** Fit the box into `rows` terminal rows. */
  setMaxRows(rows: number): void {
    if (!Number.isFinite(rows)) return;
    this.compact = rows < CHROME_ROWS + 1;
    this.bodyRows = Math.max(1, Math.min(this.options.height ?? Number.POSITIVE_INFINITY, rows - (this.compact ? COMPACT_CHROME_ROWS : CHROME_ROWS)));
    this.scrollBy(0);
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'a') || matchesKey(data, 'ctrl+]')) { this.decisions.fill('accepted'); this.apply(); return; }
    if (matchesKey(data, 'r') || matchesKey(data, 'escape') || matchesKey(data, 'ctrl+[')) { this.decisions.fill('rejected'); this.apply(); return; }
    if (matchesKey(data, 'enter')) { this.apply(); return; }
    if (matchesKey(data, 'y')) { this.decide('accepted'); return; }
    if (matchesKey(data, 'n')) { this.decide('rejected'); return; }
    if (matchesKey(data, 'space')) {
      if (this.hunks.length) this.decisions[this.current] = this.decisions[this.current] === 'accepted' ? 'rejected' : 'accepted';
      return;
    }
    if (matchesKey(data, ']') || matchesKey(data, 'tab')) { this.goTo(this.current + 1); return; }
    if (matchesKey(data, '[') || matchesKey(data, 'shift+tab')) { this.goTo(this.current - 1); return; }
    if (matchesKey(data, 'z')) { this.folded = !this.folded; this.buildRows(); this.goTo(this.current); return; }
    if (matchesKey(data, 'down')) { this.scrollBy( 1); return; }
    if (matchesKey(data, 'up'))   { this.scrollBy(-1); return; }
    if (matchesKey(data, 'pageDown')) { this.scrollBy( this.bodyRows); return; }
    if (matchesKey(data, 'pageUp'))   { this.scrollBy(-this.bodyRows); return; }
    if (matchesKey(data, 'home')) { this.scroll = 0; return; }
    if (matchesKey(data, 'end'))  { this.scroll = Math.max(0, this.rows.length - this.bodyRows); return; }
  }

  render(width: number): string[] {
    const palette = getPalette();
    const border = (text: string) => chalk.hex(palette.warn)(text);
    const dim = (text: string) => chalk.hex(palette.dim)(text);
    const accent = (text: string) => chalk.hex(palette.accent)(text);
    const ok = (text: string) => chalk.hex(palette.ok)(text);
    const error = (text: string) => chalk.hex(palette.error)(text);

    const header = accent(`Agent edit: ${displayText(this.options.bufferLabel)}`);
    const accepted = this.decisions.filter((d) => d === 'accepted').length;
    const rejected = this.decisions.filter((d) => d === 'rejected').length;
    const position = this.hunks.length === 0 ? ' · no changes'
      : ` · hunk ${this.current + 1}/${this.hunks.length}${accepted || rejected ? ` · ${accepted} accepted, ${rejected} rejected` : ''}`;
    const conflicts = this.conflicts.filter(Boolean).length;
    const conflictNote = conflicts ? chalk.hex(palette.warn)(` · ${conflicts} conflict${conflicts === 1 ? '' : 's'} with your unsaved edits (!), rejected unless you accept`) : '';
    const stats = `${ok(`+${this.stats.adds}`)} ${error(`-${this.stats.dels}`)}${dim(position)}${conflictNote}${this.coarse ? dim(' · too large to compare line by line: shown as one replacement') : ''}`;
    const help = dim('y/n accept/reject hunk · ]/[ next/prev · z fold · Enter apply · a/r all');

    const headerLines = this.compact ? [`${header} ${stats}`] : [header, stats];

    const innerWidth = Math.max(
      visibleWidth(header),
      visibleWidth(stats),
      visibleWidth(help),
      40,
    );
    const boxWidth = Math.min(width, innerWidth + 4);

    const bodyLines = this.rows.slice(this.scroll, this.scroll + this.bodyRows).map((row) => this.renderRow(row, palette));

    // A short diff still fills its rows, so the box does not jump as it scrolls.
    while (bodyLines.length < Math.min(this.bodyRows, this.rows.length)) bodyLines.push('');
    const sections = this.compact ? [[...headerLines, ...bodyLines, help]] : [headerLines, bodyLines, [help]];
    return drawBox(sections, boxWidth, border);
  }

  private renderRow(row: Row, palette: ReturnType<typeof getPalette>): string {
    if (row.kind === 'fold') return chalk.hex(palette.dim)(`  ⋯ ${row.count} unchanged line${row.count === 1 ? '' : 's'} (z unfolds)`);
    const op = this.ops[row.op];
    const hunk = this.hunkOf[row.op];
    if (hunk < 0) return chalk.hex(palette.dim)(`    ${displayText(op.text)}`);
    const decision = this.decisions[hunk];
    const conflict = this.conflicts[hunk];
    const gutter = hunk === this.current ? chalk.hex(conflict ? palette.warn : palette.accent)('▌') : conflict ? chalk.hex(palette.warn)('!') : ' ';
    const mark = decision === 'accepted' ? chalk.hex(palette.ok)('✓') : decision === 'rejected' ? chalk.hex(palette.error)('✗') : ' ';
    const colour = op.op === 'add' ? palette.ok : palette.error;
    // A rejected hunk's agent lines and an accepted hunk's old lines are the ones going away.
    const fading = (decision === 'rejected' && op.op === 'add') || (decision === 'accepted' && op.op === 'del');
    const paint = fading ? chalk.hex(palette.dim).strikethrough : chalk.hex(colour);
    const sign = op.op === 'add' ? '+' : '-';
    return `${gutter}${mark}${paint(`${sign} `)}${highlightSpans(op.text, this.spansOf(row.op), paint)}`;
  }

  /** The changed words of a deleted or added line paired with its counterpart in the hunk, if any. */
  private spansOf(opIndex: number): Span[] | null {
    if (this.spans.has(opIndex)) return this.spans.get(opIndex) ?? null;
    const hunk = this.hunks[this.hunkOf[opIndex]];
    const op = this.ops[opIndex];
    const at = op.op === 'del' ? opIndex - hunk.start : opIndex - hunk.start - hunk.removed.length;
    let spans: Span[] | null = null;
    // Lines are paired in order; a hunk that only adds or only deletes has nothing to compare.
    if (at < hunk.removed.length && at < hunk.added.length) {
      const changes = intraLineChanges(hunk.removed[at], hunk.added[at]);
      spans = changes ? (op.op === 'del' ? changes.removed : changes.added) : null;
    }
    this.spans.set(opIndex, spans);
    return spans;
  }

  private decide(decision: Decision): void {
    if (!this.hunks.length) return;
    this.decisions[this.current] = decision;
    if (this.current < this.hunks.length - 1) this.goTo(this.current + 1);
  }

  /** Make hunk `index` current and scroll its first row into view, with a little context above. */
  private goTo(index: number): void {
    if (!this.hunks.length) return;
    this.current = Math.max(0, Math.min(this.hunks.length - 1, index));
    const start = this.hunks[this.current].start;
    const row = this.rows.findIndex((r) => r.kind === 'op' && r.op === start);
    if (row < 0) return;
    const last = this.rows.findIndex((r) => r.kind === 'op' && r.op === this.hunks[this.current].end - 1);
    if (row < this.scroll || last >= this.scroll + this.bodyRows) this.scroll = Math.max(0, row - Math.min(2, Math.floor(this.bodyRows / 4)));
    this.scrollBy(0);
  }

  private apply(): void {
    const accepted = this.decisions.filter((d) => d !== 'rejected').length;
    const text = applyHunks(this.ops, this.hunks, (h) => this.decisions[h.index] !== 'rejected');
    this.options.onApply({ text, accepted, rejected: this.hunks.length - accepted, total: this.hunks.length });
  }

  private buildRows(): void {
    const rows: Row[] = [];
    const near = new Uint8Array(this.ops.length);
    for (const h of this.hunks) {
      for (let i = Math.max(0, h.start - CONTEXT); i < Math.min(this.ops.length, h.end + CONTEXT); i++) near[i] = 1;
    }
    for (let i = 0; i < this.ops.length;) {
      if (!this.folded || this.hunkOf[i] >= 0 || near[i]) { rows.push({ kind: 'op', op: i }); i++; continue; }
      let j = i;
      while (j < this.ops.length && this.hunkOf[j] < 0 && !near[j]) j++;
      // Folding one line saves nothing: the fold row takes its place.
      if (j - i === 1) rows.push({ kind: 'op', op: i });
      else rows.push({ kind: 'fold', count: j - i });
      i = j;
    }
    this.rows = rows;
  }

  private scrollBy(delta: number): void {
    const max = Math.max(0, this.rows.length - this.bodyRows);
    this.scroll = Math.min(max, Math.max(0, this.scroll + delta));
  }

  // ── Test helpers ───────────────────────────────────────────────

  getScroll(): number { return this.scroll; }
  getRowCount(): number { return this.rows.length; }
  getCurrentHunk(): number { return this.current; }
  setBodyRows(n: number): void { this.bodyRows = Math.max(1, n); }
}

/** `text` drawn with `paint`, the spans in it inverted; tabs and control bytes as the editor draws them. */
function highlightSpans(text: string, spans: readonly Span[] | null, paint: (s: string) => string): string {
  if (!spans || spans.length === 0) return paint(displayText(text));
  let out = '';
  let col = 0;
  let cell = 0;
  const piece = (end: number, strong: boolean) => {
    if (end <= col) return;
    const shown = displayText(text.slice(col, end), cell);
    cell += visibleWidth(shown);
    out += paint(strong ? chalk.inverse(shown) : shown);
    col = end;
  };
  for (const span of spans) { piece(span.start, false); piece(span.end, true); }
  piece(text.length, false);
  return out;
}
