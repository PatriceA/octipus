/**
 * Memory-redesign Phase C — structural chunker for Markdown.
 *
 * Walks a Markdown document and emits one chunk per *section* — the
 * heading line glued to its own body text — threading the section path
 * so the embedder can write `parent_chunk_id` / `section_path` /
 * `heading_level`.
 *
 * Why heading+body, not heading-alone (2026-06-18)
 * ────────────────────────────────────────────────
 * The original chunker emitted the heading as its own chunk separate
 * from the body. On real docs that produced a flood of useless rows
 * whose entire content was a single header line ("### Schedule Types")
 * — they embed to noise, clutter the KB UI, and each one still paid for
 * an L0 abstract call. We now fold the heading into the body chunk it
 * introduces. A heading with NO direct body (only sub-headings, or a
 * trailing leaf with nothing under it) emits NO chunk at all — its
 * title still reaches retrieval via the `sectionPath` of its
 * descendants, so nothing searchable is lost.
 *
 * Why a chunker module (not inline in EmbeddingService)
 * ─────────────────────────────────────────────────────
 * The flat 1000-char chunker is still the right call for `code` and
 * `message` purposes — those have no structural signal. Keeping the
 * structural extractor separate lets `indexText` pick the right one
 * by content shape without growing into a god-method, and lets the
 * structural logic stay testable in isolation.
 *
 * Output contract
 * ───────────────
 *   StructuralChunk = {
 *     content:        string  — the chunk text (heading line + body for
 *                               a section; bare prose for preamble /
 *                               soft-split overflow pieces)
 *     headingLevel:   number  — 0=body/overflow, 1=H1, 2=H2, …
 *     sectionPath:    string[] — ancestor headings, root → self
 *                                (self INCLUDED for a section chunk)
 *     parentIndex:    number | null — index into the same array
 *                                     pointing at the nearest enclosing
 *                                     emitted section, or null for a
 *                                     top-level chunk
 *   }
 *
 * Callers materialise the chunks into the embeddings table in array
 * order; `parentIndex` is then translated into `parent_chunk_id` by
 * looking up the previously-inserted row id (the chunker doesn't
 * know UUIDs).
 *
 * What it does NOT handle
 * ───────────────────────
 *   - Setext-style headings (=== / ---). ATX (`#`-prefixed) only.
 *     Setext is rare in machine-generated docs; falling back to the
 *     flat chunker for those is acceptable for Phase C.
 *   - Code-fence-aware splitting beyond "don't split inside ```".
 *     A 5000-char fenced block becomes one chunk even if it busts
 *     the soft size limit — splitting code mid-block is worse than
 *     a long chunk.
 *   - PDF / docx structure. That ships when the document processor
 *     learns to emit a normalised heading tree from those formats.
 */

export interface StructuralChunk {
  content: string;
  headingLevel: number;
  sectionPath: string[];
  parentIndex: number | null;
}

/** The most characters of a chunk, its heading line included. */
export const SOFT_MAX_CHARS = 1000;

export function chunkMarkdown(markdown: string): StructuralChunk[] {
  const chunks: StructuralChunk[] = [];
  // Open heading scope. `emittedIndex` is the chunk index this section
  // produced, or null while it has no body yet (so descendants skip it
  // when hunting for a real parent). We pop entries whose level >=
  // incoming heading level to find the new parent.
  const stack: Array<{
    level: number;
    title: string;
    path: string[];
    emittedIndex: number | null;
  }> = [];

  const lines = markdown.split(/\r?\n/);
  let i = 0;
  let bodyBuf = '';

  // Finalise the body accumulated for the current top-of-stack section
  // (or the pre-heading preamble when the stack is empty). A section
  // with no body emits nothing — its title still rides along on its
  // descendants' sectionPath.
  const flushSection = () => {
    const trimmed = bodyBuf.trim();
    bodyBuf = '';
    const cur = stack[stack.length - 1];

    if (!cur) {
      // Preamble: prose before the first heading. No heading to glue on.
      if (!trimmed) return;
      for (const piece of softSplit(trimmed)) {
        chunks.push({ content: piece, headingLevel: 0, sectionPath: [], parentIndex: null });
      }
      return;
    }

    if (!trimmed) return; // heading-only section — drop it (no orphan header chunk)

    // Nearest ancestor that actually emitted a chunk becomes the parent.
    let parentIndex: number | null = null;
    for (let k = stack.length - 2; k >= 0; k--) {
      if (stack[k].emittedIndex !== null) {
        parentIndex = stack[k].emittedIndex;
        break;
      }
    }

    // Soft-split if the body busts the chunk size. The heading line is
    // glued to the FIRST piece (the section node); overflow pieces nest
    // under it as plain body so retrieval still finds the heading.
    const headingLine = `${'#'.repeat(cur.level)} ${cur.title}`;
    // The first piece carries the heading line, so it leaves room for it.
    const pieces = softSplit(trimmed, Math.max(SOFT_MAX_CHARS / 2, SOFT_MAX_CHARS - headingLine.length - 2));
    const firstIndex = chunks.length;
    chunks.push({
      content: `${headingLine}\n\n${pieces[0]}`,
      headingLevel: cur.level,
      sectionPath: cur.path,
      parentIndex,
    });
    cur.emittedIndex = firstIndex;
    for (let p = 1; p < pieces.length; p++) {
      chunks.push({ content: pieces[p], headingLevel: 0, sectionPath: cur.path, parentIndex: firstIndex });
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Code fence — pass through verbatim into the body buffer, never
    // split inside a fence.
    const fence = line.match(/^\s*```/);
    if (fence) {
      bodyBuf += (bodyBuf ? '\n' : '') + line;
      i++;
      while (i < lines.length) {
        bodyBuf += '\n' + lines[i];
        if (/^\s*```/.test(lines[i])) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushSection();
      const level = heading[1].length;
      const title = heading[2].trim();
      // Pop the heading stack until we find a strictly-higher (lower
      // level number) parent.
      while (stack.length && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      const parent = stack[stack.length - 1];
      const newPath = [...(parent ? parent.path : []), title];
      stack.push({ level, title, path: newPath, emittedIndex: null });
      i++;
      continue;
    }

    bodyBuf += (bodyBuf ? '\n' : '') + line;
    i++;
  }
  flushSection();

  return chunks;
}

function softSplit(text: string, firstMax = SOFT_MAX_CHARS): string[] {
  return splitParagraphs(text, SOFT_MAX_CHARS, firstMax);
}

/**
 * `text` in pieces of at most `max` characters (the first at most
 * `firstMax`), whole paragraphs together where they fit. A paragraph longer
 * than a piece (extracted PDF text, a pasted log: no blank line in
 * thousands of characters) is split at sentence ends, then at whitespace,
 * then anywhere: it used to stay one chunk of any length, which an embedding
 * model truncates and a search returns whole.
 */
export function splitParagraphs(text: string, max: number, firstMax = max): string[] {
  const out: string[] = [];
  const limit = () => (out.length === 0 ? firstMax : max);
  let current = '';
  const pushCurrent = () => {
    if (current.trim()) out.push(current.trim());
    current = '';
  };
  for (const para of text.split(/\n\n+/)) {
    if (current.length > 0 && current.length + para.length + 2 > limit()) pushCurrent();
    if (para.length <= limit()) {
      current += (current ? '\n\n' : '') + para;
      continue;
    }
    pushCurrent();
    for (const piece of splitLong(para, max, limit())) {
      if (current) pushCurrent();
      current = piece;
    }
  }
  pushCurrent();
  return out;
}

/** One paragraph longer than `max` in pieces of at most `max` (the first at most `firstMax`): at sentence ends, then whitespace, then anywhere. */
function splitLong(para: string, max: number, firstMax: number): string[] {
  const out: string[] = [];
  let rest = para.trim();
  while (rest.length > (out.length === 0 ? firstMax : max)) {
    const room = out.length === 0 ? firstMax : max;
    const window = rest.slice(0, room + 1);
    const sentence = Math.max(...['. ', '? ', '! ', '; ', '\n'].map((m) => window.lastIndexOf(m, room - 1)));
    const space = window.lastIndexOf(' ', room);
    const cut = sentence > room * 0.5 ? sentence + 1 : space > room * 0.5 ? space : room;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Heuristic for whether the structural chunker is the right tool. We
 * only use it on content that looks like Markdown (or that the caller
 * has told us is Markdown via a file extension hint). Untyped text
 * keeps using the flat chunker — splitting prose by headings that
 * don't exist would just degenerate into one huge chunk.
 */
export function looksLikeMarkdown(text: string, filePath?: string): boolean {
  if (filePath && /\.(md|markdown|mdx)$/i.test(filePath)) return true;
  // Quick structural sniff: at least one ATX heading on its own line.
  return /(^|\n)#{1,6}\s+\S/.test(text);
}
