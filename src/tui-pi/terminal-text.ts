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
/** What a finished frame row may not contain. ESC and BEL stay: the app's own styling, links and cursor marker use them. */
const ROW_BREAKERS = /[\x00-\x06\x08\x0a-\x1a\x1c-\x1f\x7f]/g;

/** Multi-line display text: newlines survive, nothing else can move the cursor. */
export function displayText(text: string): string {
  return text
    .replace(ESCAPE_SEQUENCES, '')
    .replace(/\r\n?/g, '\n')
    // A terminal advances a tab to the next stop; pi-tui counts three cells. Spaces are the same in both.
    .replace(/\t/g, '    ')
    .replace(CONTROLS, '');
}

/** One-row display text for labels, previews and status segments. */
export function displayLine(text: string): string {
  return displayText(text).replace(/\s*\n\s*/g, ' ').trim();
}

/** Last line of defence for a rendered row that already carries the app's own styling. */
export function frameRow(line: string): string {
  return line.replace(/\t/g, ' ').replace(ROW_BREAKERS, '');
}
