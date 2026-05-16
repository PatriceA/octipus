/**
 * Memory-redesign Phase C — structural chunker for Markdown.
 *
 * Walks a Markdown document, emits one chunk per heading and one
 * chunk per body block, and threads the section path so the embedder
 * can write `parent_chunk_id` / `section_path` / `heading_level`.
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
 *     content:        string  — the chunk text
 *     headingLevel:   number  — 0=body, 1=H1, 2=H2, …
 *     sectionPath:    string[] — ancestor headings, root → self
 *                                (self included for heading chunks;
 *                                self EXCLUDED for body chunks)
 *     parentIndex:    number | null — index into the same array
 *                                     pointing at the nearest
 *                                     enclosing heading chunk, or
 *                                     null for a top-level chunk
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

const SOFT_MAX_CHARS = 1000;

export function chunkMarkdown(markdown: string): StructuralChunk[] {
  const chunks: StructuralChunk[] = [];
  // Stack of (headingChunkIndex, level) for the open heading scope.
  // We pop entries whose level >= incoming heading level to find the
  // new parent.
  const stack: Array<{ index: number; level: number; path: string[] }> = [];

  const lines = markdown.split(/\r?\n/);
  let i = 0;
  let bodyBuf = '';

  const flushBody = () => {
    const trimmed = bodyBuf.trim();
    bodyBuf = '';
    if (!trimmed) return;
    const parent = stack[stack.length - 1];
    const parentPath = parent ? parent.path : [];
    // Soft-split the body if it busts the chunk size. Same paragraph
    // rule as the flat chunker so long bodies don't become one mega
    // embedding.
    for (const piece of softSplit(trimmed)) {
      chunks.push({
        content: piece,
        headingLevel: 0,
        sectionPath: parentPath,
        parentIndex: parent ? parent.index : null,
      });
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
      flushBody();
      const level = heading[1].length;
      const title = heading[2].trim();
      // Pop the heading stack until we find a strictly-higher (lower
      // level number) parent.
      while (stack.length && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      const parent = stack[stack.length - 1];
      const newPath = [...(parent ? parent.path : []), title];
      const idx = chunks.length;
      chunks.push({
        content: `${'#'.repeat(level)} ${title}`,
        headingLevel: level,
        sectionPath: newPath,
        parentIndex: parent ? parent.index : null,
      });
      stack.push({ index: idx, level, path: newPath });
      i++;
      continue;
    }

    bodyBuf += (bodyBuf ? '\n' : '') + line;
    i++;
  }
  flushBody();

  return chunks;
}

function softSplit(text: string): string[] {
  if (text.length <= SOFT_MAX_CHARS) return [text];
  const out: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';
  for (const para of paragraphs) {
    if (current.length + para.length + 2 > SOFT_MAX_CHARS && current.length > 0) {
      out.push(current.trim());
      current = para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) out.push(current.trim());
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
