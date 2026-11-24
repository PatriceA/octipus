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

import { TODO_MARKER_TAIL } from './note-todos';

/** The longest title taken from a first line; the rest of the line stays in the body only. */
export const TITLE_MAX = 120;

/** A leading `--- … ---` properties block (frontmatter), which is never the first line of text. */
const FRONTMATTER = /^﻿?---\n[\s\S]*?\n---(?:\n|$)/;

/** Markdown that opens a line: heading, quote, list or task markers. */
const LINE_MARKERS = /^(?:\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+(?:\[[ xX]\]\s+)?))+/;

/** The text of a line of markdown as it reads: markers, emphasis and link syntax dropped. */
function plainLine(line: string): string {
  return line
    // A line made a to-do ends in its marker (note-todos.ts): not part of what it reads.
    .replace(TODO_MARKER_TAIL, '')
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

/**
 * A task item from the start of its line: list marker (inside any quote),
 * then `[ ]` or `[x]` on the same line or, as CommonMark allows, at the
 * start of the next. Group 1 runs up to the box's inside.
 */
const TASK_ITEM = /^([ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])(?:[ \t]+|[ \t]*\n[ \t>]*)\[)([ xX])\]/;

/** Where the box's inside of the task item starting on the line of `offset` is, or -1. */
function taskBoxAt(body: string, offset: number): number {
  if (offset < 0 || offset > body.length) return -1;
  const start = body.lastIndexOf('\n', offset - 1) + 1;
  const match = TASK_ITEM.exec(body.slice(start, start + 400));
  return match ? start + match[1].length : -1;
}

/**
 * Tick (or untick) the task whose list item starts on the line holding
 * `offset`: its `[ ]` becomes `[x]` and back. `checked` sets the state
 * instead of flipping it. Null when that line starts no task, or the offset
 * is outside the text.
 */
export function toggleTaskAt(body: string, offset: number, checked?: boolean): string | null {
  const at = taskBoxAt(body, offset);
  if (at < 0) return null;
  const next = checked ?? body[at] === ' ';
  return `${body.slice(0, at)}${next ? 'x' : ' '}${body.slice(at + 1)}`;
}

/** The text of the line holding `offset`, its task box read as unticked (to recognise the task in a changed text). */
export function taskLineAt(body: string, offset: number): string | null {
  const at = taskBoxAt(body, offset);
  if (at < 0) return null;
  const start = body.lastIndexOf('\n', offset - 1) + 1;
  const end = body.indexOf('\n', at);
  return `${body.slice(start, at)} ${body.slice(at + 1, end === -1 ? body.length : end)}`;
}

/**
 * Tick the task the user saw: the item at `offset` of the text they were
 * shown, found in `body` (the text now, which may have changed since, as a
 * live note does). At the same offset when that line is still the same
 * task, else on the one line that is; null when there is no such line, or
 * more than one (nothing is ticked rather than the wrong task).
 */
export function toggleSeenTask(body: string, offset: number, seenLine: string, checked?: boolean): string | null {
  if (taskLineAt(body, offset) === seenLine) return toggleTaskAt(body, offset, checked);
  const starts: number[] = [];
  for (let i = 0; i <= body.length; i = body.indexOf('\n', i) + 1) {
    if (taskLineAt(body, i) === seenLine) starts.push(i);
    if (body.indexOf('\n', i) === -1) break;
  }
  return starts.length === 1 ? toggleTaskAt(body, starts[0], checked) : null;
}

/**
 * A note's text for a list row: the body without the line its title came
 * from (when it did), read as plain text, at most `width` characters. Reads
 * only as many lines as that takes.
 */
export function bodyPreview(body: string | undefined, title: string, width = 140): string {
  if (!body) return '';
  const text = body.replace(FRONTMATTER, '');
  const wanted = title.trim().toLowerCase();
  const parts: string[] = [];
  let length = 0;
  let first = true;
  for (let i = 0; i < text.length && length <= width;) {
    const nl = text.indexOf('\n', i);
    const end = nl === -1 ? text.length : nl;
    // A very long line is read in part: no more than the row can show.
    const plain = plainLine(text.slice(i, Math.min(end, i + width * 4)));
    i = end + 1;
    if (!plain) continue;
    if (first) {
      first = false;
      const line = plain.toLowerCase();
      // A long first line's title was cut (`noteTitleFrom`): it still is the title line.
      if (line === wanted || (wanted.endsWith('…') && line.startsWith(wanted.slice(0, -1)))) continue;
    }
    parts.push(plain);
    length += plain.length + 3;
  }
  const joined = parts.join(' · ');
  return joined.length > width ? `${joined.slice(0, width - 1).trimEnd()}…` : joined;
}
