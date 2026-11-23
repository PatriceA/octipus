/**
 * Plain-text helpers for a note's markdown, shared by the web notepad and
 * anything else that shows a note (pure functions, no DOM).
 *
 *   - `noteTitleFrom`: the title a note gets from its first line, so a new
 *     note needs no title field (and an existing note whose title is its
 *     first line keeps following it).
 *   - `toggleTaskAt`: tick or untick the `- [ ]` task on a line, for the
 *     checkboxes the editor and the reading view draw.
 *   - `bodyPreview`: a note's text for a list row, without its title line.
 */

/** The longest title taken from a first line; the rest of the line stays in the body only. */
export const TITLE_MAX = 120;

/** A leading `--- … ---` properties block (frontmatter), which is never the first line of text. */
const FRONTMATTER = /^﻿?---\n[\s\S]*?\n---(?:\n|$)/;

/** Markdown that opens a line: heading, quote, list or task markers. */
const LINE_MARKERS = /^(?:\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+(?:\[[ xX]\]\s+)?))+/;

/** The text of a line of markdown as it reads: markers, emphasis and link syntax dropped. */
function plainLine(line: string): string {
  return line
    .replace(LINE_MARKERS, '')
    // [[target|shown]] and [[target]] read as their shown text.
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    // [text](url) and ![alt](url) read as their text.
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The title a note takes from its text: its first line that has any (after
 * a properties block), read as plain text and cut at `TITLE_MAX`
 * characters. Empty when the note has no text yet.
 */
export function noteTitleFrom(body: string): string {
  const text = body.replace(FRONTMATTER, '');
  for (const line of text.split('\n')) {
    const plain = plainLine(line);
    if (plain) return plain.length > TITLE_MAX ? `${plain.slice(0, TITLE_MAX - 1).trimEnd()}…` : plain;
  }
  return '';
}

/** A task line: list marker, then `[ ]` or `[x]`. Group 1 runs up to the box's inside. */
const TASK_LINE = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/;

/**
 * Tick (or untick) the task on the line holding `offset`: its `[ ]` becomes
 * `[x]` and back. `checked` sets the state instead of flipping it. Null when
 * that line is not a task, or the offset is outside the text.
 */
export function toggleTaskAt(body: string, offset: number, checked?: boolean): string | null {
  if (offset < 0 || offset > body.length) return null;
  const start = body.lastIndexOf('\n', offset - 1) + 1;
  const end = body.indexOf('\n', start);
  const line = body.slice(start, end === -1 ? body.length : end);
  const match = TASK_LINE.exec(line);
  if (!match) return null;
  const next = checked ?? match[2] === ' ';
  const at = start + match[1].length;
  return `${body.slice(0, at)}${next ? 'x' : ' '}${body.slice(at + 1)}`;
}

/**
 * A note's text for a list row: the body without the line its title came
 * from (when it did), read as plain text, at most `width` characters.
 */
export function bodyPreview(body: string | undefined, title: string, width = 140): string {
  if (!body) return '';
  const lines = body.replace(FRONTMATTER, '').split('\n');
  const first = lines.findIndex((line) => plainLine(line) !== '');
  const rest = first >= 0 && plainLine(lines[first]).toLowerCase() === title.trim().toLowerCase() ? lines.slice(first + 1) : lines;
  const text = rest.map(plainLine).filter(Boolean).join(' · ');
  return text.length > width ? `${text.slice(0, width - 1).trimEnd()}…` : text;
}
