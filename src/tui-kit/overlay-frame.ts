/**
 * The box an overlay is drawn in: a border around rows of text, with
 * optional separators between sections.
 *
 *   ┌──────────┐
 *   │ header   │
 *   ├──────────┤   ← between sections
 *   │ body     │
 *   └──────────┘
 *
 * Every row is the box's width: a body row is cut to the inside width
 * (`boxWidth - 4`, one space of padding on each side) and padded to it, so
 * the right border lines up whatever the row holds (styling, wide
 * characters). The overlays of the editor share this instead of each
 * drawing its own border and padding.
 */
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

/** Paints the border characters (a colour). */
export type Paint = (text: string) => string;

/** `text` padded with spaces to `width` cells; text already that wide is returned as it is. */
export function padToWidth(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return text;
  return text + ' '.repeat(width - w);
}

/** The cells inside a box `boxWidth` wide: the border and one space of padding on each side. */
export function innerWidth(boxWidth: number): number {
  return boxWidth - 4;
}

/**
 * A box just wide enough for its widest row, never wider than `available`.
 * `minInner` is the narrowest inside the box may be.
 */
export function fitBoxWidth(rows: readonly string[], available: number, minInner = 0): number {
  const widest = Math.max(minInner, ...rows.map(row => visibleWidth(row)));
  return Math.min(available, widest + 4);
}

/** One row inside the box. */
export function boxRow(text: string, boxWidth: number, border: Paint): string {
  const inner = innerWidth(boxWidth);
  return border('│ ') + padToWidth(truncateToWidth(text, inner), inner) + border(' │');
}

/** The rows of a box around `sections`, a separator between each two. */
export function drawBox(sections: ReadonlyArray<readonly string[]>, boxWidth: number, border: Paint): string[] {
  const rule = '─'.repeat(Math.max(0, boxWidth - 2));
  const out = [border(`┌${rule}┐`)];
  sections.forEach((rows, index) => {
    if (index > 0) out.push(border(`├${rule}┤`));
    for (const row of rows) out.push(boxRow(row, boxWidth, border));
  });
  out.push(border(`└${rule}┘`));
  return out;
}
