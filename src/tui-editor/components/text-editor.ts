import { sliceByColumn, type Component, CURSOR_MARKER, type Focusable, matchesKey, truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth } from '@/tui-kit';
import { decodeKittyPrintable } from '@/tui-kit/editing';
/**
 * The file editor's text pane: `editor/buffer.ts` drawn with line numbers,
 * highlighting, the selection, find matches and the matching bracket, and
 * driven by the keyboard and the mouse.
 *
 * Keyboard (modeless; vim mode goes through `editor/vim.ts` first): arrows,
 * Home/End, Ctrl+Left/Right by word, PageUp/PageDown, Ctrl+Home/End; with
 * Shift each extends the selection. Enter keeps the line's indentation (one
 * step more after an opening bracket). Ctrl+X / Ctrl+V cut and paste through
 * the clipboard the app hands in (`clipboard`); Ctrl+C is the app's, which
 * calls `copySelection`.
 *
 * Mouse: a click places the cursor, a drag selects (scrolling when it leaves
 * the pane) and copies on release, a double click selects a word and a
 * triple click the line, Shift+click extends the selection. The wheel
 * scrolls the view without moving the cursor. When the buffer is longer than
 * the pane a scrollbar is drawn in the last column; a click or a drag on it
 * scrolls there.
 *
 * Soft wrap (`setWrap`) breaks long lines into rows instead of scrolling
 * horizontally. The view keeps `SCROLLOFF` rows between the cursor and the
 * top or bottom while the cursor moves; scrolling with the wheel or the
 * scrollbar leaves the cursor where it is.
 *
 * The hardware cursor is positioned via pi-tui's CURSOR_MARKER, so IME
 * candidate windows land in the right spot for CJK input methods.
 */
import { type Position, positionEq } from '../editor/buffer';
import { matchBracket } from '../editor/brackets';
import { cellOf, cellWidth, displayText, graphemes, nextBoundary } from '../editor/columns';
import { highlight, type TokenKind } from '../editor/highlight';
import { indentAt } from '../editor/indent';
import { hintLine } from '../editor/highlight-tree-sitter';
import type { Match } from '../editor/search';
import { colInSegment, lineSegments, type RowPos, rowsBetween, type Segment, segmentAt, stepRows } from '../editor/view';
import type { BufferRecord, BufferStore } from '../stores/buffer-store';
import type { LayoutStore } from '../stores/layout-store';
import { newVimState, step as vimStep, type VimCommand, type VimKey, type VimState } from '../editor/vim';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

/** Rows kept between the cursor and the top or bottom of the pane while it moves. */
export const SCROLLOFF = 3;
/** Said when a paste arrives while an agent edit to the buffer is under review. */
const LOCKED_PASTE = 'Not pasted: an agent edit to this buffer is under review. Finish the review, then paste again.';
/** A line longer than this is highlighted and styled only where it is on screen, not whole. */
export const LONG_LINE = 2_000;
/** For a long line with wrap off: the line is indexed in pieces this many cells wide, to find the visible part. */
const WINDOW_CELLS = 512;
/** Lines whose rows are remembered; past it the cache starts over. */
const SEGMENT_CACHE_LINES = 4_096;

export interface EditorClipboard {
  /** Put text on the clipboard (the app's chain: native tool, tmux, OSC 52). */
  copy(text: string): void;
  /** What to paste: the system clipboard where it can be read, else the editor's last copy. */
  paste(): Promise<string | null>;
}

export interface TextEditorOptions {
  /** Number of rendered viewport rows. Defaults to 20; set per-frame via setHeight. */
  height?: number;
  /** When true, save events fire onSave with the active buffer. */
  onSave?: (buffer: BufferRecord) => void;
  /**
   * Optional layout store. When provided and `editorMode === 'vim'`,
   * input is routed through `editor/vim.ts` first; INSERT mode falls
   * through to the modeless handler so typing still works.
   */
  layout?: LayoutStore;
  /** A vim `:` command was entered (`:w`, `:q`, `:wq`, …). */
  onVimCommand?: (command: VimCommand, buffer: BufferRecord) => void;
  /** Something to tell the user in the mode bar. */
  onNotice?: (text: string) => void;
  /** Cut, copy and paste. Without it Ctrl+X and Ctrl+V do nothing. */
  clipboard?: EditorClipboard;
  /** The pane was clicked: give it the focus. */
  onFocus?: () => void;
  /** Something changed that needs drawing (the end of an asynchronous paste). */
  requestRender?: () => void;
}

export class TextEditor implements Component, Focusable {
  focused = false;
  private height: number;
  /** The first row shown: a buffer line and, with wrap on, a row within it. */
  private top: RowPos = { line: 0, sub: 0 };
  private scrollLeft = 0;
  private wrap = false;
  private paste: string | null = null;
  private vim: VimState = newVimState();
  private highlights: { bufferId: string; byLine: Map<number, Match[]>; current: Match | null } | null = null;
  /** The buffer and cursor the view last followed; a change brings the cursor into view. */
  private followed = '';
  /** What the last render drew: where text starts (after the line numbers) and whether a scrollbar is shown. */
  private drawn: { bufferId: string; gutter: number; inner: number; scrollbar: boolean } | null = null;
  /** A drag in progress: selecting from `anchor`, or dragging the scrollbar. */
  private drag: { kind: 'select'; anchor: Position } | { kind: 'scrollbar' } | null = null;

  constructor(private readonly buffers: BufferStore, private readonly options: TextEditorOptions = {}) {
    this.height = options.height ?? 20;
  }

  setHeight(rows: number): void {
    this.height = Math.max(1, rows);
  }

  /** Soft wrap on or off. */
  setWrap(on: boolean): void {
    if (this.wrap === on) return;
    this.wrap = on;
    this.top = { line: this.top.line, sub: 0 };
    this.scrollLeft = 0;
    this.followed = '';
  }

  isWrapping(): boolean { return this.wrap; }

  /** Expose vim state for the mode bar. */
  getVimState(): VimState { return this.vim; }

  /** Back to NORMAL with nothing pending: vim mode was just switched on. */
  resetVim(): void { this.vim = newVimState(); }

  /** The first buffer line shown (tests, the scrollbar). */
  getScrollTop(): number { return this.top.line; }

  /**
   * Draw find matches in buffer `bufferId`; `current` is the one the cursor
   * is on. `null` clears them.
   */
  setSearchHighlights(bufferId: string | null, matches: readonly Match[] = [], current: Match | null = null): void {
    if (!bufferId) { this.highlights = null; return; }
    const byLine = new Map<number, Match[]>();
    for (const m of matches) {
      const list = byLine.get(m.line);
      if (list) list.push(m); else byLine.set(m.line, [m]);
    }
    this.highlights = { bufferId, byLine, current };
  }

  invalidate(): void { /* re-render is driven by store subscribers */ }

  /** Copy the selection to the clipboard; false when nothing is selected. */
  copySelection(): boolean {
    const active = this.buffers.active();
    const range = active?.buffer.selectionRange();
    if (!active || !range || (range[0].line === range[1].line && range[0].col === range[1].col)) return false;
    this.options.clipboard?.copy(active.buffer.textInRange(range[0], range[1]));
    return true;
  }

  handleInput(data: string): void {
    const active = this.buffers.active();
    if (!active) return;

    // Paste accumulation runs even while the agent holds the buffer: a lock
    // taken mid-paste must still consume the terminator, or every later
    // keystroke would be swallowed as "paste continuation" forever.
    if (data.includes('\x1b[200~') || this.paste !== null) {
      this.paste = (this.paste ?? '') + data.replace('\x1b[200~', '');
      const end = this.paste.indexOf('\x1b[201~');
      if (end >= 0) {
        if (!active.agentLocked) active.buffer.insert(this.paste.slice(0, end).replace(/\r\n?/g, '\n'));
        else this.options.onNotice?.(LOCKED_PASTE);
        const rest = this.paste.slice(end + '\x1b[201~'.length);
        this.paste = null;
        // Keystrokes that arrived in the same chunk as the paste terminator.
        if (rest) this.handleInput(rest);
      }
      return;
    }
    if (active.agentLocked) return; // diff overlay owns the buffer
    // Saving works in every mode, NORMAL included.
    if (matchesKey(data, 'ctrl+s')) { this.options.onSave?.(active); return; }
    if (this.isVimActive()) {
      // Keys typed faster than they are read arrive as one chunk (`:w`, `dd`); vim reads them one at a time.
      if (data.length > 1 && !data.startsWith('\x1b') && !/[\x00-\x1f\x7f]/.test(data) && this.vim.mode !== 'INSERT') {
        for (const { segment } of graphemes(data)) this.handleInput(segment);
        return;
      }
      const result = vimStep(active.buffer, toVimKey(data), this.vim);
      this.vim = result.state;
      if (result.command) this.options.onVimCommand?.(result.command, active);
      if (result.unknownCommand) this.options.onNotice?.(`Not an editor command: :${result.unknownCommand} (try :w, :q, :wq, :qa)`);
      if (result.consumed) {
        this.scrollIntoView(active);
        return;
      }
      // INSERT mode fall-through: continue to modeless handling below.
    }

    this.modeless(active, data);
  }

  private modeless(active: BufferRecord, data: string): void {
    const buf = active.buffer;
    const printable = decodeKittyPrintable(data);
    const page = Math.max(1, this.height - 1);

    if (matchesKey(data, 'left') || matchesKey(data, 'shift+left'))      { buf.moveCursor(0, -1, matchesKey(data, 'shift+left')); }
    else if (matchesKey(data, 'right') || matchesKey(data, 'shift+right')) { buf.moveCursor(0, 1, matchesKey(data, 'shift+right')); }
    else if (matchesKey(data, 'up') || matchesKey(data, 'shift+up'))       { this.vertical(active, -1, matchesKey(data, 'shift+up')); }
    else if (matchesKey(data, 'down') || matchesKey(data, 'shift+down'))   { this.vertical(active, 1, matchesKey(data, 'shift+down')); }
    else if (matchesKey(data, 'ctrl+home') || matchesKey(data, 'ctrl+shift+home')) { buf.moveDocStart(matchesKey(data, 'ctrl+shift+home')); }
    else if (matchesKey(data, 'ctrl+end') || matchesKey(data, 'ctrl+shift+end'))   { buf.moveDocEnd(matchesKey(data, 'ctrl+shift+end')); }
    else if (matchesKey(data, 'home') || matchesKey(data, 'ctrl+a') || matchesKey(data, 'shift+home')) { buf.moveLineStart(matchesKey(data, 'shift+home')); }
    else if (matchesKey(data, 'end') || matchesKey(data, 'ctrl+e') || matchesKey(data, 'shift+end'))   { buf.moveLineEnd(matchesKey(data, 'shift+end')); }
    else if (matchesKey(data, 'ctrl+left') || matchesKey(data, 'alt+left'))   { buf.moveWordLeft(); }
    else if (matchesKey(data, 'ctrl+right') || matchesKey(data, 'alt+right')) { buf.moveWordRight(); }
    else if (matchesKey(data, 'ctrl+shift+left'))  { buf.moveWordLeft(true); }
    else if (matchesKey(data, 'ctrl+shift+right')) { buf.moveWordRight(true); }
    else if (matchesKey(data, 'pageUp') || matchesKey(data, 'shift+pageUp'))     { this.page(active, -page, matchesKey(data, 'shift+pageUp')); }
    else if (matchesKey(data, 'pageDown') || matchesKey(data, 'shift+pageDown')) { this.page(active, page, matchesKey(data, 'shift+pageDown')); }
    else if (matchesKey(data, 'backspace')) { buf.deleteBackward(1, true); }
    else if (matchesKey(data, 'delete'))    { buf.deleteForward(1, true); }
    else if (matchesKey(data, 'enter'))     { this.newline(active); }
    else if (matchesKey(data, 'tab'))       { const c = buf.getCursor(); buf.type(indentAt(active.indent, cellOf(buf.getLine(c.line), c.col))); }
    else if (matchesKey(data, 'ctrl+z'))    { buf.undo(); }
    else if (matchesKey(data, 'ctrl+y'))    { buf.redo(); }
    else if (matchesKey(data, 'ctrl+x'))    { if (this.copySelection()) buf.deleteBackward(); }
    else if (matchesKey(data, 'ctrl+v'))    { this.pasteFromClipboard(active); return; }
    else if (printable !== undefined)       { buf.type(printable); }
    else if (data.length === 1 && data >= ' ' && data !== '\x7f')          { buf.type(data); }
    else if (data.length > 1 && !data.startsWith('\x1b'))                  { buf.type(data); }
    else { return; }

    this.scrollIntoView(active);
  }

  /**
   * Up/Down: a buffer line with soft wrap off; with it on, a screen row, so a
   * wrapped line is walked row by row. The cell on screen is kept across
   * rows too short for it (`rowGoal`), as the buffer keeps it across lines.
   */
  private vertical(active: BufferRecord, delta: number, extend: boolean): void {
    const buf = active.buffer;
    if (!this.wrap) { buf.moveCursor(delta, 0, extend); return; }
    const cursor = buf.getCursor();
    const here = this.cursorRow(active);
    const row = this.segmentsOf(active, cursor.line)[here.sub];
    const goal = this.rowGoal && positionEq(this.rowGoal.at, cursor) ? this.rowGoal.cell : cellOf(buf.getLine(cursor.line), cursor.col) - row.startCell;
    const target = stepRows(here, delta, buf.lineCount(), (line) => this.rowsOf(active, line));
    if (target.line === here.line && target.sub === here.sub) return;
    const rows = this.segmentsOf(active, target.line);
    buf.setCursor({ line: target.line, col: colInSegment(buf.getLine(target.line), rows[target.sub], goal, target.sub === rows.length - 1) }, extend);
    this.rowGoal = { cell: goal, at: buf.getCursor() };
  }
  /** The cell within its row that Up/Down keep with soft wrap on, and where the cursor was when it was set. */
  private rowGoal: { cell: number; at: Position } | null = null;

  /** PageUp/PageDown: the cursor and the view move by a page together. */
  private page(active: BufferRecord, delta: number, extend: boolean): void {
    const count = active.buffer.lineCount();
    const rowsOf = (line: number) => this.rowsOf(active, line);
    this.top = stepRows(this.top, delta, count, rowsOf);
    this.clampTop(active);
    // The cursor moves as far, and stays clear of the edges as it would if it had walked there.
    const off = this.scrolloff();
    const minLine = this.top.line === 0 && this.top.sub === 0 ? 0 : stepRows(this.top, off, count, rowsOf).line;
    const bottom = stepRows(this.top, this.height - 1, count, rowsOf);
    const maxLine = bottom.line >= count - 1 ? count - 1 : stepRows(this.top, this.height - 1 - off, count, rowsOf).line;
    const current = active.buffer.getCursor().line;
    const line = Math.max(minLine, Math.min(maxLine, Math.max(0, Math.min(count - 1, current + delta))));
    active.buffer.moveCursor(line - current, 0, extend);
  }

  private scrolloff(): number {
    return Math.max(0, Math.min(SCROLLOFF, Math.floor((this.height - 1) / 2)));
  }

  /** Enter: a new line indented like this one, one step deeper after an opening bracket. */
  private newline(active: BufferRecord): void {
    const buf = active.buffer;
    const { line, col } = buf.getCursor();
    const text = buf.getLine(line);
    const base = /^[ \t]*/.exec(text)?.[0] ?? '';
    const lead = base.slice(0, col);
    const before = text.slice(0, col).trimEnd();
    const opener = /[{[(]$/.test(before) || (active.language === 'python' && before.endsWith(':'));
    const step = active.indent === '\t' ? '\t' : active.indent;
    const deeper = opener ? lead + step : lead;
    const closer = { '{': '}', '[': ']', '(': ')' }[before.at(-1) ?? ''];
    // Between a bracket and its closer: the closer goes on a line of its own.
    if (closer && text[col] === closer) {
      buf.transact(() => { buf.type(`\n${deeper}`); const at = buf.getCursor(); buf.insert(`\n${lead}`); buf.setCursor(at); });
      return;
    }
    buf.type(`\n${deeper}`);
  }

  private pasteFromClipboard(active: BufferRecord): void {
    const clipboard = this.options.clipboard;
    if (!clipboard) return;
    void clipboard.paste().then((text) => {
      if (text === null) { this.options.onNotice?.('Nothing to paste: the clipboard cannot be read here and nothing was copied in the editor.'); return; }
      if (this.buffers.active()?.id !== active.id) { this.options.onNotice?.(`Not pasted: the tab changed before the clipboard was read (${active.label}).`); return; }
      if (this.buffers.byId(active.id)?.agentLocked) { this.options.onNotice?.(LOCKED_PASTE); return; }
      active.buffer.insert(text.replace(/\r\n?/g, '\n'));
      this.scrollIntoView(active);
      this.options.requestRender?.();
    }, (error: unknown) => this.options.onNotice?.(`Paste failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  private isVimActive(): boolean {
    return (this.options.layout?.get().editorMode ?? 'modeless') === 'vim';
  }

  // ── Mouse ───────────────────────────────────────────────────────

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const active = this.buffers.active();
    if (event.type === 'wheel') {
      if (active && event.wheelDelta) this.scrollBy(active, event.wheelDelta);
      return { handled: true };
    }
    if (event.button !== 'left' && event.type !== 'release' && event.type !== 'move') return { handled: true };
    const drawn = this.drawn;
    if (!active || !drawn || drawn.bufferId !== active.id) {
      if (event.type === 'press') this.options.onFocus?.();
      return { handled: true };
    }
    const onScrollbar = drawn.scrollbar && event.x >= drawn.gutter + drawn.inner;
    if (event.type === 'press') {
      this.options.onFocus?.();
      if (onScrollbar) { this.drag = { kind: 'scrollbar' }; this.scrollbarTo(active, event.y); return { capture: true }; }
      const pos = this.positionAt(active, event.x, event.y);
      if (event.shift) {
        const range = active.buffer.getSelection();
        active.buffer.select(range?.anchor ?? active.buffer.getCursor(), pos);
      } else active.buffer.setCursor(pos);
      this.drag = { kind: 'select', anchor: event.shift ? (active.buffer.getSelection()?.anchor ?? pos) : pos };
      this.followed = this.followKey(active);
      return { capture: true };
    }
    if (event.type === 'drag') {
      if (this.drag?.kind === 'scrollbar') { this.scrollbarTo(active, event.y); return { handled: true }; }
      if (this.drag?.kind !== 'select') return { handled: true };
      // Past the top or the bottom: scroll a row and keep extending.
      if (event.y < 0) this.scrollBy(active, -1);
      else if (event.y >= this.height) this.scrollBy(active, 1);
      const pos = this.positionAt(active, event.x, Math.max(0, Math.min(this.height - 1, event.y)));
      active.buffer.select(this.drag.anchor, pos);
      this.followed = this.followKey(active);
      return { handled: true };
    }
    if (event.type === 'release') {
      const dragged = this.drag?.kind === 'select';
      this.drag = null;
      if (dragged) this.copySelection();
      return { handled: true, render: true };
    }
    if (event.type === 'click' && !onScrollbar && (event.clickCount ?? 1) >= 2) {
      const pos = this.positionAt(active, event.x, event.y);
      if (event.clickCount === 2) this.selectWord(active, pos);
      else active.buffer.select({ line: pos.line, col: 0 }, pos.line + 1 < active.buffer.lineCount() ? { line: pos.line + 1, col: 0 } : { line: pos.line, col: active.buffer.getLine(pos.line).length });
      this.followed = this.followKey(active);
      this.copySelection();
      return { handled: true };
    }
    return { handled: true };
  }

  /** The buffer position drawn at pane cell (x, y) by the last render. */
  private positionAt(active: BufferRecord, x: number, y: number): Position {
    const buf = active.buffer;
    const count = buf.lineCount();
    // From the view as it is now, which a drag may have scrolled since the last render.
    const rowsOf = (line: number) => this.rowsOf(active, line);
    const row = stepRows(this.top, Math.max(0, y), count, rowsOf);
    // Below the last line: the end of the buffer.
    if (rowsBetween(this.top, row, rowsOf, y + 1) < y) return { line: count - 1, col: buf.getLine(count - 1).length };
    const text = buf.getLine(row.line);
    const segments = this.wrap ? this.segmentsOf(active, row.line) : lineSegments(text, 0, false);
    const segment = segments[row.sub] ?? segments[0];
    const cellInRow = Math.max(0, x - (this.drawn?.gutter ?? 0)) + (this.wrap ? 0 : this.scrollLeft);
    return { line: row.line, col: colInSegment(text, segment, cellInRow, row.sub >= segments.length - 1) };
  }

  private selectWord(active: BufferRecord, pos: Position): void {
    const text = active.buffer.getLine(pos.line);
    const word = /[\p{L}\p{N}_]/u;
    const at = graphemes(text);
    let i = at.findIndex((g) => g.index + g.segment.length > pos.col);
    if (i < 0) i = at.length - 1;
    if (i < 0) return;
    const kind = (s: string) => (word.test(s) ? 'w' : /\s/.test(s) ? 's' : 'p');
    const k = kind(at[i].segment);
    let a = i;
    let b = i;
    while (a > 0 && kind(at[a - 1].segment) === k) a--;
    while (b + 1 < at.length && kind(at[b + 1].segment) === k) b++;
    active.buffer.select({ line: pos.line, col: at[a].index }, { line: pos.line, col: at[b].index + at[b].segment.length });
  }

  private scrollbarTo(active: BufferRecord, y: number): void {
    const lines = active.buffer.lineCount();
    const ratio = Math.max(0, Math.min(1, y / Math.max(1, this.height - 1)));
    this.top = { line: Math.round(ratio * Math.max(0, lines - this.height)), sub: 0 };
    this.clampTop(active);
  }

  /** Scroll the view by `delta` rows without moving the cursor. */
  private scrollBy(active: BufferRecord, delta: number): void {
    this.top = stepRows(this.top, delta, active.buffer.lineCount(), (line) => this.rowsOf(active, line));
    this.clampTop(active);
    // Scrolling is not a cursor move: the view does not jump back to the cursor at the next render.
    this.followed = this.followKey(active);
  }

  // ── Layout ──────────────────────────────────────────────────────

  private gutterWidth(active: BufferRecord, width: number): number {
    return Math.min(Math.max(0, width - 1), String(active.buffer.lineCount()).length + 1);
  }

  /** Cells for text: the pane less the gutter and, when the buffer is longer than the pane, the scrollbar. */
  private innerWidth(active: BufferRecord, width: number): { inner: number; scrollbar: boolean } {
    const gutter = this.gutterWidth(active, width);
    const scrollbar = active.buffer.lineCount() > this.height && width - gutter > 2;
    return { inner: Math.max(1, width - gutter - (scrollbar ? 1 : 0)), scrollbar };
  }

  /** The wrap width: one cell is kept for the cursor at the end of a full row. */
  private wrapWidth(): number { return Math.max(1, (this.lastInner ?? 80) - 1); }
  private lastInner: number | null = null;

  /**
   * A line's rows, remembered by (line text, width): breaking a line into
   * rows measures every grapheme, and the layout asks for the same lines
   * many times per frame and per key (scrolling, the cursor's row, the page).
   */
  private segmentsOf(active: BufferRecord, line: number): Segment[] {
    return this.cachedSegments(active.buffer.getLine(line), this.wrapWidth());
  }

  private readonly segmentCache = new Map<number, Map<string, Segment[]>>();
  private cachedSegments(text: string, width: number): Segment[] {
    let byText = this.segmentCache.get(width);
    if (!byText) {
      // Only the wrap width in use and the window index are kept.
      for (const w of [...this.segmentCache.keys()]) if (w !== WINDOW_CELLS) this.segmentCache.delete(w);
      byText = new Map();
      this.segmentCache.set(width, byText);
    }
    let segments = byText.get(text);
    if (!segments) {
      if (byText.size >= SEGMENT_CACHE_LINES) byText.clear();
      segments = lineSegments(text, width, true);
      byText.set(text, segments);
    }
    return segments;
  }

  /**
   * The part of a long line that cells [fromCell, toCell) fall in, as columns
   * [start, end) and the cell `start` is drawn at: whole pieces of the line's
   * window index, so the part starts and ends on grapheme boundaries.
   */
  private windowOf(text: string, fromCell: number, toCell: number): { start: number; end: number; startCell: number } {
    const pieces = this.cachedSegments(text, WINDOW_CELLS);
    let first = pieces.findIndex((p) => p.endCell > fromCell);
    if (first < 0) first = pieces.length - 1;
    let last = first;
    while (last + 1 < pieces.length && pieces[last].endCell < toCell) last++;
    return { start: pieces[first].start, end: pieces[last].end, startCell: pieces[first].startCell };
  }

  private rowsOf(active: BufferRecord, line: number): number {
    return this.wrap ? this.segmentsOf(active, line).length : 1;
  }

  /** The cursor's row: its line and the row of the line it is on. */
  private cursorRow(active: BufferRecord): RowPos {
    const c = active.buffer.getCursor();
    return { line: c.line, sub: this.wrap ? segmentAt(this.segmentsOf(active, c.line), c.col) : 0 };
  }

  /** Never further down than a full last page. */
  private clampTop(active: BufferRecord): void {
    const count = active.buffer.lineCount();
    const last = { line: count - 1, sub: this.rowsOf(active, count - 1) - 1 };
    const lowest = stepRows(last, -(this.height - 1), count, (line) => this.rowsOf(active, line));
    if (this.top.line > lowest.line || (this.top.line === lowest.line && this.top.sub > lowest.sub)) this.top = lowest;
    if (this.top.line < 0) this.top = { line: 0, sub: 0 };
    this.top.sub = Math.min(this.top.sub, this.rowsOf(active, this.top.line) - 1);
  }

  private followKey(active: BufferRecord): string {
    const c = active.buffer.getCursor();
    return `${active.id}:${c.line}:${c.col}:${active.buffer.textVersion}:${this.height}:${this.wrap}`;
  }

  render(width: number): string[] {
    const active = this.buffers.active();
    const palette = getPalette();
    if (width <= 0) return [];
    if (!active) {
      this.drawn = null;
      return [truncateToWidth(chalk.hex(palette.dim)('No buffer open. Press Ctrl+O to open a file.'), width, ''), ...Array(Math.max(0, this.height - 1)).fill('')];
    }
    const buf = active.buffer;
    const totalLines = buf.lineCount();
    const gutterW = this.gutterWidth(active, width);
    const { inner: innerW, scrollbar } = this.innerWidth(active, width);
    if (this.lastInner !== innerW) { this.lastInner = innerW; this.followed = ''; }
    // The cursor moved, the text or the size changed: bring the cursor into view.
    if (this.followed !== this.followKey(active)) this.scrollIntoView(active);
    this.clampTop(active);

    const cursor = buf.getCursor();
    const cursorLine = buf.getLine(cursor.line);
    const cursorCell = cellOf(cursorLine, cursor.col);
    const atCursor = cursorLine.slice(cursor.col, nextBoundary(cursorLine, cursor.col)) || ' ';
    const cursorWidth = Math.min(innerW, Math.max(1, cellWidth(atCursor, cursorCell)));
    if (!this.wrap) {
      if (cursorCell < this.scrollLeft) this.scrollLeft = cursorCell;
      if (cursorCell + cursorWidth > this.scrollLeft + innerW) this.scrollLeft = cursorCell + cursorWidth - innerW;
    }
    const selection = buf.selectionRange();
    const brackets = matchBracket(buf, cursor);
    const lines: string[] = [];
    const styledCache = new Map<number, string>();
    let pos: RowPos = { ...this.top };
    while (lines.length < this.height && pos.line < totalLines) {
      const i = pos.line;
      const raw = buf.getLine(i);
      const long = raw.length > LONG_LINE;
      // With wrap off the row is the scrolled window; its segment only says the line is one row.
      const segments = this.wrap ? this.segmentsOf(active, i) : [{ start: 0, end: raw.length, startCell: 0, endCell: 0 }];
      const segment = segments[pos.sub] ?? segments[0];
      const last = pos.sub >= segments.length - 1;
      const isCursorLine = i === cursor.line;
      const gutter = formatGutter(pos.sub === 0 ? i + 1 : null, gutterW, palette, isCursorLine);
      const rowStart = this.wrap ? segment.startCell : this.scrollLeft;
      const rowWidth = this.wrap && !last ? segment.endCell - segment.startCell : innerW;
      // A long line is styled only where this row shows it: the row's own columns with wrap on, the scrolled window with it off.
      const part = !long ? { start: 0, end: raw.length, startCell: 0 }
        : this.wrap ? { start: segment.start, end: segment.end, startCell: segment.startCell }
        : this.windowOf(raw, rowStart, rowStart + rowWidth);
      let styled = long ? undefined : styledCache.get(i);
      if (styled === undefined) {
        // Tell the tree-sitter highlighter which buffer and row we're about to
        // paint so its per-buffer cache lookup hits. Without this every line
        // falls through to the regex fallback.
        if (!long) hintLine(active.id, i);
        const marks: Mark[] = [];
        const highlights = this.highlights?.bufferId === active.id ? this.highlights.byLine.get(i) : undefined;
        for (const m of highlights ?? []) marks.push({ start: m.col, end: m.col + m.length, kind: m === this.highlights?.current ? 'current' : 'match' });
        for (const b of brackets ?? []) if (b.line === i) marks.push({ start: b.col, end: b.col + 1, kind: 'bracket' });
        let selectedEol = false;
        if (selection && i >= selection[0].line && i <= selection[1].line) {
          marks.push({ start: i === selection[0].line ? selection[0].col : 0, end: i === selection[1].line ? selection[1].col : raw.length, kind: 'selection' });
          // A selection that runs on past this line takes its line break: shown as one selected cell.
          selectedEol = i < selection[1].line;
        }
        const shifted = long ? marks.flatMap((m) => {
          const start = Math.max(m.start, part.start) - part.start;
          const end = Math.min(m.end, part.end) - part.start;
          return end > start ? [{ ...m, start, end }] : [];
        }) : marks;
        styled = renderLineTokens(long ? raw.slice(part.start, part.end) : raw, active.language, palette, shifted, part.startCell);
        if (selectedEol && part.end === raw.length) styled += chalk.bgHex(palette.selection)(' ');
        if (!long) styledCache.set(i, styled);
      }
      let body = sliceByColumn(styled, rowStart - part.startCell, rowWidth, true);
      const cursorHere = this.focused && isCursorLine && (this.wrap ? segmentAt(segments, cursor.col) === pos.sub : true);
      if (cursorHere) {
        const cursorX = cursorCell - rowStart;
        const before = sliceByColumn(styled, rowStart - part.startCell, cursorX, true);
        const pad = ' '.repeat(Math.max(0, cursorX - visibleWidth(before)));
        const glyph = sliceByColumn(`${displayText(atCursor === ' ' ? '' : atCursor, cursorCell)} `, 0, cursorWidth, true) || ' ';
        const after = sliceByColumn(styled, cursorCell + cursorWidth - part.startCell, Math.max(0, rowWidth - cursorX - cursorWidth), true);
        body = before + pad + CURSOR_MARKER + chalk.bgHex(palette.cursor).hex(palette.cursorFg)(glyph) + after;
      }
      lines.push(truncateToWidth(gutter + body, gutterW + innerW, ''));
      pos = last ? { line: i + 1, sub: 0 } : { line: i, sub: pos.sub + 1 };
    }

    // Pad to fixed viewport height so the renderer doesn't shrink.
    while (lines.length < this.height) lines.push(chalk.hex(palette.dim)('~'));
    this.drawn = { bufferId: active.id, gutter: gutterW, inner: innerW, scrollbar };
    if (!scrollbar) return lines;
    const bar = scrollbarCells(this.height, totalLines, this.top.line);
    return lines.map((line, row) => {
      const pad = Math.max(0, gutterW + innerW - visibleWidth(line));
      return `${line}${' '.repeat(pad)}${bar[row] ? chalk.hex(palette.accent)('┃') : chalk.hex(palette.border)('│')}`;
    });
  }

  /** Keep the cursor's row inside the view, `SCROLLOFF` rows from either edge where the buffer allows. */
  private scrollIntoView(active: BufferRecord): void {
    this.followed = this.followKey(active);
    const rowsOf = (line: number) => this.rowsOf(active, line);
    const count = active.buffer.lineCount();
    const off = this.scrolloff();
    const cursor = this.cursorRow(active);
    const fromTop = rowsBetween(this.top, cursor, rowsOf, this.height + off + 1);
    if (fromTop < off) this.top = stepRows(cursor, -off, count, rowsOf);
    else if (fromTop > this.height - 1 - off) this.top = stepRows(cursor, -(this.height - 1 - off), count, rowsOf);
    this.clampTop(active);
  }
}

/** Which rows of a scrollbar `height` rows tall are the thumb. */
export function scrollbarCells(height: number, lines: number, top: number): boolean[] {
  const thumb = Math.max(1, Math.round((height * height) / Math.max(1, lines)));
  const range = Math.max(1, lines - height);
  const start = Math.round(((height - thumb) * Math.min(top, range)) / range);
  return Array.from({ length: height }, (_, row) => row >= start && row < start + thumb);
}

function formatGutter(lineNumber: number | null, width: number, palette: ReturnType<typeof getPalette>, current: boolean): string {
  const text = width > 0 ? (lineNumber === null ? ' '.repeat(width) : (String(lineNumber).padStart(width - 1, ' ') + ' ').slice(-width)) : '';
  return current ? chalk.hex(palette.accentDim).bold(text) : chalk.hex(palette.dim)(text);
}

const TOKEN_COLORS: Record<TokenKind, keyof ReturnType<typeof getPalette> | null> = {
  plain: null,
  keyword: 'accent',
  string: 'ok',
  number: 'warn',
  comment: 'dim',
  function: 'accent',
  type: 'warn',
  operator: 'accent',
  punctuation: 'statusFg',
};

/** A range of a line drawn with a background: the selection, a find match, the current match, the matching brackets. */
interface Mark { start: number; end: number; kind: 'selection' | 'match' | 'current' | 'bracket' }

/** `line` styled; `startCell` is the cell it is drawn from (a piece of a long line), which tab stops count from. */
function renderLineTokens(line: string, language: string, palette: ReturnType<typeof getPalette>, marks: readonly Mark[], startCell = 0): string {
  if (line.length === 0) return '';
  // Route through the pluggable `highlight()` API rather than calling the
  // regex highlighter directly: it is the surface that
  // `installTreeSitterHighlighter()` swaps. Tokens are of the line as
  // stored; tabs and control pictures are applied per piece below, so the
  // tree-sitter cache (which validates against the stored text) hits for
  // lines with tabs too.
  const tokens = highlight(line, language as never);
  const cuts = new Set<number>();
  for (const m of marks) { cuts.add(m.start); cuts.add(m.end); }
  let out = '';
  let col = 0;
  let cell = startCell;
  for (const tok of tokens) {
    const colorKey = TOKEN_COLORS[tok.kind];
    const tokEnd = col + tok.text.length;
    let from = col;
    while (from < tokEnd) {
      let to = tokEnd;
      for (const c of cuts) if (c > from && c < to) to = c;
      const piece = tok.text.slice(from - col, to - col);
      const shown = displayText(piece, cell);
      cell += visibleWidth(shown);
      const mark = strongest(marks, from);
      let style = colorKey ? chalk.hex(palette[colorKey]) : chalk;
      if (mark === 'selection') style = style.bgHex(palette.selection);
      else if (mark === 'current') style = chalk.bgHex(palette.warn).hex(palette.cursorFg);
      else if (mark === 'match') style = style.underline.bgHex(palette.selection);
      else if (mark === 'bracket') style = style.bold.underline;
      out += colorKey || mark ? style(shown) : shown;
      from = to;
    }
    col = tokEnd;
  }
  return out;
}

/** The mark drawn at `col`: the current find match over the selection over other matches over a bracket. */
function strongest(marks: readonly Mark[], col: number): Mark['kind'] | null {
  const rank = { current: 4, selection: 3, match: 2, bracket: 1 } as const;
  let best: Mark['kind'] | null = null;
  for (const m of marks) {
    if (col < m.start || col >= m.end) continue;
    if (best === null || rank[m.kind] > rank[best]) best = m.kind;
  }
  return best;
}

/**
 * Convert terminal input into the small `VimKey` shape the vim handler
 * expects, through the key layer: Escape arrives as a lone ESC, or as
 * `ESC[27u` under the kitty keyboard protocol, and printable keys can arrive
 * CSI-u encoded too.
 */
export function toVimKey(data: string): VimKey {
  if (matchesKey(data, 'escape')) return { char: '', escape: true };
  if (matchesKey(data, 'ctrl+r')) return { char: 'r', ctrl: true };
  if (matchesKey(data, 'enter')) return { char: '', enter: true };
  if (matchesKey(data, 'backspace')) return { char: '', backspace: true };
  // Arrow keys map to the motions vim has for them.
  if (matchesKey(data, 'up')) return { char: 'k' };
  if (matchesKey(data, 'down')) return { char: 'j' };
  if (matchesKey(data, 'right')) return { char: 'l' };
  if (matchesKey(data, 'left')) return { char: 'h' };
  const char = decodeKittyPrintable(data) ?? (data.length > 0 && !data.startsWith('\x1b') && !/[\x00-\x1f\x7f]/.test(data) ? data : '');
  return { char, shift: char.length === 1 && char >= 'A' && char <= 'Z' };
}
