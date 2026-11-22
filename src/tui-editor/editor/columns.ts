/**
 * Columns for the file editor: where the cursor may stand, and how wide what
 * it stands on is drawn.
 *
 * A buffer column is a UTF-16 offset into the line (what `slice` takes), but
 * the cursor only ever stands on a grapheme boundary: Left, Right, Backspace
 * and Delete step over a whole user-perceived character — an emoji with a
 * skin tone, a flag, a letter with its combining accent — never half of one.
 *
 * Width has one definition, used by the cursor maths in `buffer.ts` and by
 * the renderer in `text-editor.ts`: the cells pi-tui's `visibleWidth` gives
 * the line as the editor draws it — tabs advanced to the next stop, control
 * bytes shown as one-cell control pictures. If the two disagreed, Up and Down
 * would aim for a column the screen does not show.
 */
import { visibleWidth } from '@/tui-kit';

/** Cells between tab stops. */
export const TAB_WIDTH = 4;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The boundary before `col`: where Left and Backspace go. */
export function prevBoundary(text: string, col: number): number {
  if (col <= 0) return 0;
  const at = Math.min(col, text.length);
  return segmenter.segment(text).containing(at - 1)?.index ?? 0;
}

/** The boundary after `col`: where Right and Delete go. */
export function nextBoundary(text: string, col: number): number {
  if (col >= text.length) return text.length;
  const seg = segmenter.segment(text).containing(Math.max(0, col));
  return seg ? seg.index + seg.segment.length : text.length;
}

/** `col` itself when it is a boundary, otherwise the start of the grapheme it falls inside. */
export function snapToBoundary(text: string, col: number): number {
  if (col <= 0) return 0;
  if (col >= text.length) return text.length;
  return segmenter.segment(text).containing(col)?.index ?? col;
}

/** The graphemes of a line, with their UTF-16 offsets. */
export function graphemes(text: string): Array<{ index: number; segment: string }> {
  return Array.from(segmenter.segment(text), s => ({ index: s.index, segment: s.segment }));
}

/**
 * A control byte in a file (the `\r` of a stray CR, an ESC in a captured log)
 * is shown as its one-cell control picture. Written raw it would be obeyed by
 * the terminal: the cursor moves, later rows land in the wrong place and the
 * frame is corrupted until the next full repaint. A C1 control (U+0080 to
 * U+009F: NEL, CSI…) has no picture and is shown as U+FFFD; terminals obey
 * those too (U+009B starts an escape sequence like ESC [). One character maps
 * to one character, so buffer columns are unchanged.
 */
export function visibleControls(text: string): string {
  return text.replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, c => c === '\x7f' ? '\u2421' : c > '\x7f' ? '\ufffd' : String.fromCharCode(0x2400 + c.charCodeAt(0)));
}

/**
 * Text as the editor draws it, starting `startCell` cells into the line:
 * each tab advances to the next multiple of `TAB_WIDTH`, controls become
 * pictures. Drawing a line in pieces gives the same cells as drawing it whole
 * as long as each piece is given the cell it starts at.
 */
export function displayText(text: string, startCell = 0): string {
  if (!text.includes('\t')) return visibleControls(text);
  let out = '';
  let cell = startCell;
  for (const part of text.split(/(\t)/)) {
    if (part === '\t') {
      const pad = TAB_WIDTH - (cell % TAB_WIDTH);
      out += ' '.repeat(pad);
      cell += pad;
    } else if (part) {
      const shown = visibleControls(part);
      out += shown;
      cell += visibleWidth(shown);
    }
  }
  return out;
}

/** Cells taken by `text` drawn from `startCell`. */
export function cellWidth(text: string, startCell = 0): number {
  return visibleWidth(displayText(text, startCell));
}

/** The cell at which buffer column `col` of `line` is drawn. */
export function cellOf(line: string, col: number): number {
  return cellWidth(line.slice(0, col));
}

/**
 * The column whose grapheme covers `cell`, or the line's end when the line is
 * shorter. A wide character the cell falls inside is stood before, not split.
 */
export function colAtCell(line: string, cell: number): number {
  let at = 0;
  for (const { index, segment } of graphemes(line)) {
    const w = cellWidth(segment, at);
    if (at + w > cell) return index;
    at += w;
  }
  return line.length;
}
