import { sliceByColumn, type Component, CURSOR_MARKER, type Focusable, matchesKey, truncateToWidth, visibleWidth } from '@/tui-kit';
import { decodeKittyPrintable } from '@/tui-kit/editing';
/**
 * pi-tui Component wrapping `editor/buffer.ts`.
 *
 * Phase 5 ships a modeless editor: arrow keys / printable chars /
 * enter / backspace map straight to Buffer operations. Vim mode and
 * the search overlays slot in via Phase 5.x once this foundation
 * proves stable.
 *
 * Renders as a numbered viewport that scrolls vertically to keep the
 * cursor in view. The hardware cursor is positioned via pi-tui's
 * CURSOR_MARKER mechanism so IME candidate windows land in the right
 * spot for CJK input methods.
 */
import { cellOf, cellWidth, displayText, graphemes, nextBoundary } from '../editor/columns';
import { highlight, type TokenKind } from '../editor/highlight';
import { indentAt } from '../editor/indent';
import { hintLine } from '../editor/highlight-tree-sitter';
import type { Match } from '../editor/search';
import type { BufferRecord, BufferStore } from '../stores/buffer-store';
import type { LayoutStore } from '../stores/layout-store';
import { newVimState, step as vimStep, type VimCommand, type VimKey, type VimState } from '../editor/vim';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

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
}


export class TextEditor implements Component, Focusable {
  focused = false;
  private height: number;
  private scrollTop = 0;
  private scrollLeft = 0;
  private paste: string | null = null;
  private vim: VimState = newVimState();
  private highlights: { bufferId: string; byLine: Map<number, Match[]>; current: Match | null } | null = null;

  constructor(private readonly buffers: BufferStore, private readonly options: TextEditorOptions = {}) {
    this.height = options.height ?? 20;
  }

  setHeight(rows: number): void {
    this.height = Math.max(1, rows);
  }

  /** Expose vim state for the mode bar. */
  getVimState(): VimState { return this.vim; }

  /** Back to NORMAL with nothing pending: vim mode was just switched on. */
  resetVim(): void { this.vim = newVimState(); }

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

    if (matchesKey(data, 'left'))           { buf.moveCursor(0, -1); }
    else if (matchesKey(data, 'right'))     { buf.moveCursor(0,  1); }
    else if (matchesKey(data, 'up'))        { buf.moveCursor(-1, 0); }
    else if (matchesKey(data, 'down'))      { buf.moveCursor( 1, 0); }
    else if (matchesKey(data, 'home') || matchesKey(data, 'ctrl+a'))      { buf.moveLineStart(); }
    else if (matchesKey(data, 'end')  || matchesKey(data, 'ctrl+e'))      { buf.moveLineEnd(); }
    else if (matchesKey(data, 'ctrl+left')  || matchesKey(data, 'alt+left'))  { buf.moveWordLeft(); }
    else if (matchesKey(data, 'ctrl+right') || matchesKey(data, 'alt+right')) { buf.moveWordRight(); }
    else if (matchesKey(data, 'backspace')) { buf.deleteBackward(1, true); }
    else if (matchesKey(data, 'delete'))    { buf.deleteForward(1, true); }
    else if (matchesKey(data, 'enter'))     { buf.type('\n'); }
    else if (matchesKey(data, 'tab'))       { const c = buf.getCursor(); buf.type(indentAt(active.indent, cellOf(buf.getLine(c.line), c.col))); }
    else if (matchesKey(data, 'ctrl+z'))    { buf.undo(); }
    else if (matchesKey(data, 'ctrl+y'))    { buf.redo(); }
    else if (printable !== undefined)       { buf.type(printable); }
    else if (data.length === 1 && data >= ' ' && data !== '\x7f')          { buf.type(data); }
    else if (data.length > 1 && !data.startsWith('\x1b'))                  { buf.type(data); }
    else { return; }

    this.scrollIntoView(active);
  }

  private isVimActive(): boolean {
    return (this.options.layout?.get().editorMode ?? 'modeless') === 'vim';
  }

  render(width: number): string[] {
    const active = this.buffers.active();
    const palette = getPalette();
    if (width <= 0) return [];
    if (!active) {
      return [truncateToWidth(chalk.hex(palette.dim)('No buffer open. Press Ctrl+O to open a file.'), width, ''), ...Array(Math.max(0, this.height - 1)).fill('')];
    }
    this.scrollIntoView(active);

    const buf = active.buffer;
    const totalLines = buf.lineCount();
    const cursor = buf.getCursor();
    const gutterW = Math.min(Math.max(0, width - 1), String(totalLines).length + 1); // line numbers + space
    const innerW = Math.max(1, width - gutterW);

    const cursorLine = buf.getLine(cursor.line);
    const cursorCell = cellOf(cursorLine, cursor.col);
    const atCursor = cursorLine.slice(cursor.col, nextBoundary(cursorLine, cursor.col)) || ' ';
    const cursorWidth = Math.min(innerW, Math.max(1, cellWidth(atCursor, cursorCell)));
    if (cursorCell < this.scrollLeft) this.scrollLeft = cursorCell;
    if (cursorCell + cursorWidth > this.scrollLeft + innerW) this.scrollLeft = cursorCell + cursorWidth - innerW;
    const selection = buf.selectionRange();
    const lines: string[] = [];
    const end = Math.min(totalLines, this.scrollTop + this.height);
    for (let i = this.scrollTop; i < end; i++) {
      const raw = buf.getLine(i);
      const lineText = displayText(raw);
      const isCursorLine = i === cursor.line;
      const gutter = formatGutter(i + 1, gutterW, palette, isCursorLine);
      // Tell the tree-sitter highlighter which buffer and row we're about to
      // paint so its per-buffer cache lookup hits. Without this every line
      // falls through to the regex fallback.
      hintLine(active.id, i);
      const marks: Mark[] = [];
      const highlights = this.highlights?.bufferId === active.id ? this.highlights.byLine.get(i) : undefined;
      for (const m of highlights ?? []) marks.push({ start: m.col, end: m.col + m.length, kind: m === this.highlights?.current ? 'current' : 'match' });
      let selectedEol = false;
      if (selection && i >= selection[0].line && i <= selection[1].line) {
        marks.push({ start: i === selection[0].line ? selection[0].col : 0, end: i === selection[1].line ? selection[1].col : raw.length, kind: 'selection' });
        // A selection that runs on past this line takes its line break: shown as one selected cell.
        selectedEol = i < selection[1].line;
      }
      let styled = renderLineTokens(raw, active.language, palette, marks);
      if (selectedEol) styled += chalk.bgHex(palette.selection)(' ');
      let body = sliceByColumn(styled, this.scrollLeft, innerW, true);
      if (this.focused && isCursorLine) {
        const cursorX = cursorCell - this.scrollLeft;
        const before = sliceByColumn(styled, this.scrollLeft, cursorX, true);
        const pad = ' '.repeat(Math.max(0, cursorX - visibleWidth(before)));
        const glyph = sliceByColumn(lineText + ' ', cursorCell, cursorWidth, true) || ' ';
        const after = sliceByColumn(styled, cursorCell + cursorWidth, Math.max(0, innerW - cursorX - cursorWidth), true);
        body = before + pad + CURSOR_MARKER + chalk.bgHex(palette.cursor).hex(palette.cursorFg)(glyph) + after;
      }
      lines.push(truncateToWidth(gutter + body, width, ''));
    }

    // Pad to fixed viewport height so the renderer doesn't shrink.
    while (lines.length < this.height) {
      lines.push(chalk.hex(palette.dim)('~'));
    }
    return lines;
  }

  private scrollIntoView(active: BufferRecord): void {
    const cursor = active.buffer.getCursor();
    if (cursor.line < this.scrollTop) {
      this.scrollTop = cursor.line;
    } else if (cursor.line >= this.scrollTop + this.height) {
      this.scrollTop = cursor.line - this.height + 1;
    }
    if (this.scrollTop < 0) this.scrollTop = 0;
  }
}

function formatGutter(lineNumber: number, width: number, palette: ReturnType<typeof getPalette>, current: boolean): string {
  const text = width > 0 ? (String(lineNumber).padStart(width - 1, ' ') + ' ').slice(-width) : '';
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

/** A range of a line drawn with a background: the selection, a find match, the current match. */
interface Mark { start: number; end: number; kind: 'selection' | 'match' | 'current' }

function renderLineTokens(line: string, language: string, palette: ReturnType<typeof getPalette>, marks: readonly Mark[]): string {
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
  let cell = 0;
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
      out += colorKey || mark ? style(shown) : shown;
      from = to;
    }
    col = tokEnd;
  }
  return out;
}

/** The mark drawn at `col`: the current find match over the selection over other matches. */
function strongest(marks: readonly Mark[], col: number): Mark['kind'] | null {
  const rank = { current: 3, selection: 2, match: 1 } as const;
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
