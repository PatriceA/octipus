/**
 * Incremental find for the editor.
 *
 * Returns every match of `query` in the buffer's text as
 * `{ line, col, length }`. Supports plain substring (default,
 * case-insensitive) and regex mode (caller passes a flag).
 *
 * Both modes run as a regular expression over the original line, so match
 * columns are columns of the line itself (lower-casing a line can change its
 * length: `İ` becomes two code units).
 */
import type { Buffer } from './buffer';

export interface Match {
  line: number;
  col: number;
  length: number;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
  /** Match whole-words only. */
  wholeWord?: boolean;
}

/** Thrown for a regex-mode query that is not a valid expression. */
export class InvalidPatternError extends Error {}

/** The expression a query searches with. Throws `InvalidPatternError` for a bad regex. */
export function compileQuery(query: string, opts: SearchOptions = {}): RegExp {
  let source = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts.wholeWord) source = `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])`;
  try {
    return new RegExp(source, opts.caseSensitive ? 'gu' : 'giu');
  } catch (error) {
    throw new InvalidPatternError(error instanceof Error ? error.message : String(error));
  }
}

export function findAll(
  buf: Buffer,
  query: string,
  opts: SearchOptions = {},
): Match[] {
  if (!query) return [];
  return execAll(buf, compileQuery(query, opts)).map(({ line, match }) => ({ line, col: match.index, length: match[0].length }));
}

/** Every non-empty match of `re` (global) in the buffer, with its groups. */
function execAll(buf: Buffer, re: RegExp): Array<{ line: number; match: RegExpExecArray }> {
  const lines = buf.getLines();
  const out: Array<{ line: number; match: RegExpExecArray }> = [];
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lines[i])) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      out.push({ line: i, match: m });
    }
  }
  return out;
}

/**
 * Replace every match as one undo step. Returns the number of replacements.
 * In regex mode the replacement expands `$1`, `$<name>`, `$&` and `$$` the
 * way `String.prototype.replace` does; in plain mode it is literal.
 */
export function replaceAll(
  buf: Buffer,
  query: string,
  replacement: string,
  opts: SearchOptions = {},
): number {
  if (!query) return 0;
  const re = compileQuery(query, opts);
  const matches = execAll(buf, re);
  const sticky = new RegExp(re.source, re.flags.replace('g', '') + 'y');
  buf.transact(() => {
    // Apply in reverse so positions stay valid.
    for (let i = matches.length - 1; i >= 0; i--) {
      const { line, match } = matches[i];
      const end = match.index + match[0].length;
      buf.replaceRange({ line, col: match.index }, { line, col: end }, opts.regex ? expand(sticky, match.input, match.index, end, replacement) : replacement);
    }
  });
  return matches.length;
}

/**
 * What `match` would be replaced with: the replacement itself, or in regex
 * mode its expansion for that match (`$1` and the rest). Null when the text
 * at `match` no longer matches (the buffer changed).
 */
export function replacementFor(buf: Buffer, match: Match, query: string, replacement: string, opts: SearchOptions = {}): string | null {
  const re = compileQuery(query, opts);
  const sticky = new RegExp(re.source, re.flags.replace('g', '') + 'y');
  const line = buf.getLine(match.line);
  sticky.lastIndex = match.col;
  const found = sticky.exec(line);
  if (!found || found[0].length !== match.length) return null;
  return opts.regex ? expand(sticky, line, match.col, match.col + match.length, replacement) : replacement;
}

/** Replace one match, as one undo step. Returns whether it was replaced. */
export function replaceOne(buf: Buffer, match: Match, query: string, replacement: string, opts: SearchOptions = {}): boolean {
  const text = replacementFor(buf, match, query, replacement, opts);
  if (text === null) return false;
  buf.replaceRange({ line: match.line, col: match.col }, { line: match.line, col: match.col + match.length }, text);
  return true;
}

/** The replacement for the match at [start, end) of `line`, expanded in its own context (lookbehind included). */
function expand(sticky: RegExp, line: string, start: number, end: number, replacement: string): string {
  sticky.lastIndex = start;
  const replaced = line.replace(sticky, replacement);
  return replaced.slice(start, replaced.length - (line.length - end));
}
