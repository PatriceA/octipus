/**
 * Putting data into HTML that the server or the web app builds as a string.
 */

/**
 * A value as a JavaScript literal to place inside a `<script>` element. Plain
 * `JSON.stringify` is not enough there: a string holding `</script>` ends the
 * element, and U+2028/2029 end a line in older engines.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\' + 'u003c')
    .replace(LINE_SEPARATOR_RE, '\\' + 'u2028')
    .replace(PARAGRAPH_SEPARATOR_RE, '\\' + 'u2029');
}
const LINE_SEPARATOR_RE = new RegExp(String.fromCharCode(0x2028), 'g');
const PARAGRAPH_SEPARATOR_RE = new RegExp(String.fromCharCode(0x2029), 'g');

/** Text for an HTML text node or a quoted attribute value. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
