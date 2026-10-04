import { diff3Merge, diffPatch } from 'node-diff3';

/**
 * Three-way text merge for writers outside a live document
 * (docs/plans/coworking-spec.md §7.3).
 *
 * A writer read the note as `base` and wants it to be `next`; meanwhile the
 * live text moved on to `current`. `merge3` combines both changes, or says
 * the two touch the same text (a conflict — the write is refused as stale,
 * never applied over the other change). `textEdits` turns `current → merged`
 * into the few splices a `Y.Text` applies in one transaction, so the live
 * editors' text between the changes is never deleted and re-inserted.
 *
 * Merging runs on lines first (diff3 on 100 KiB of word tokens is quadratic
 * in the repeated whitespace tokens), then on words inside a conflicting
 * line region only, so two edits to different words of one paragraph still
 * merge. Every cut is at a line or whitespace boundary, or — for the final
 * splice trim — never between the two halves of a surrogate pair.
 */

export type MergeResult = { ok: true; text: string } | { ok: false };

/** A conflicting line region is merged word by word up to this many tokens; above it the write is stale. */
const MAX_TOKEN_REGION = 4000;

/** Lines with their `\n` kept, so joining them gives the text back exactly. */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

/** Newlines, whitespace runs and words, so joining them gives the text back exactly. */
function splitTokens(text: string): string[] {
  return text.match(/\n|[^\S\n]+|\S+/g) ?? [];
}

/** How many leading items all lists share. */
function commonPrefix(lists: string[][]): number {
  const min = Math.min(...lists.map((l) => l.length));
  let i = 0;
  while (i < min && lists.every((l) => l[i] === lists[0][i])) i++;
  return i;
}

/** How many trailing items all lists share, not reaching into the first `prefix` items. */
function commonSuffix(lists: string[][], prefix: number): number {
  const min = Math.min(...lists.map((l) => l.length)) - prefix;
  let i = 0;
  while (i < min && lists.every((l) => l[l.length - 1 - i] === lists[0][lists[0].length - 1 - i])) i++;
  return i;
}

/** diff3 over token lists; null on a conflict. */
function mergeLists(base: string[], current: string[], next: string[], refine: boolean): string[] | null {
  // The shared start and end are cut off before diff3 (it is quadratic in
  // the region), keeping one shared item on each side as an anchor: a
  // change touching the cut would otherwise look adjacent to a change
  // across it, a false conflict.
  const prefix = Math.max(0, commonPrefix([base, current, next]) - 1);
  const suffix = Math.max(0, commonSuffix([base, current, next], prefix) - 1);
  const mid = (l: string[]) => l.slice(prefix, l.length - suffix);
  const out: string[] = base.slice(0, prefix);
  for (const block of diff3Merge(mid(next), mid(base), mid(current), { excludeFalseConflicts: true })) {
    if (block.ok) {
      out.push(...block.ok);
      continue;
    }
    if (!refine || !block.conflict) return null;
    const { a, o, b } = block.conflict;
    const words = mergeWords(o.join(''), b.join(''), a.join(''));
    if (words === null) return null;
    out.push(words);
  }
  out.push(...base.slice(base.length - suffix));
  return out;
}

function mergeWords(base: string, current: string, next: string): string | null {
  const lists = [splitTokens(base), splitTokens(current), splitTokens(next)];
  if (lists.some((l) => l.length > MAX_TOKEN_REGION)) return null;
  const merged = mergeLists(lists[0], lists[1], lists[2], false);
  return merged === null ? null : merged.join('');
}

/** Merge the change `base → next` into `current`. */
export function merge3(base: string, current: string, next: string): MergeResult {
  if (next === base || next === current) return { ok: true, text: current };
  if (current === base) return { ok: true, text: next };
  const merged = mergeLists(splitLines(base), splitLines(current), splitLines(next), true);
  return merged === null ? { ok: false } : { ok: true, text: merged.join('') };
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** One splice of a text: at UTF-16 offset `index`, delete `remove` code units, insert `insert`. */
export interface TextEdit {
  index: number;
  remove: number;
  insert: string;
}

/**
 * Trim the common start and end of `a` and `b` to the changed middle,
 * never cutting a surrogate pair in half.
 */
function trimSplice(a: string, b: string, offset: number): TextEdit | null {
  if (a === b) return null;
  const max = Math.min(a.length, b.length);
  let start = 0;
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  if (start > 0 && isHighSurrogate(a.charCodeAt(start - 1))) start--;
  let end = 0;
  while (end < max - start && a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)) end++;
  if (end > 0 && isLowSurrogate(a.charCodeAt(a.length - end))) end--;
  return { index: offset + start, remove: a.length - start - end, insert: b.slice(start, b.length - end) };
}

/**
 * The splices turning `current` into `target`, in ascending order of
 * `index` (offsets into `current`). Apply them from the last to the first.
 */
export function textEdits(current: string, target: string): TextEdit[] {
  if (current === target) return [];
  const a = splitLines(current);
  const b = splitLines(target);
  const prefix = commonPrefix([a, b]);
  const suffix = commonSuffix([a, b], prefix);
  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);
  let offset = a.slice(0, prefix).join('').length;
  const edits: TextEdit[] = [];
  let consumed = 0;
  for (const hunk of diffPatch(aMid, bMid)) {
    // Skip the unchanged lines before this hunk.
    offset += aMid.slice(consumed, hunk.buffer1.offset).join('').length;
    const removed = hunk.buffer1.chunk.join('');
    const edit = trimSplice(removed, hunk.buffer2.chunk.join(''), offset);
    if (edit) edits.push(edit);
    offset += removed.length;
    consumed = hunk.buffer1.offset + hunk.buffer1.length;
  }
  return edits;
}

/** Apply `textEdits` output to a plain string (tests, and the closed-note path). */
export function applyEdits(text: string, edits: TextEdit[]): string {
  let out = text;
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    out = out.slice(0, e.index) + e.insert + out.slice(e.index + e.remove);
  }
  return out;
}
