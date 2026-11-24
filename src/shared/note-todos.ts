/**
 * The task lines of a note that stand for a to-do (pure functions, shared by
 * the server, the web notepad and the agent tools; docs/API.md "Note ↔ to-do
 * links").
 *
 * A task line made into a to-do carries a marker at its end:
 *
 *     - [ ] Call the dentist ^todo-k3x9qa2b
 *
 * The marker names the link (`task_note_links.anchor`), never the to-do: it
 * is a random token, so the text of a note says nothing about a to-do to
 * someone who can read the note but not the to-do. It follows the line
 * wherever the line goes in the note (moved, re-indented, edited); a copy
 * pasted into another note means nothing there (the link is per note). The
 * editors draw it as a chip and keep it out of titles and previews.
 */

/** A note as a to-do shows it (`linkedNotes` on a task): enough to name and open it. */
export interface LinkedNote {
  id: string;
  title: string;
  slug: string;
  noteKind: string;
  noteDate: string | null;
  archived: boolean;
  /** Set when the to-do was made from a line of this note. */
  anchor: string | null;
}

/** A to-do as a note shows it (`linkedTasks` on a note). Dates are ISO strings over the API. */
export interface LinkedTask<D = string> {
  id: string;
  title: string;
  status: string;
  dueAt: D | null;
  completedAt: D | null;
  repeating: boolean;
  /** Set when the to-do was made from a line of this note: the line's marker. */
  anchor: string | null;
}

/** A link's anchor: lowercase letters and digits. */
export const TODO_ANCHOR = /^[a-z0-9]{6,16}$/;

/** The marker at the end of a line (with the space before it): group 1 is the anchor. */
export const TODO_MARKER_TAIL = /[ \t]+\^todo-([a-z0-9]{6,16})[ \t]*$/;

/** A task item on one line: group 1 runs up to the box's inside, 2 is the box's inside, 3 the text after the box. */
const TASK_LINE = /^([ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])\](.*)$/;

/** A list item without a box (`- `, `1. `, inside any quote): group 1 is the marker, 2 the text. */
const LIST_LINE = /^([ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+)(.*)$/;

const FENCE = /^[ \t]*(```|~~~)/;

/** The longest to-do title a line gives (the API's limit). */
export const TODO_TITLE_MAX = 500;

/** A new anchor: 8 random letters and digits. */
export function newTodoAnchor(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

/** One `- [ ]` line of a note. Offsets are in the body; `to` is the end of the line (before its `\n`). */
export interface NoteTaskLine {
  /** 0-based line number. */
  line: number;
  from: number;
  to: number;
  /** Where the box's inside (` ` or `x`) is. */
  box: number;
  checked: boolean;
  /** The text after the box, without the marker. */
  text: string;
  /** The link's anchor when the line carries a marker. */
  anchor: string | null;
}

/** Every line of `body` with its offsets, fenced code left out. */
function linesOf(body: string): Array<{ line: number; from: number; text: string }> {
  const out: Array<{ line: number; from: number; text: string }> = [];
  let fence: string | null = null;
  let from = 0;
  const lines = body.split('\n');
  lines.forEach((text, line) => {
    const open = FENCE.exec(text);
    if (fence) {
      if (open && open[1] === fence) fence = null;
    } else if (open) {
      fence = open[1];
    } else {
      out.push({ line, from, text });
    }
    from += text.length + 1;
  });
  return out;
}

/** The task lines of a note, in order (none inside fenced code). */
export function noteTaskLines(body: string): NoteTaskLine[] {
  const out: NoteTaskLine[] = [];
  for (const { line, from, text } of linesOf(body)) {
    const m = TASK_LINE.exec(text);
    if (!m) continue;
    const tail = TODO_MARKER_TAIL.exec(m[3]);
    out.push({
      line,
      from,
      to: from + text.length,
      box: from + m[1].length,
      checked: m[2] !== ' ',
      text: (tail ? m[3].slice(0, tail.index) : m[3]).trim(),
      anchor: tail ? tail[1] : null,
    });
  }
  return out;
}

/**
 * Whether each anchored line is ticked. An anchor on two lines (a line
 * duplicated) counts once, by its first line.
 */
export function anchorStates(body: string): Map<string, boolean> {
  const states = new Map<string, boolean>();
  for (const t of noteTaskLines(body)) {
    if (t.anchor && !states.has(t.anchor)) states.set(t.anchor, t.checked);
  }
  return states;
}

/**
 * The anchored lines whose tick changed from `before` to `after`: what a
 * save of the note did to its to-dos. A marker that only appears (a line
 * just made a to-do) or only disappears (a line deleted) changes nothing.
 */
export function changedAnchors(before: string, after: string): Array<{ anchor: string; checked: boolean }> {
  const was = anchorStates(before);
  const out: Array<{ anchor: string; checked: boolean }> = [];
  for (const [anchor, checked] of anchorStates(after)) {
    const prior = was.get(anchor);
    if (prior !== undefined && prior !== checked) out.push({ anchor, checked });
  }
  return out;
}

/**
 * Tick or untick the line carrying `anchor` (its first, should a copy of it
 * still be in the text: the one `anchorStates` reads). Null when no line
 * carries it or it already reads `checked` (nothing to write).
 */
export function setAnchoredChecked(body: string, anchor: string, checked: boolean): string | null {
  const t = noteTaskLines(body).find((l) => l.anchor === anchor);
  if (!t || t.checked === checked) return null;
  return `${body.slice(0, t.box)}${checked ? 'x' : ' '}${body.slice(t.box + 1)}`;
}

/**
 * Every marker in the text names exactly one line and one link: a marker
 * whose anchor is not in `linked` (a line copied from another note, a link
 * removed with its to-do) and any copy of a marker after its first line (a
 * pasted or duplicated line) is taken off its line, which stays a plain task
 * line. Returns the text unchanged (the same string) when nothing is taken.
 */
export function normalizeMarkers(body: string, linked: ReadonlySet<string>): string {
  if (!body.includes('^todo-')) return body;
  const seen = new Set<string>();
  const drop: NoteTaskLine[] = [];
  for (const t of noteTaskLines(body)) {
    if (!t.anchor) continue;
    if (!linked.has(t.anchor) || seen.has(t.anchor)) drop.push(t);
    else seen.add(t.anchor);
  }
  if (drop.length === 0) return body;
  let next = body;
  for (const t of drop.reverse()) {
    const line = next.slice(t.from, t.to);
    next = `${next.slice(0, t.from)}${line.replace(TODO_MARKER_TAIL, '')}${next.slice(t.to)}`;
  }
  return next;
}

/**
 * Mark line `line` (0-based) as the to-do `anchor`. A task line gets the
 * marker at its end; a list item or a plain line becomes an unticked task
 * line first. Null when the line is empty, in fenced code, a heading, or
 * already marked.
 */
export function anchorLine(body: string, line: number, anchor: string): string | null {
  if (!TODO_ANCHOR.test(anchor)) throw new Error('Not a to-do anchor');
  const entry = linesOf(body).find((l) => l.line === line);
  if (!entry || !entry.text.trim() || /^[ \t]*#{1,6}[ \t]/.test(entry.text) || TODO_MARKER_TAIL.test(entry.text)) return null;
  let text = entry.text.replace(/[ \t]+$/, '');
  if (!TASK_LINE.test(text)) {
    const item = LIST_LINE.exec(entry.text);
    if (item) {
      if (!item[2].trim()) return null;
      text = `${item[1]}[ ] ${item[2].trimEnd()}`;
    } else {
      const indent = /^[ \t]*/.exec(text)?.[0] ?? '';
      text = `${indent}- [ ] ${text.slice(indent.length)}`;
    }
  }
  const end = entry.from + entry.text.length;
  return `${body.slice(0, entry.from)}${text} ^todo-${anchor}${body.slice(end)}`;
}

/**
 * The to-do title a line reads as: its text without list and task markers,
 * the marker, emphasis and link syntax; whitespace collapsed; at most
 * `TODO_TITLE_MAX` characters. Empty when nothing is left.
 */
export function todoTitleFromLine(text: string): string {
  const plain = text
    .replace(TODO_MARKER_TAIL, '')
    .replace(/^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]*)?/, '')
    .replace(/^[ \t]*#{1,6}[ \t]+/, '')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > TODO_TITLE_MAX ? `${plain.slice(0, TODO_TITLE_MAX - 1).trimEnd()}…` : plain;
}

/** The 0-based line holding `offset`. */
export function lineAt(body: string, offset: number): number {
  let line = 0;
  for (let i = body.indexOf('\n'); i !== -1 && i < offset; i = body.indexOf('\n', i + 1)) line++;
  return line;
}
