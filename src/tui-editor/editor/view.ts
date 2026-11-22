/**
 * Where buffer text lands on screen: one row per line, or several when soft
 * wrap is on, and back from a screen cell to a buffer position (the mouse).
 *
 * A row shows the cells [startCell, endCell) of its line; with wrap off a
 * line is one row as wide as the line, scrolled horizontally by the editor.
 * With wrap on, rows break between graphemes so a wide character is never
 * split, and every row but a line's last fits `width` cells. Cells are the
 * editor's own (`columns.ts`): tabs advance to the next stop counted from the
 * start of the line, so a line wraps the same way however it is scrolled.
 */
import { cellWidth, colAtCell, graphemes } from './columns';

export interface Segment {
  /** UTF-16 columns of the line shown on this row: [start, end). */
  start: number;
  end: number;
  /** Cells of the line shown on this row: [startCell, endCell). */
  startCell: number;
  endCell: number;
}

/** A line's rows: always at least one (an empty line is one empty row). */
export function lineSegments(line: string, width: number, wrap: boolean): Segment[] {
  if (!wrap || width <= 0) return [{ start: 0, end: line.length, startCell: 0, endCell: cellWidth(line) }];
  const out: Segment[] = [];
  let rowStart = 0;
  let rowStartCell = 0;
  let cell = 0;
  for (const { index, segment } of graphemes(line)) {
    const w = cellWidth(segment, cell);
    if (cell + w - rowStartCell > width && index > rowStart) {
      out.push({ start: rowStart, end: index, startCell: rowStartCell, endCell: cell });
      rowStart = index;
      rowStartCell = cell;
    }
    cell += w;
  }
  out.push({ start: rowStart, end: line.length, startCell: rowStartCell, endCell: cell });
  return out;
}

/** The row of `segments` that shows column `col` (the end of the line is on the last row). */
export function segmentAt(segments: readonly Segment[], col: number): number {
  for (let i = 0; i < segments.length; i++) if (col < segments[i].end) return i;
  return segments.length - 1;
}

/** The buffer column under `cellInRow` cells into the row `segment` (clamped to the row). */
export function colInSegment(line: string, segment: Segment, cellInRow: number, last: boolean): number {
  const col = colAtCell(line, segment.startCell + Math.max(0, cellInRow));
  // A click past the end of a wrapped row lands on its last character, not the next row's first.
  if (!last && col >= segment.end) return Math.max(segment.start, previousStart(line, segment));
  return Math.min(col, segment.end);
}

function previousStart(line: string, segment: Segment): number {
  let start = segment.start;
  for (const { index } of graphemes(line.slice(0, segment.end))) if (index >= segment.start) start = index;
  return start;
}

/** A position in rows: a buffer line and a row within it. */
export interface RowPos { line: number; sub: number }

/**
 * Step `pos` by `delta` rows (negative: up), staying within the buffer.
 * `rowsOf(line)` is how many rows a line takes.
 */
export function stepRows(pos: RowPos, delta: number, lineCount: number, rowsOf: (line: number) => number): RowPos {
  let { line, sub } = pos;
  if (delta > 0) {
    for (let n = 0; n < delta; n++) {
      if (sub + 1 < rowsOf(line)) sub++;
      else if (line + 1 < lineCount) { line++; sub = 0; } else break;
    }
  } else {
    for (let n = 0; n < -delta; n++) {
      if (sub > 0) sub--;
      else if (line > 0) { line--; sub = rowsOf(line) - 1; } else break;
    }
  }
  return { line, sub };
}

/** Rows from `a` down to `b` (negative when `b` is above `a`). Counts at most `limit` rows either way. */
export function rowsBetween(a: RowPos, b: RowPos, rowsOf: (line: number) => number, limit: number): number {
  const forward = b.line > a.line || (b.line === a.line && b.sub >= a.sub);
  const [from, to] = forward ? [a, b] : [b, a];
  let count = 0;
  let { line, sub } = from;
  while ((line < to.line || sub < to.sub) && count < limit) {
    if (sub + 1 < rowsOf(line)) sub++; else { line++; sub = 0; }
    count++;
  }
  return forward ? count : -count;
}
