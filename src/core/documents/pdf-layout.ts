/**
 * Layout-grounded reconstruction of a PDF page's text (roadmap wave 4).
 *
 * `pdfjs` hands back positioned text ITEMS, not lines: every fragment carries
 * a transform matrix saying where on the page it was drawn. The extractor threw
 * all of that away — `items.map(i => i.str).join(' ')` — which is why a
 * two-column paper came out with its columns interleaved word by word, and a
 * table came out as a single run of cell values with nothing marking where one
 * row ended and the next began. Everything downstream (chunker, embeddings, the
 * model reading a retrieved chunk) then reasons about a document whose structure
 * was destroyed before it ever saw it.
 *
 * The geometry is doing the work here, and it is deliberately simple:
 *
 *  - **Lines** are items sharing a baseline, within a tolerance derived from the
 *    text height rather than a fixed pixel count — an 8pt footnote and a 24pt
 *    heading do not share a threshold.
 *  - **Columns and cells** are horizontal GAPS inside a line. A gap much wider
 *    than the line's own space character is a deliberate separation, not a word
 *    break, so it becomes whitespace that survives into the text.
 *  - **Paragraphs** are vertical gaps much larger than the prevailing line
 *    spacing on the page.
 *
 * What this does NOT attempt: recovering a table as a grid, ordering true
 * multi-column flow (a two-column page still reads left-to-right across both
 * columns, line by line), or anything about scanned pages — those go through the
 * OCR/vision path, which never had this problem.
 */

/** The subset of a `pdfjs` TextItem this needs. `transform` is [a,b,c,d,e,f]. */
export interface PdfTextItem {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
}

interface Positioned {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A gap wider than this many multiples of the local character width is treated
 * as a column/cell separation rather than a word space. 1.8 sits comfortably
 * between the two: normal inter-word spacing in a justified paragraph rarely
 * exceeds ~1.5 char widths, while table gutters are several.
 */
const COLUMN_GAP_RATIO = 1.8;

/** Baseline differences under this fraction of text height are the same line. */
const LINE_TOLERANCE_RATIO = 0.5;

/** A vertical step larger than this multiple of the median line pitch breaks a paragraph. */
const PARAGRAPH_GAP_RATIO = 1.6;

/**
 * Lower median. Lower, not the average of the two middles, because both callers
 * want the TYPICAL value with outliers pushed away on the high side: paragraph
 * gaps inflate line pitch, and a wide-set heading fragment inflates character
 * width. With two samples, averaging would let the single outlier set the
 * threshold that is supposed to detect it.
 */
const median = (ns: number[]): number => {
  if (ns.length === 0) return 0;
  const sorted = [...ns].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};

/**
 * Rebuild one page's text from positioned items, preserving line breaks,
 * column/cell gaps and paragraph boundaries. Returns '' for an empty page.
 */
export function reconstructPageText(items: PdfTextItem[]): string {
  const positioned: Positioned[] = items
    .filter((i) => typeof i.str === 'string' && i.str.length > 0 && Array.isArray(i.transform))
    .map((i) => ({
      str: i.str,
      // pdfjs transform is [scaleX, skewX, skewY, scaleY, translateX, translateY].
      x: i.transform[4] ?? 0,
      y: i.transform[5] ?? 0,
      width: i.width ?? 0,
      // Height can be absent on some producers; the vertical scale is the
      // honest fallback, and 1 keeps the tolerances non-zero either way.
      height: i.height || Math.abs(i.transform[3]) || 1,
    }));

  if (positioned.length === 0) return '';

  // Group into lines by baseline. PDF y grows UPWARD, so a page reads from the
  // highest y down.
  const sorted = [...positioned].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Positioned[][] = [];
  for (const item of sorted) {
    const current = lines[lines.length - 1];
    const tolerance = Math.max(item.height, current?.[0]?.height ?? 0) * LINE_TOLERANCE_RATIO;
    if (current && Math.abs(current[0].y - item.y) <= tolerance) {
      current.push(item);
    } else {
      lines.push([item]);
    }
  }

  // Line pitch tells a paragraph break from an ordinary wrap. Median, not mean:
  // one figure or a page break would drag an average and split every paragraph.
  const pitches: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const step = lines[i - 1][0].y - lines[i][0].y;
    if (step > 0) pitches.push(step);
  }
  const medianPitch = median(pitches);

  const rendered: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = [...lines[i]].sort((a, b) => a.x - b.x);

    // Character width for THIS line, so the gap test scales with the type size.
    const charWidths = line
      .filter((it) => it.width > 0 && it.str.length > 0)
      .map((it) => it.width / it.str.length);
    const charWidth = median(charWidths) || line[0].height * 0.5;

    let text = line[0].str;
    for (let j = 1; j < line.length; j++) {
      const prev = line[j - 1];
      const gap = line[j].x - (prev.x + prev.width);
      if (gap > charWidth * COLUMN_GAP_RATIO) {
        // Wide gap: a column boundary or a table cell edge. Two spaces, which
        // is what `pdftotext -layout` emits and what the markdown chunker and
        // any reader downstream will read as a separation rather than a word
        // break.
        text += `  ${line[j].str}`;
      } else if (gap > charWidth * 0.3 && !prev.str.endsWith(' ') && !line[j].str.startsWith(' ')) {
        text += ` ${line[j].str}`;
      } else {
        // Fragments of one word, split by a font or kerning change.
        text += line[j].str;
      }
    }

    rendered.push(text.trimEnd());

    if (i + 1 < lines.length && medianPitch > 0) {
      const step = lines[i][0].y - lines[i + 1][0].y;
      if (step > medianPitch * PARAGRAPH_GAP_RATIO) rendered.push('');
    }
  }

  return rendered.join('\n').trim();
}
