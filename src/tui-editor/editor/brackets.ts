/**
 * The bracket that matches the one at the cursor: `(` `)`, `[` `]`, `{` `}`.
 *
 * The bracket under the cursor is used, or else the one just before it (the
 * cursor sits after a closing bracket just typed). Nesting is counted
 * without knowing the language, so a bracket inside a string or a comment
 * counts too; the search gives up after `MAX_SCAN` characters, which keeps a
 * render cheap in a large file.
 */
import type { Buffer, Position } from './buffer';

const OPEN = '([{';
const CLOSE = ')]}';
export const MAX_SCAN = 50_000;

export function matchBracket(buffer: Buffer, cursor: Position): [Position, Position] | null {
  const line = buffer.getLine(cursor.line);
  const at = bracketAt(line, cursor.col) ? cursor.col : cursor.col > 0 && bracketAt(line, cursor.col - 1) ? cursor.col - 1 : -1;
  if (at < 0) return null;
  const from = { line: cursor.line, col: at };
  const match = scan(buffer, from, line[at]);
  return match ? [from, match] : null;
}

function bracketAt(line: string, col: number): boolean {
  const ch = line[col];
  return ch !== undefined && (OPEN.includes(ch) || CLOSE.includes(ch));
}

function scan(buffer: Buffer, from: Position, bracket: string): Position | null {
  const forward = OPEN.includes(bracket);
  const mate = forward ? CLOSE[OPEN.indexOf(bracket)] : OPEN[CLOSE.indexOf(bracket)];
  let depth = 0;
  let scanned = 0;
  let { line, col } = from;
  let text = buffer.getLine(line);
  for (;;) {
    if (forward) {
      col++;
      while (col >= text.length) {
        if (++line >= buffer.lineCount()) return null;
        text = buffer.getLine(line);
        col = 0;
        if (text.length > 0) break;
      }
    } else {
      col--;
      while (col < 0) {
        if (--line < 0) return null;
        text = buffer.getLine(line);
        col = text.length - 1;
      }
    }
    if (++scanned > MAX_SCAN) return null;
    const ch = text[col];
    if (ch === bracket) depth++;
    else if (ch === mate) {
      if (depth === 0) return { line, col };
      depth--;
    }
  }
}
