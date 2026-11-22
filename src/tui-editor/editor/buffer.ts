/**
 * Transactional text buffer for the editor.
 *
 * Stores text as a flat array of lines (no rope or piece-table —
 * we're optimizing for terminals where files rarely exceed a few
 * thousand lines). Provides cursor + selection + grouped undo/redo.
 *
 * Coordinates: 0-indexed `(line, col)`. A column is a UTF-16 offset into
 * the line, and the cursor only stands on a grapheme boundary (`columns.ts`):
 * moving and deleting step over a whole user-perceived character. Lines never
 * contain `\n`; line endings are the file bridge's business.
 *
 * Undo records what each edit removed and inserted, not a copy of the
 * buffer. One undo step is one user action: a typing burst, a paste, a
 * replace-all, an agent edit (`transact`). An edit that changes nothing — a
 * Backspace at the start of the file — records nothing and keeps redo.
 *
 * Pure logic: no I/O. Tests live in `buffer.test.ts`.
 */
import { cellOf, colAtCell, nextBoundary, prevBoundary, snapToBoundary } from './columns';

export interface Position {
  line: number;
  col: number;
}

export interface Selection {
  anchor: Position;
  head: Position;
}

/** One replacement: `removed` was at `start`, `inserted` is there now. */
interface Edit {
  start: Position;
  removed: string;
  inserted: string;
}

/** Typing and deleting coalesce into one undo step while they continue where the last one ended. */
type Burst = 'type' | 'delete-back' | 'delete-fwd';

interface UndoStep {
  edits: Edit[];
  cursorBefore: Position;
  selectionBefore: Selection | null;
  cursorAfter: Position;
  burst: Burst | null;
  at: number;
}

const MAX_UNDO = 200;
/** A pause this long ends a typing burst. */
const BURST_GAP_MS = 1000;

export class Buffer {
  private lines: string[];
  private cursor: Position = { line: 0, col: 0 };
  private selection: Selection | null = null;
  private undoStack: UndoStep[] = [];
  private redoStack: UndoStep[] = [];
  /** The column Up/Down aim for (in cells), valid while the cursor is still where the last vertical move left it. */
  private goal: { cell: number; at: Position } | null = null;
  /** Edits of the action in progress; `depth` counts nested `transact` calls. */
  private pending: Edit[] = [];
  private depth = 0;
  private pendingBefore: { cursor: Position; selection: Selection | null } | null = null;
  /** Set when the cursor moved since the last edit: the next keystroke starts a new undo step. */
  private burstBroken = true;
  /** Increments on every mutation and cursor move; the renderer uses this to memoize. */
  public version = 0;
  /** Increments only when the text changes. */
  public textVersion = 0;
  /** Called after every change to the text (not cursor moves). */
  onChange: (() => void) | null = null;

  constructor(initialText: string) {
    this.lines = initialText.length === 0 ? [''] : initialText.split('\n');
  }

  // ── Read-only views ─────────────────────────────────────────────

  getLines(): readonly string[] { return this.lines; }
  getLine(i: number): string { return this.lines[i] ?? ''; }
  lineCount(): number { return this.lines.length; }
  text(): string { return this.lines.join('\n'); }
  getCursor(): Position { return { ...this.cursor }; }
  getSelection(): Selection | null {
    return this.selection ? {
      anchor: { ...this.selection.anchor },
      head: { ...this.selection.head },
    } : null;
  }

  /** Normalized [start, end] of the selection (start <= end). */
  selectionRange(): [Position, Position] | null {
    if (!this.selection) return null;
    const { anchor, head } = this.selection;
    return positionLte(anchor, head) ? [anchor, head] : [head, anchor];
  }

  /** The text between two positions. */
  textInRange(start: Position, end: Position): string {
    const [a, b] = positionLte(start, end) ? [start, end] : [end, start];
    if (a.line === b.line) return this.lines[a.line].slice(a.col, b.col);
    return [this.lines[a.line].slice(a.col), ...this.lines.slice(a.line + 1, b.line), this.lines[b.line].slice(0, b.col)].join('\n');
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  // ── Cursor + selection ──────────────────────────────────────────

  setCursor(p: Position, extendSelection = false): void {
    const safe = this.clampPosition(p);
    if (extendSelection) {
      const anchor = this.selection ? this.selection.anchor : { ...this.cursor };
      this.selection = { anchor, head: safe };
    } else {
      this.selection = null;
    }
    this.cursor = safe;
    this.burstBroken = true;
    this.version++;
  }

  /** Select from `anchor` to `head`; the cursor goes to `head`. */
  select(anchor: Position, head: Position): void {
    this.cursor = this.clampPosition(head);
    this.selection = { anchor: this.clampPosition(anchor), head: { ...this.cursor } };
    this.burstBroken = true;
    this.version++;
  }

  clearSelection(): void {
    this.selection = null;
    this.version++;
  }

  /**
   * Move the cursor by a delta. A horizontal step is one grapheme; moving
   * past the end of a line continues on the next. A vertical move keeps the
   * cell the cursor is drawn at, so it lines up across tabs and wide text.
   */
  moveCursor(dLine: number, dCol: number, extendSelection = false): void {
    if (dLine !== 0 && dCol === 0) {
      const line = Math.max(0, Math.min(this.lines.length - 1, this.cursor.line + dLine));
      // A shorter line clamps to its end, and the column comes back on the next line long enough to hold it.
      const cell = this.goal && positionEq(this.goal.at, this.cursor) ? this.goal.cell : cellOf(this.lines[this.cursor.line], this.cursor.col);
      this.setCursor({ line, col: colAtCell(this.lines[line], cell) }, extendSelection);
      this.goal = { cell, at: { ...this.cursor } };
      return;
    }
    let { line, col } = this.cursor;
    line = Math.max(0, Math.min(this.lines.length - 1, line + dLine));
    col = Math.min(col, this.lines[line].length);
    // Steps stop at a line boundary: running past the end lands on the next line's start, not further.
    for (let i = 0; i < Math.abs(dCol); i++) {
      const text = this.lines[line];
      if (dCol < 0) {
        if (col > 0) col = prevBoundary(text, col);
        else { if (line > 0) { line -= 1; col = this.lines[line].length; } break; }
      } else if (col < text.length) col = nextBoundary(text, col);
      else { if (line < this.lines.length - 1) { line += 1; col = 0; } break; }
    }
    this.setCursor({ line, col }, extendSelection);
  }

  moveLineStart(extend = false): void { this.setCursor({ line: this.cursor.line, col: 0 }, extend); }
  moveLineEnd(extend = false): void {
    this.setCursor({ line: this.cursor.line, col: this.lines[this.cursor.line].length }, extend);
  }
  moveDocStart(extend = false): void { this.setCursor({ line: 0, col: 0 }, extend); }
  moveDocEnd(extend = false): void {
    const last = this.lines.length - 1;
    this.setCursor({ line: last, col: this.lines[last].length }, extend);
  }

  /** Word-wise navigation. A word is `[A-Za-z0-9_]+`. */
  moveWordRight(extend = false): void {
    let { line, col } = this.cursor;
    while (line < this.lines.length) {
      const text = this.lines[line];
      // Skip current word characters.
      while (col < text.length && isWordChar(text[col])) col++;
      // Skip whitespace / punctuation up to next word.
      while (col < text.length && !isWordChar(text[col])) col++;
      if (col < text.length || line === this.lines.length - 1) break;
      line += 1;
      col = 0;
    }
    this.setCursor({ line, col: Math.min(col, this.lines[line]?.length ?? 0) }, extend);
  }

  moveWordLeft(extend = false): void {
    let { line, col } = this.cursor;
    while (line >= 0) {
      const text = this.lines[line];
      // Step back over whitespace.
      while (col > 0 && !isWordChar(text[col - 1])) col--;
      // Step back over the word.
      while (col > 0 && isWordChar(text[col - 1])) col--;
      if (col > 0 || line === 0) break;
      line -= 1;
      col = this.lines[line].length;
    }
    this.setCursor({ line, col }, extend);
  }

  // ── Mutations ───────────────────────────────────────────────────

  /**
   * Run `fn` as one undo step: everything it changes is undone together.
   * Nested calls join the outermost one.
   */
  transact(fn: () => void): void {
    this.begin();
    try { fn(); } finally { this.end(null); }
  }

  /** Insert text at the cursor (or replace the selection). One undo step. */
  insert(text: string): void {
    this.begin();
    try { this.insertInternal(text); } finally { this.end(null); }
  }

  /**
   * Text typed at the keyboard: consecutive keystrokes that continue where
   * the last one ended are one undo step, until a newline, a cursor move or
   * a pause.
   */
  type(text: string): void {
    this.begin();
    try { this.insertInternal(text); } finally { this.end(text.includes('\n') ? null : 'type'); }
  }

  /** Delete `count` graphemes left of the cursor, or the selection (Backspace). */
  deleteBackward(count = 1, burst = false): void {
    this.begin();
    try {
      if (this.selection) { this.deleteSelectionInternal(); return; }
      let { line, col } = this.cursor;
      for (let i = 0; i < count; i++) {
        if (col > 0) col = prevBoundary(this.lines[line], col);
        else if (line > 0) { line -= 1; col = this.lines[line].length; }
        else break;
      }
      this.replaceInternal({ line, col }, this.cursor, '');
    } finally { this.end(burst ? 'delete-back' : null); }
  }

  /** Delete `count` graphemes right of the cursor, or the selection (Delete). */
  deleteForward(count = 1, burst = false): void {
    this.begin();
    try {
      if (this.selection) { this.deleteSelectionInternal(); return; }
      let { line, col } = this.cursor;
      for (let i = 0; i < count; i++) {
        if (col < this.lines[line].length) col = nextBoundary(this.lines[line], col);
        else if (line < this.lines.length - 1) { line += 1; col = 0; }
        else break;
      }
      const at = { ...this.cursor };
      this.replaceInternal(at, { line, col }, '');
      this.cursor = at;
    } finally { this.end(burst ? 'delete-fwd' : null); }
  }

  /** Delete the line the cursor is on. */
  deleteLine(): void {
    this.begin();
    try {
      const { line, col } = this.cursor;
      if (this.lines.length === 1) {
        this.replaceInternal({ line: 0, col: 0 }, { line: 0, col: this.lines[0].length }, '');
      } else if (line < this.lines.length - 1) {
        this.replaceInternal({ line, col: 0 }, { line: line + 1, col: 0 }, '');
      } else {
        this.replaceInternal({ line: line - 1, col: this.lines[line - 1].length }, { line, col: this.lines[line].length }, '');
      }
      const newLine = Math.min(line, this.lines.length - 1);
      this.cursor = { line: newLine, col: snapToBoundary(this.lines[newLine], Math.min(col, this.lines[newLine].length)) };
      this.selection = null;
    } finally { this.end(null); }
  }

  /** Replace the entire buffer text (file reload, agent edits). One undo step. */
  setText(text: string): void {
    this.begin();
    try {
      const cursor = { ...this.cursor };
      const last = this.lines.length - 1;
      this.replaceInternal({ line: 0, col: 0 }, { line: last, col: this.lines[last].length }, text);
      this.cursor = this.clampPosition(cursor);
      this.selection = null;
    } finally { this.end(null); }
  }

  /** Replace a range of text (agent diff apply, find/replace). */
  replaceRange(start: Position, end: Position, text: string): void {
    this.begin();
    try { this.replaceInternal(start, end, text); this.selection = null; } finally { this.end(null); }
  }

  // ── Undo / redo ─────────────────────────────────────────────────

  undo(): boolean {
    const step = this.undoStack.pop();
    if (!step) return false;
    for (let i = step.edits.length - 1; i >= 0; i--) {
      const e = step.edits[i];
      this.splice(e.start, endOf(e.start, e.inserted), e.removed);
    }
    this.cursor = this.clampPosition(step.cursorBefore);
    this.selection = step.selectionBefore ? { anchor: { ...step.selectionBefore.anchor }, head: { ...step.selectionBefore.head } } : null;
    this.redoStack.push(step);
    this.changed();
    return true;
  }

  redo(): boolean {
    const step = this.redoStack.pop();
    if (!step) return false;
    for (const e of step.edits) this.splice(e.start, endOf(e.start, e.removed), e.inserted);
    this.cursor = this.clampPosition(step.cursorAfter);
    this.selection = null;
    this.undoStack.push(step);
    this.changed();
    return true;
  }

  // ── Internal ────────────────────────────────────────────────────

  private begin(): void {
    if (this.depth++ === 0) {
      this.pending = [];
      this.pendingBefore = { cursor: { ...this.cursor }, selection: this.getSelection() };
    }
  }

  private end(burst: Burst | null): void {
    if (--this.depth > 0) return;
    const edits = this.pending;
    const before = this.pendingBefore;
    this.pending = [];
    this.pendingBefore = null;
    if (edits.length === 0 || !before) { this.version++; return; }
    const now = Date.now();
    const top = this.undoStack[this.undoStack.length - 1];
    if (burst && top && top.burst === burst && !this.burstBroken && now - top.at < BURST_GAP_MS) {
      top.edits.push(...edits);
      top.cursorAfter = { ...this.cursor };
      top.at = now;
    } else {
      this.undoStack.push({ edits, cursorBefore: before.cursor, selectionBefore: before.selection, cursorAfter: { ...this.cursor }, burst, at: now });
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    }
    this.redoStack = [];
    this.burstBroken = burst === null;
    this.changed();
  }

  private changed(): void {
    this.version++;
    this.textVersion++;
    this.goal = null;
    this.onChange?.();
  }

  private insertInternal(text: string): void {
    if (this.selection) this.deleteSelectionInternal();
    this.replaceInternal(this.cursor, this.cursor, text);
    this.selection = null;
  }

  /** Replace [start, end) with `text`, record it, and leave the cursor after the inserted text. */
  private replaceInternal(start: Position, end: Position, text: string): void {
    const [a, b] = positionLte(start, end) ? [this.clampPosition(start, false), this.clampPosition(end, false)] : [this.clampPosition(end, false), this.clampPosition(start, false)];
    const removed = this.textInRange(a, b);
    this.cursor = endOf(a, text);
    if (removed === text) return;
    this.splice(a, b, text);
    this.pending.push({ start: { ...a }, removed, inserted: text });
  }

  /** Replace [a, b) with `text` without recording it. */
  private splice(a: Position, b: Position, text: string): void {
    const before = this.lines[a.line].slice(0, a.col);
    const after = this.lines[b.line].slice(b.col);
    const inserted = text.split('\n');
    inserted[0] = before + inserted[0];
    inserted[inserted.length - 1] += after;
    this.lines.splice(a.line, b.line - a.line + 1, ...inserted);
  }

  private clampPosition(p: Position, snap = true): Position {
    const line = Math.max(0, Math.min(p.line, this.lines.length - 1));
    const col = Math.max(0, Math.min(p.col, this.lines[line].length));
    return { line, col: snap ? snapToBoundary(this.lines[line], col) : col };
  }

  private deleteSelectionInternal(): void {
    const range = this.selectionRange();
    if (!range) return;
    this.replaceInternal(range[0], range[1], '');
    this.selection = null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────

export function positionEq(a: Position, b: Position): boolean {
  return a.line === b.line && a.col === b.col;
}

export function positionLte(a: Position, b: Position): boolean {
  return a.line < b.line || (a.line === b.line && a.col <= b.col);
}

/** Where text inserted at `start` ends. */
function endOf(start: Position, text: string): Position {
  const parts = text.split('\n');
  if (parts.length === 1) return { line: start.line, col: start.col + text.length };
  return { line: start.line + parts.length - 1, col: parts[parts.length - 1].length };
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}
