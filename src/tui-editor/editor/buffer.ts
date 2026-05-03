/**
 * Transactional text buffer for the editor.
 *
 * Stores text as a flat array of lines (no rope or piece-table —
 * we're optimizing for terminals where files rarely exceed a few
 * thousand lines). Provides cursor + selection + undo/redo via a
 * snapshot stack.
 *
 * Coordinates: 0-indexed `(line, col)`. Columns are character
 * counts within the line (no tab expansion at this layer; the
 * renderer handles tab → spaces).
 *
 * Pure logic: no I/O, no React. Tests live in `buffer.test.ts`.
 */
export interface Position {
  line: number;
  col: number;
}

export interface Selection {
  anchor: Position;
  head: Position;
}

interface Snapshot {
  lines: string[];
  cursor: Position;
  selection: Selection | null;
}

const MAX_UNDO = 200;

export class Buffer {
  private lines: string[];
  private cursor: Position = { line: 0, col: 0 };
  private selection: Selection | null = null;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  /** Increments on every mutation; the renderer uses this to memoize. */
  public version = 0;

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
    this.version++;
  }

  clearSelection(): void {
    this.selection = null;
    this.version++;
  }

  /**
   * Move the cursor by a delta (lines, cols). Coalesces with the
   * existing line bound — moving past EOL clamps to EOL.
   */
  moveCursor(dLine: number, dCol: number, extendSelection = false): void {
    const next = { line: this.cursor.line + dLine, col: this.cursor.col + dCol };
    if (next.line < 0) next.line = 0;
    if (next.line >= this.lines.length) next.line = this.lines.length - 1;
    const lineLen = this.lines[next.line].length;
    if (next.col < 0) {
      // Wrap to previous line's end.
      if (next.line > 0) {
        next.line -= 1;
        next.col = this.lines[next.line].length;
      } else {
        next.col = 0;
      }
    } else if (next.col > lineLen) {
      if (next.line < this.lines.length - 1) {
        next.line += 1;
        next.col = 0;
      } else {
        next.col = lineLen;
      }
    }
    this.setCursor(next, extendSelection);
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

  /** Insert text at the cursor (or replace the selection). */
  insert(text: string): void {
    this.pushUndo();
    if (this.selection) this.deleteSelectionInternal();
    const { line, col } = this.cursor;
    const before = this.lines[line].slice(0, col);
    const after = this.lines[line].slice(col);
    const inserted = text.split('\n');
    if (inserted.length === 1) {
      this.lines[line] = before + inserted[0] + after;
      this.cursor = { line, col: col + inserted[0].length };
    } else {
      const newLines = [
        before + inserted[0],
        ...inserted.slice(1, -1),
        inserted[inserted.length - 1] + after,
      ];
      this.lines.splice(line, 1, ...newLines);
      this.cursor = {
        line: line + inserted.length - 1,
        col: inserted[inserted.length - 1].length,
      };
    }
    this.selection = null;
    this.version++;
  }

  /** Delete count chars left of the cursor (Backspace). */
  deleteBackward(count = 1): void {
    if (this.selection) { this.pushUndo(); this.deleteSelectionInternal(); this.version++; return; }
    if (count <= 0) return;
    this.pushUndo();
    let remaining = count;
    while (remaining > 0) {
      const { line, col } = this.cursor;
      if (col > 0) {
        const take = Math.min(col, remaining);
        this.lines[line] = this.lines[line].slice(0, col - take) + this.lines[line].slice(col);
        this.cursor = { line, col: col - take };
        remaining -= take;
      } else if (line > 0) {
        // Merge current line into previous.
        const prev = this.lines[line - 1];
        const cur = this.lines[line];
        this.lines.splice(line - 1, 2, prev + cur);
        this.cursor = { line: line - 1, col: prev.length };
        remaining -= 1;
      } else {
        break;
      }
    }
    this.version++;
  }

  /** Delete count chars right of the cursor (Delete). */
  deleteForward(count = 1): void {
    if (this.selection) { this.pushUndo(); this.deleteSelectionInternal(); this.version++; return; }
    if (count <= 0) return;
    this.pushUndo();
    let remaining = count;
    while (remaining > 0) {
      const { line, col } = this.cursor;
      const lineText = this.lines[line];
      if (col < lineText.length) {
        const take = Math.min(lineText.length - col, remaining);
        this.lines[line] = lineText.slice(0, col) + lineText.slice(col + take);
        remaining -= take;
      } else if (line < this.lines.length - 1) {
        // Merge next line into current.
        const next = this.lines[line + 1];
        this.lines.splice(line, 2, lineText + next);
        remaining -= 1;
      } else {
        break;
      }
    }
    this.version++;
  }

  /** Delete the line the cursor is on (Ctrl+K full-line variant). */
  deleteLine(): void {
    this.pushUndo();
    const { line } = this.cursor;
    if (this.lines.length === 1) {
      this.lines[0] = '';
    } else {
      this.lines.splice(line, 1);
    }
    const newLine = Math.min(line, this.lines.length - 1);
    this.cursor = { line: newLine, col: Math.min(this.cursor.col, this.lines[newLine].length) };
    this.selection = null;
    this.version++;
  }

  /** Replace the entire buffer text (used by file open, agent edits). */
  setText(text: string): void {
    this.pushUndo();
    this.lines = text.length === 0 ? [''] : text.split('\n');
    if (this.cursor.line >= this.lines.length) {
      this.cursor = { line: this.lines.length - 1, col: 0 };
    } else {
      this.cursor = {
        line: this.cursor.line,
        col: Math.min(this.cursor.col, this.lines[this.cursor.line].length),
      };
    }
    this.selection = null;
    this.version++;
  }

  /** Replace a range of text (used by agent diff apply + find/replace). */
  replaceRange(start: Position, end: Position, text: string): void {
    this.pushUndo();
    const [a, b] = positionLte(start, end) ? [start, end] : [end, start];
    const before = this.lines[a.line].slice(0, a.col);
    const after = this.lines[b.line].slice(b.col);
    const inserted = text.split('\n');
    if (inserted.length === 1) {
      this.lines.splice(a.line, b.line - a.line + 1, before + inserted[0] + after);
      this.cursor = { line: a.line, col: before.length + inserted[0].length };
    } else {
      const newLines = [
        before + inserted[0],
        ...inserted.slice(1, -1),
        inserted[inserted.length - 1] + after,
      ];
      this.lines.splice(a.line, b.line - a.line + 1, ...newLines);
      this.cursor = {
        line: a.line + inserted.length - 1,
        col: inserted[inserted.length - 1].length,
      };
    }
    this.selection = null;
    this.version++;
  }

  // ── Undo / redo ─────────────────────────────────────────────────

  undo(): boolean {
    const snap = this.undoStack.pop();
    if (!snap) return false;
    this.redoStack.push(this.snapshot());
    this.restore(snap);
    return true;
  }

  redo(): boolean {
    const snap = this.redoStack.pop();
    if (!snap) return false;
    this.undoStack.push(this.snapshot());
    this.restore(snap);
    return true;
  }

  // ── Internal ────────────────────────────────────────────────────

  private snapshot(): Snapshot {
    return {
      lines: [...this.lines],
      cursor: { ...this.cursor },
      selection: this.selection
        ? { anchor: { ...this.selection.anchor }, head: { ...this.selection.head } }
        : null,
    };
  }

  private restore(s: Snapshot): void {
    this.lines = [...s.lines];
    this.cursor = { ...s.cursor };
    this.selection = s.selection
      ? { anchor: { ...s.selection.anchor }, head: { ...s.selection.head } }
      : null;
    this.version++;
  }

  private pushUndo(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
  }

  private clampPosition(p: Position): Position {
    const line = Math.max(0, Math.min(p.line, this.lines.length - 1));
    const col = Math.max(0, Math.min(p.col, this.lines[line].length));
    return { line, col };
  }

  private deleteSelectionInternal(): void {
    if (!this.selection) return;
    const range = this.selectionRange();
    if (!range) return;
    const [a, b] = range;
    const before = this.lines[a.line].slice(0, a.col);
    const after = this.lines[b.line].slice(b.col);
    this.lines.splice(a.line, b.line - a.line + 1, before + after);
    this.cursor = { ...a };
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

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}
