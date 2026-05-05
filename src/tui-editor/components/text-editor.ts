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
import { type Component, CURSOR_MARKER, type Focusable, matchesKey, truncateToWidth } from '@mariozechner/pi-tui';
import { highlightLine, type TokenKind } from '../editor/highlight';
import type { BufferRecord, BufferStore } from '../stores/buffer-store';
import type { LayoutStore } from '../stores/layout-store';
import { newVimState, step as vimStep, type VimKey, type VimState } from '../editor/vim';
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
}

const TAB_WIDTH = 4;

export class TextEditor implements Component, Focusable {
  focused = false;
  private height: number;
  private scrollTop = 0;
  private vim: VimState = newVimState();

  constructor(private readonly buffers: BufferStore, private readonly options: TextEditorOptions = {}) {
    this.height = options.height ?? 20;
  }

  setHeight(rows: number): void {
    this.height = Math.max(1, rows);
  }

  /** Expose vim state for the mode bar. */
  getVimState(): VimState { return this.vim; }

  invalidate(): void { /* re-render is driven by store subscribers */ }

  handleInput(data: string): void {
    const active = this.buffers.active();
    if (!active) return;
    if (active.agentLocked) return; // diff overlay owns the buffer

    if (this.isVimActive()) {
      const before = active.buffer.text();
      const result = vimStep(active.buffer, toVimKey(data), this.vim);
      this.vim = result.state;
      if (result.consumed) {
        if (active.buffer.text() !== before) this.buffers.markDirty(active.id, true);
        this.scrollIntoView(active);
        return;
      }
      // INSERT mode fall-through: continue to modeless handling below.
    }

    this.modeless(active, data);
  }

  private modeless(active: BufferRecord, data: string): void {
    const buf = active.buffer;
    let mutated = false;

    if (matchesKey(data, 'left'))           { buf.moveCursor(0, -1); }
    else if (matchesKey(data, 'right'))     { buf.moveCursor(0,  1); }
    else if (matchesKey(data, 'up'))        { buf.moveCursor(-1, 0); }
    else if (matchesKey(data, 'down'))      { buf.moveCursor( 1, 0); }
    else if (matchesKey(data, 'home') || matchesKey(data, 'ctrl+a'))      { buf.moveLineStart(); }
    else if (matchesKey(data, 'end')  || matchesKey(data, 'ctrl+e'))      { buf.moveLineEnd(); }
    else if (matchesKey(data, 'ctrl+left')  || matchesKey(data, 'alt+left'))  { buf.moveWordLeft(); }
    else if (matchesKey(data, 'ctrl+right') || matchesKey(data, 'alt+right')) { buf.moveWordRight(); }
    else if (matchesKey(data, 'backspace')) { buf.deleteBackward(); mutated = true; }
    else if (matchesKey(data, 'delete'))    { buf.deleteForward();  mutated = true; }
    else if (matchesKey(data, 'enter'))     { buf.insert('\n');     mutated = true; }
    else if (matchesKey(data, 'tab'))       { buf.insert('  ');     mutated = true; }
    else if (matchesKey(data, 'ctrl+z'))    { mutated = buf.undo(); }
    else if (matchesKey(data, 'ctrl+y'))    { mutated = buf.redo(); }
    else if (matchesKey(data, 'ctrl+s'))    { this.options.onSave?.(active); return; }
    else if (data.length === 1 && data >= ' ' && data !== '\x7f')          { buf.insert(data); mutated = true; }
    else if (data.length > 1 && !data.startsWith('\x1b'))                  { buf.insert(data); mutated = true; }
    else { return; }

    if (mutated) this.buffers.markDirty(active.id, true);
    this.scrollIntoView(active);
  }

  private isVimActive(): boolean {
    return (this.options.layout?.get().editorMode ?? 'modeless') === 'vim';
  }

  render(width: number): string[] {
    const active = this.buffers.active();
    const palette = getPalette();
    if (!active) {
      return [chalk.hex(palette.dim)('No buffer open. Press Ctrl+O to open a file.')];
    }
    this.scrollIntoView(active);

    const buf = active.buffer;
    const totalLines = buf.lineCount();
    const cursor = buf.getCursor();
    const gutterW = String(totalLines).length + 1; // line numbers + space
    const innerW = Math.max(1, width - gutterW);

    const lines: string[] = [];
    const end = Math.min(totalLines, this.scrollTop + this.height);
    for (let i = this.scrollTop; i < end; i++) {
      const lineText = buf.getLine(i).replace(/\t/g, ' '.repeat(TAB_WIDTH));
      const isCursorLine = i === cursor.line;
      const gutter = formatGutter(i + 1, gutterW, palette, isCursorLine);
      const styled = renderLineTokens(lineText, active.language, palette);
      const truncated = truncateToWidth(styled, innerW, '');
      let body: string;
      if (this.focused && isCursorLine) {
        body = composeLineWithCursor(lineText, cursor.col, palette);
        body = truncateToWidth(body, innerW, '');
      } else {
        body = truncated;
      }
      lines.push(gutter + body);
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
  const text = String(lineNumber).padStart(width - 1, ' ') + ' ';
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

function renderLineTokens(line: string, language: string, palette: ReturnType<typeof getPalette>): string {
  if (line.length === 0) return '';
  const tokens = highlightLine(line, language as never);
  let out = '';
  for (const tok of tokens) {
    const colorKey = TOKEN_COLORS[tok.kind];
    out += colorKey ? chalk.hex(palette[colorKey])(tok.text) : tok.text;
  }
  return out;
}

/**
 * Convert raw terminal input into the small `VimKey` shape the vim
 * handler expects. Only NORMAL/VISUAL keys need decoding; printable
 * characters land as `char`. Esc and Ctrl+R (redo) get explicit flags.
 */
function toVimKey(data: string): VimKey {
  if (data === '\x1b') return { char: '', escape: true };
  if (data === '\x12') return { char: 'r', ctrl: true };
  if (data.length === 1 && data >= ' ' && data !== '\x7f') {
    return { char: data, shift: data >= 'A' && data <= 'Z' };
  }
  // Arrow keys + special keys map to motions where vim has equivalents.
  if (data === '\x1b[A') return { char: 'k' };
  if (data === '\x1b[B') return { char: 'j' };
  if (data === '\x1b[C') return { char: 'l' };
  if (data === '\x1b[D') return { char: 'h' };
  return { char: '' };
}

function composeLineWithCursor(line: string, col: number, palette: ReturnType<typeof getPalette>): string {
  const safeCol = Math.min(Math.max(col, 0), line.length);
  const before = line.slice(0, safeCol);
  const at = line.charAt(safeCol) || ' ';
  const after = line.slice(safeCol + 1);
  const cursorBg = chalk.bgHex(palette.cursor);
  const fg = chalk.hex(palette.cursorFg);
  return before + CURSOR_MARKER + cursorBg(fg(at)) + after;
}
