/**
 * Text from outside the TUI (model output, tool arguments, tool results,
 * server strings) on its way to the screen.
 *
 * pi-tui paints rows with relative cursor movement and trusts every rendered
 * row to occupy exactly one terminal row. A row that carries a newline, a
 * carriage return, a tab or an escape sequence breaks that: the cursor ends up
 * somewhere pi-tui does not know about, later rows are painted one row low,
 * and the bottom of the frame — the composer — scrolls out of the window. It
 * stays out until something forces a full repaint (a resize, the end of the
 * turn). A tool call whose shell command spans two lines was enough.
 *
 * It is also a matter of trust: a tool result containing `ESC [ 2 J` must not
 * be able to clear the user's terminal.
 */

/** CSI, OSC, DCS/SOS/PM/APC strings, two-byte escapes, and a stray ESC. */
const ESCAPE_SEQUENCES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -/]*[0-~])?/g;
/** C0 without tab and newline, DEL, and the C1 block. */
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
/**
 * Invisible format characters — variation selectors, soft hyphen, bidi marks
 * and isolates, fillers, tags. pi-tui counts them as no cells; terminals often
 * draw one (a lone VS16, a soft hyphen, an isolate), and a row they widen
 * wraps. ZWJ and ZWNJ shape scripts and stay, except ZWJ inside emoji.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}--[\u200c\u200d]]/gv;
/**
 * Emoji joined into one glyph — a ZWJ sequence, a skin-tone modifier. pi-tui
 * counts the cluster as two cells; a terminal without grapheme clustering
 * (xterm, VTE, tmux) draws every piece, two cells each. Unjoined, the pieces
 * measure the same in both.
 */
const EMOJI_JOINERS = /(?<=\p{Extended_Pictographic})(?:\u200d|\p{Emoji_Modifier})|\u200d(?=\p{Extended_Pictographic})/gu;
/**
 * A combining mark with nothing to combine with — at the start of a line, or
 * left behind when the escape sequence before it was removed. pi-tui counts
 * it as no cells; a terminal draws it in a cell of its own, and xterm.js does
 * so after any styling sequence, which every component puts at a row start.
 * Unicode's convention for showing a mark alone is to put it on a space.
 */
const ORPHAN_MARKS = /(^|\n)(\p{M}+)/gu;
/**
 * Half of a surrogate pair, left when UTF-16 text was cut by length — the
 * adapter's 80-character previews do that to an emoji. pi-tui counts it as
 * no cells; the terminal draws a replacement character in one.
 */
const LONE_SURROGATES = /\p{Surrogate}/gu;
/** What a finished frame row may not contain. ESC and BEL stay: the app's own styling, links and cursor marker use them. */
const ROW_BREAKERS = /[\x00-\x06\x08\x0a-\x1a\x1c-\x1f\x7f]/g;

/** Multi-line display text: newlines survive, nothing else can move the cursor. */
export function displayText(text: string): string {
  return text
    .replace(ESCAPE_SEQUENCES, '')
    .replace(/\r\n?/g, '\n')
    // A terminal advances a tab to the next stop; pi-tui counts three cells. Spaces are the same in both.
    .replace(/\t/g, '    ')
    .replace(CONTROLS, '')
    // Widths: what pi-tui measures is what the terminal draws (terminal-text.width.test.ts).
    .replace(LONE_SURROGATES, '\ufffd')
    .replace(INVISIBLE, '')
    .replace(EMOJI_JOINERS, '')
    .replace(ORPHAN_MARKS, '$1\u00a0$2');
}

/** One-row display text for labels, previews and status segments. */
export function displayLine(text: string): string {
  // Trimming can take the no-break space a leading mark was given; give it back.
  return displayText(text).replace(/\s*\n\s*/g, ' ').trim().replace(ORPHAN_MARKS, '$1\u00a0$2');
}

/** Last line of defence for a rendered row that already carries the app's own styling. */
export function frameRow(line: string): string {
  return line.replace(/\t/g, ' ').replace(ROW_BREAKERS, '');
}
