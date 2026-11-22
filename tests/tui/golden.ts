/**
 * Golden screens: the visible frame as text plus a style map, compared with a
 * committed file under `tests/tui/goldens/`.
 *
 *   UPDATE_TUI_GOLDENS=1 npx vitest run tests/tui/golden.e2e.test.ts
 *
 * rewrites the files; review the diff like any other change. A mismatch fails
 * with the rows that differ, expected above actual, and the style legend.
 *
 * The style map has one letter per cell (two for a wide character, so it lines
 * up with the text in a monospace view): the same letter is the same
 * foreground, background and attributes. Letters are given in order of first
 * appearance, so a change of colour shows as a changed letter at the cells
 * that moved, and the legend below says what each letter is.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { IBufferCell as Cell } from '@xterm/headless';
import type { TuiHarness } from './harness';

const DIR = resolve('tests/tui/goldens');
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
/** pi-tui and the chat's braille spinner frames: which frame is up depends on the clock. */
const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g;

function colour(kind: 'fg' | 'bg', cell: Cell): string {
  const rgb = kind === 'fg' ? cell.isFgRGB() : cell.isBgRGB();
  const palette = kind === 'fg' ? cell.isFgPalette() : cell.isBgPalette();
  const value = kind === 'fg' ? cell.getFgColor() : cell.getBgColor();
  if (rgb) return `#${value.toString(16).padStart(6, '0')}`;
  if (palette) return `p${value}`;
  return 'default';
}

function styleKey(cell: Cell): string {
  const flags = [
    cell.isBold() && 'bold', cell.isDim() && 'dim', cell.isItalic() && 'italic', cell.isUnderline() && 'underline',
    cell.isInverse() && 'inverse', cell.isStrikethrough() && 'strike',
  ].filter(Boolean);
  return [`fg ${colour('fg', cell)}`, `bg ${colour('bg', cell)}`, ...flags].join(' ');
}

export interface Frame { text: string[]; styles: string[]; legend: string[] }

/**
 * The frame on screen now, with `mask` applied to the text. Styles are read
 * from the cells as drawn; on a row the mask changed, each run of one style is
 * recorded as a single letter, since the masked text no longer lines up with
 * the cells (a duration can be 9ms or 31ms).
 */
export async function captureFrame(h: TuiHarness, mask: (row: string) => string = row => row): Promise<Frame> {
  await h.text();
  const b = h.screen.buffer.active;
  const legend = new Map<string, string>();
  const text: string[] = [];
  const styles: string[] = [];
  for (let row = 0; row < h.screen.rows; row++) {
    const line = b.getLine(b.viewportY + row);
    const drawn = (line?.translateToString(true) ?? '').replace(SPINNER, '⠿');
    const masked = mask(drawn);
    text.push(masked.trimEnd());
    let map = '';
    for (let col = 0; col < h.screen.cols; col++) {
      const cell = line?.getCell(col);
      if (!cell || cell.getWidth() === 0) continue;
      const key = styleKey(cell);
      let letter = legend.get(key);
      if (!letter) {
        letter = LETTERS[legend.size] ?? '?';
        legend.set(key, letter);
      }
      map += letter.repeat(cell.getWidth());
    }
    // A run of default-style blanks at the end of a row says nothing.
    const plain = legend.get('fg default bg default') ?? '';
    const trimmed = plain ? map.replace(new RegExp(`${plain}+$`), '') : map;
    styles.push(masked === drawn ? trimmed : trimmed.replace(/(.)\1+/g, '$1'));
  }
  return { text, styles, legend: [...legend].map(([key, letter]) => `${letter} = ${key}`) };
}

/** Waits until two captures 150 ms apart are the same: the frame has stopped changing. */
export async function settledFrame(h: TuiHarness, mask?: (row: string) => string): Promise<Frame> {
  let previous = serialize(await captureFrame(h, mask));
  const start = Date.now();
  while (Date.now() - start < 5000) {
    await new Promise(done => setTimeout(done, 150));
    const frame = await captureFrame(h, mask);
    const now = serialize(frame);
    if (now === previous) return frame;
    previous = now;
  }
  throw new Error(`The screen did not settle within 5 s:\n${previous}`);
}

function serialize(frame: Frame): string {
  const number = (rows: string[]) => rows.map((row, n) => `${String(n).padStart(2, '0')}|${row}`);
  return [...number(frame.text), '', '--- styles', ...number(frame.styles), '', '--- legend', ...frame.legend, ''].join('\n');
}

/** Rows that differ between two serialized frames, expected then actual. */
function rowDiff(expected: string, actual: string): string {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const out: string[] = [];
  for (let n = 0; n < Math.max(a.length, b.length); n++) {
    if (a[n] === b[n]) continue;
    out.push(`- ${a[n] ?? '(no line)'}`, `+ ${b[n] ?? '(no line)'}`);
  }
  return out.join('\n');
}

/** Compares `frame` with `goldens/<name>.txt`, or writes that file instead under `UPDATE_TUI_GOLDENS=1`. */
export function expectGolden(name: string, frame: Frame): void {
  const path = join(DIR, `${name}.txt`);
  const shown = `tests/tui/goldens/${name}.txt`;
  const actual = serialize(frame);
  if (process.env.UPDATE_TUI_GOLDENS === '1') {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  if (!existsSync(path)) {
    throw new Error(`No golden screen for "${name}" (${shown}). Create it with UPDATE_TUI_GOLDENS=1 and review it.\n\n${actual}`);
  }
  const expected = readFileSync(path, 'utf8');
  if (expected === actual) return;
  throw new Error(
    `Screen "${name}" differs from ${shown}. Rows below as "- golden" then "+ now"; `
    + `if the change is intended, rerun with UPDATE_TUI_GOLDENS=1 and commit the file.\n\n${rowDiff(expected, actual)}\n\n--- legend now\n${frame.legend.join('\n')}`,
  );
}
