/**
 * Incremental find for the editor.
 *
 * Returns every match of `query` in the buffer's text as
 * `{ line, col, length }`. Supports plain substring (default,
 * case-insensitive) and regex mode (caller passes a flag).
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
  /** Match whole-words only (substring mode only). */
  wholeWord?: boolean;
}

export function findAll(
  buf: Buffer,
  query: string,
  opts: SearchOptions = {},
): Match[] {
  if (!query) return [];
  const lines = buf.getLines();
  const out: Match[] = [];
  if (opts.regex) {
    let re: RegExp;
    try { re = new RegExp(query, opts.caseSensitive ? 'g' : 'gi'); }
    catch { return []; }
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(lines[i])) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        out.push({ line: i, col: m.index, length: m[0].length });
      }
    }
    return out;
  }

  const needle = opts.caseSensitive ? query : query.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const hay = opts.caseSensitive ? lines[i] : lines[i].toLowerCase();
    let from = 0;
    while (from <= hay.length) {
      const at = hay.indexOf(needle, from);
      if (at === -1) break;
      if (opts.wholeWord) {
        const before = at === 0 ? ' ' : hay[at - 1];
        const after = at + needle.length >= hay.length ? ' ' : hay[at + needle.length];
        if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) {
          from = at + 1;
          continue;
        }
      }
      out.push({ line: i, col: at, length: needle.length });
      from = at + needle.length;
    }
  }
  return out;
}

/** Replace every match. Returns the number of replacements. */
export function replaceAll(
  buf: Buffer,
  query: string,
  replacement: string,
  opts: SearchOptions = {},
): number {
  const matches = findAll(buf, query, opts);
  // Apply in reverse so positions stay valid.
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    buf.replaceRange({ line: m.line, col: m.col }, { line: m.line, col: m.col + m.length }, replacement);
  }
  return matches.length;
}
