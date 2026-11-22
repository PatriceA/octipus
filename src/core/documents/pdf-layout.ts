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
 *  - **Column bands** are runs of lines that leave the same vertical strip of
 *    the page empty (a gutter). One line with a wide gap is a loose justified
 *    line; a gutter has to hold over several lines with text on both sides, and
 *    the text either side has to read like prose (long lines filling their
 *    column). A band is read column by column; a line that crosses the gutter
 *    (a title, an abstract, a figure caption, a footer) ends the band and is
 *    read in place, so a page with a full-width element in the middle reads
 *    band above, element, band below.
 *  - **Tables** are runs of rows whose cell gaps line up on the same x
 *    positions, whose cells are short, and whose cells share a left, right or
 *    centre edge per column. They come out as a Markdown table, since what
 *    reads them is a chunker and a language model.
 *
 * Short cells against long lines is what tells a table from a two-column body:
 * both have a persistent gutter and row-aligned baselines. Anything in between
 * — or any check that does not hold — keeps the line-by-line output this module
 * produced before it knew about either.
 *
 * What this does NOT attempt: merged or spanning cells (a header spanning two
 * columns hides that gutter, so those columns merge), tables whose columns do
 * not line up, two-column key/value forms (kept as `label  value` lines),
 * rotated or right-to-left text, and anything about scanned pages — those go
 * through the OCR/vision path, which never had this problem.
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

/** One baseline's items, sorted left to right. `y` is the baseline it was grouped on. */
interface Line {
  items: Positioned[];
  y: number;
}

/** A vertical strip [x0, x1] left empty by a run of lines. */
interface Gutter {
  x0: number;
  x1: number;
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
 * Lines that must have text on BOTH sides of a gutter before it counts. One
 * line is a loose justified line; two can be coincidence; three in a row with
 * the same empty strip is a layout.
 */
const MIN_GUTTER_LINES = 3;

/** A column region needs at least this many lines to be read as a column. */
const MIN_COLUMN_LINES = 3;

/**
 * Median characters per line a column must reach to be read as prose. Body
 * columns run 40-60 characters, a three-column newsletter about 30; table
 * cells sit well under {@link MAX_TABLE_CELL_CHARS}, and the gap between the
 * two is where neither reading is trusted.
 */
const MIN_COLUMN_LINE_CHARS = 25;

/** Median line width a prose column fills, as a fraction of the column's width. */
const MIN_COLUMN_FILL = 0.6;

/** Median characters per cell a table column may have. */
const MAX_TABLE_CELL_CHARS = 20;

/** A table's rows: at least this many with two or more filled cells. */
const MIN_TABLE_ROWS = 3;

/** Fraction of a column's cells that must share its left, right or centre edge. */
const MIN_TABLE_ALIGNED = 0.6;

/** A step this many page line pitches tall ends a table: it is a separate block. */
const MAX_TABLE_ROW_STEP_RATIO = 2.5;

/** A line closer than this fraction of the row pitch continues the row above (a wrapped cell). */
const CONTINUATION_STEP_RATIO = 0.75;

/** Starts retried inside a run refused as a table before the rest of it is skipped. */
const MAX_TABLE_RETRIES = 3;

/** A step this many line pitches tall stops a column band from absorbing the line beyond it. */
const BAND_EDGE_STEP_RATIO = 2;

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

const right = (it: Positioned): number => it.x + it.width;

/** Median glyph width of a set of items, or half the first item's height without widths. */
function charWidthOf(items: Positioned[]): number {
  const widths = items.filter((it) => it.width > 0 && it.str.length > 0).map((it) => it.width / it.str.length);
  return median(widths) || (items[0]?.height ?? 1) * 0.5;
}

/** Median positive step between consecutive baselines. */
function medianPitch(lines: Line[]): number {
  const pitches: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const step = lines[i - 1].y - lines[i].y;
    if (step > 0) pitches.push(step);
  }
  return median(pitches);
}

/** One line's items as text: wide gaps become two spaces, word gaps one, glyph-run joins none. */
function renderItems(items: Positioned[]): string {
  // Character width for THIS line, so the gap test scales with the type size.
  const charWidth = charWidthOf(items);
  let text = items[0].str;
  for (let j = 1; j < items.length; j++) {
    const prev = items[j - 1];
    const gap = items[j].x - right(prev);
    if (gap > charWidth * COLUMN_GAP_RATIO) {
      // Wide gap: a column boundary or a table cell edge. Two spaces, which
      // is what `pdftotext -layout` emits and what the markdown chunker and
      // any reader downstream will read as a separation rather than a word
      // break.
      text += `  ${items[j].str}`;
    } else if (gap > charWidth * 0.3 && !prev.str.endsWith(' ') && !items[j].str.startsWith(' ')) {
      text += ` ${items[j].str}`;
    } else {
      // Fragments of one word, split by a font or kerning change.
      text += items[j].str;
    }
  }
  return text.trimEnd();
}

/** Lines read top to bottom, with a blank line where the step is a paragraph break. */
function renderFlow(lines: Line[], pitch: number): string[] {
  const rendered: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    rendered.push(renderItems(lines[i].items));
    if (i + 1 < lines.length && pitch > 0) {
      const step = lines[i].y - lines[i + 1].y;
      if (step > pitch * PARAGRAPH_GAP_RATIO) rendered.push('');
    }
  }
  return rendered;
}

/** Whether any item of `line` intrudes into the strip `g` (touching its edge does not). */
function crosses(line: Line, g: Gutter, eps: number): boolean {
  return line.items.some((it) => it.x < g.x1 - eps && right(it) > g.x0 + eps);
}

/** Whether `line` has text on both sides of the strip `g`. */
function spans(line: Line, g: Gutter, eps: number): boolean {
  return line.items.some((it) => right(it) <= g.x0 + eps) && line.items.some((it) => it.x >= g.x1 - eps);
}

/** Interior horizontal gaps of a line at least `minWidth` wide. */
function lineGaps(line: Line, minWidth: number): Gutter[] {
  const gaps: Gutter[] = [];
  let edge = right(line.items[0]);
  for (let k = 1; k < line.items.length; k++) {
    const it = line.items[k];
    if (it.x - edge >= minWidth) gaps.push({ x0: edge, x1: it.x });
    edge = Math.max(edge, right(it));
  }
  return gaps;
}

interface GutterRun extends Gutter {
  start: number;
  end: number;
  /** Lines with text on both sides of the strip. */
  evidence: number;
  lastEvidence: number;
}

/**
 * Follow each empty vertical strip down the lines while no line crosses it,
 * narrowing it to what every line leaves empty. A line that intrudes only into
 * part of the strip (a ragged-right line running long) narrows it; one that
 * leaves less than a full gap's width ends it. Each run of lines and its
 * strip comes back with how many lines had text on both sides.
 *
 * A step taller than `maxStep` — a strip across the whole page with no text,
 * such as a figure — ends every run, the way a full-width caption does: what
 * sits below it (often a table whose gaps happen to fall on the gutter) is
 * not read as more of the columns above.
 *
 * Every line is checked against the strips open at that point, which stay few
 * (a gutter per column boundary, plus stray gaps that die on the next line),
 * so this is linear in items for any real page.
 */
function followGutters(lines: Line[], minWidth: number, eps: number, maxStep: number): GutterRun[] {
  const done: GutterRun[] = [];
  let open: GutterRun[] = [];
  for (let j = 0; j < lines.length; j++) {
    const line = lines[j];
    if (j > 0 && lines[j - 1].y - line.y > maxStep) {
      done.push(...open);
      open = [];
    }
    const gaps = lineGaps(line, minWidth);
    const still: GutterRun[] = [];
    for (const run of open) {
      if (!crosses(line, run, eps)) {
        run.end = j;
        if (spans(line, run, eps)) {
          run.evidence++;
          run.lastEvidence = j;
        }
        still.push(run);
        continue;
      }
      const narrowed = gaps
        .map((g) => ({ x0: Math.max(g.x0, run.x0), x1: Math.min(g.x1, run.x1) }))
        .find((g) => g.x1 - g.x0 >= minWidth);
      if (narrowed) {
        run.x0 = narrowed.x0;
        run.x1 = narrowed.x1;
        run.end = j;
        run.evidence++;
        run.lastEvidence = j;
        still.push(run);
      } else {
        done.push(run);
      }
    }
    for (const g of gaps) {
      if (still.some((run) => run.x0 < g.x1 && run.x1 > g.x0)) continue;
      still.push({ ...g, start: j, end: j, evidence: 1, lastEvidence: j });
    }
    open = still;
  }
  return [...done, ...open];
}

interface Band {
  start: number;
  end: number;
  /** Each column's lines, left to right, holding only that column's items. */
  regions: Line[][];
}

/** Split a band's lines at its gutters into one list of part-lines per column. */
function splitRegions(lines: Line[], gutters: Gutter[]): Line[][] {
  const sorted = [...gutters].sort((a, b) => a.x0 - b.x0);
  const regions: Line[][] = sorted.map(() => []);
  regions.push([]);
  for (const line of lines) {
    const parts: Positioned[][] = regions.map(() => []);
    for (const it of line.items) {
      const centre = it.x + it.width / 2;
      let k = 0;
      while (k < sorted.length && centre > sorted[k].x0) k++;
      parts[k].push(it);
    }
    parts.forEach((items, k) => {
      if (items.length > 0) regions[k].push({ items, y: line.y });
    });
  }
  return regions;
}

/**
 * Whether every region reads as a column of prose: enough lines, long, filling
 * its width. Measured on the region's lines without cell gaps of their own, so
 * a table set inside a column does not make the column look like a table.
 */
function isProse(regions: Line[][]): boolean {
  return regions.every((region) => {
    const text = region.filter((l) => cellGaps(l).length === 0);
    if (text.length < MIN_COLUMN_LINES) return false;
    const lengths = text.map((l) => renderItems(l.items).length);
    const x0 = Math.min(...region.map((l) => l.items[0].x));
    const x1 = Math.max(...region.map((l) => Math.max(...l.items.map(right))));
    const widths = text.map((l) => Math.max(...l.items.map(right)) - l.items[0].x);
    return median(lengths) >= MIN_COLUMN_LINE_CHARS && x1 > x0 && median(widths) >= (x1 - x0) * MIN_COLUMN_FILL;
  });
}

/**
 * Column bands on a page: runs of lines split by gutters held over at least
 * {@link MIN_GUTTER_LINES} two-sided lines, whose columns read as prose.
 * Bands never overlap; lines outside every band are read as they are.
 */
function findColumnBands(lines: Line[], charWidth: number, pitch: number): Band[] {
  const eps = charWidth * 0.25;
  const minWidth = charWidth * COLUMN_GAP_RATIO;
  const edgeStep = pitch > 0 ? pitch * BAND_EDGE_STEP_RATIO : Number.POSITIVE_INFINITY;
  const step = (k: number) => lines[k - 1].y - lines[k].y;

  const runs = followGutters(lines, minWidth, eps, edgeStep).filter((r) => r.evidence >= MIN_GUTTER_LINES);
  for (const run of runs) {
    // Lines below the last two-sided line belong to the band only while they
    // stay close: a short footer far below the body would otherwise be read
    // as the end of the left column.
    let end = run.lastEvidence;
    while (end < run.end && step(end + 1) <= edgeStep) end++;
    run.end = end;
    // The run starts at its first two-sided line; a column's opening lines
    // that only have text on one side (a column heading, the tail of a
    // paragraph) are part of it too, while they stay close and do not cross.
    while (run.start > 0 && step(run.start) <= edgeStep && !crosses(lines[run.start - 1], run, eps)) run.start--;
  }
  runs.sort((a, b) => b.evidence - a.evidence || a.start - b.start);

  // The strongest run sets a band's lines; every other gutter that no line of
  // the band crosses splits it further (a third column). The columns that
  // makes must all read as prose, or the band is not taken.
  const bands: Band[] = [];
  for (const run of runs) {
    if (bands.some((b) => run.start <= b.end && run.end >= b.start)) continue;
    const bandLines = lines.slice(run.start, run.end + 1);
    const gutters: Gutter[] = [run];
    for (const other of runs) {
      if (other === run || other.start > run.end || other.end < run.start) continue;
      if (gutters.some((g) => g.x0 < other.x1 && g.x1 > other.x0)) continue;
      if (bandLines.some((l) => crosses(l, other, eps))) continue;
      gutters.push(other);
    }
    const regions = splitRegions(bandLines, gutters);
    if (isProse(regions)) bands.push({ start: run.start, end: run.end, regions });
  }
  return bands.sort((a, b) => a.start - b.start);
}

/** Escape a cell for a Markdown table: a pipe would end the cell. */
const escapeCell = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

interface TableCell {
  text: string;
  x0: number;
  x1: number;
}

type Anchor = 'left' | 'right' | 'centre';

/** The edge most of a column's cells share, and how many share it. */
function columnAnchor(cells: TableCell[], tolerance: number): { anchor: Anchor; count: number } {
  const edges: Record<Anchor, (c: TableCell) => number> = {
    left: (c) => c.x0,
    right: (c) => c.x1,
    centre: (c) => (c.x0 + c.x1) / 2,
  };
  let best: { anchor: Anchor; count: number } = { anchor: 'left', count: 0 };
  for (const anchor of ['left', 'right', 'centre'] as const) {
    const at = median(cells.map(edges[anchor]));
    const count = cells.filter((c) => Math.abs(edges[anchor](c) - at) <= tolerance).length;
    if (count > best.count) best = { anchor, count };
  }
  return best;
}

/**
 * The lines of one candidate run as a Markdown table, or null when it does not
 * hold up as one. `lines` all leave every gutter in `gutters` empty. Returns
 * how many of the lines the table used, since trailing lines that turn out to
 * be text below the table are given back.
 */
function buildTable(lines: Line[], gutters: Gutter[], charWidth: number): { markdown: string[]; used: number } | null {
  const sorted = [...gutters].sort((a, b) => a.x0 - b.x0);
  const columns = sorted.length + 1;
  if (columns < 2) return null;

  const grid: Array<Array<TableCell | null>> = lines.map((line) => {
    const parts: Positioned[][] = Array.from({ length: columns }, () => []);
    for (const it of line.items) {
      const centre = it.x + it.width / 2;
      let k = 0;
      while (k < sorted.length && centre > sorted[k].x0) k++;
      parts[k].push(it);
    }
    return parts.map((items) =>
      items.length === 0 ? null : { text: renderItems(items), x0: items[0].x, x1: Math.max(...items.map(right)) },
    );
  });
  const filled = (row: Array<TableCell | null>) => row.filter((c) => c !== null).length;

  // A wrapped cell's second line sits closer to the line above than rows sit
  // to each other. Only measurable when rows are spaced wider than lines are:
  // without that spacing a wrapped cell reads as a row of its own.
  const steps = lines.map((l, k) => (k === 0 ? 0 : lines[k - 1].y - l.y));
  const rowSteps = steps.filter((s, k) => k > 0 && grid[k][0] !== null);
  const rowStep = median(rowSteps.length > 0 ? rowSteps : steps.slice(1));
  const continues = steps.map((s, k) => k > 0 && s < rowStep * CONTINUATION_STEP_RATIO && filled(grid[k]) < columns);

  // Lines after the last real row with a single filled cell are the text
  // below the table, not rows of it.
  let used = lines.length;
  while (used > 0 && !continues[used - 1] && filled(grid[used - 1]) < 2) used--;

  const rows: Array<Array<TableCell | null>> = [];
  for (let k = 0; k < used; k++) {
    const last = rows[rows.length - 1];
    if (!continues[k] || !last) {
      rows.push([...grid[k]]);
      continue;
    }
    grid[k].forEach((cell, c) => {
      if (!cell) return;
      const above = last[c];
      last[c] = above
        ? { text: `${above.text} ${cell.text}`, x0: Math.min(above.x0, cell.x0), x1: Math.max(above.x1, cell.x1) }
        : cell;
    });
  }

  const fullRows = rows.filter((r) => filled(r) >= 2).length;
  if (fullRows < MIN_TABLE_ROWS || fullRows < rows.length * 0.6) return null;

  const tolerance = Math.max(charWidth, 1);
  const anchors: Anchor[] = [];
  for (let c = 0; c < columns; c++) {
    const cells = rows.map((r) => r[c]).filter((cell): cell is TableCell => cell !== null);
    if (cells.length < 2) return null;
    // Long cells are prose in columns, not a table.
    if (median(cells.map((cell) => cell.text.length)) > MAX_TABLE_CELL_CHARS) return null;
    const { anchor, count } = columnAnchor(cells, tolerance);
    if (count < Math.ceil(cells.length * MIN_TABLE_ALIGNED)) return null;
    anchors.push(anchor);
  }

  // A form's labels end in a colon: that is `label  value`, and the lines it
  // already came out as say so better than a table would.
  const labels = rows.map((r) => r[0]).filter((cell): cell is TableCell => cell !== null);
  if (labels.filter((cell) => cell.text.trimEnd().endsWith(':')).length * 2 >= labels.length) return null;

  // Two columns are as often a key/value list as a table. Only take them as a
  // table when the first row looks like a header: no digits in it, while one
  // column's body is mostly numbers.
  if (columns === 2) {
    const header = rows[0];
    if (header.some((cell) => cell !== null && /\d/.test(cell.text))) return null;
    const numeric = (c: number) => {
      const body = rows.slice(1).map((r) => r[c]).filter((cell): cell is TableCell => cell !== null);
      return body.filter((cell) => /\d/.test(cell.text)).length * 2 > body.length;
    };
    if (!numeric(0) && !numeric(1)) return null;
  }

  const toRow = (r: Array<TableCell | null>) => `| ${r.map((cell) => (cell ? escapeCell(cell.text) : '')).join(' | ')} |`;
  const markdown = [
    toRow(rows[0]),
    `| ${anchors.map((a) => (a === 'right' ? '---:' : '---')).join(' | ')} |`,
    ...rows.slice(1).map(toRow),
  ];
  return { markdown, used };
}

/** Cell gaps of a line as its own rendering sees them: wider than COLUMN_GAP_RATIO of its glyphs. */
function cellGaps(line: Line): Gutter[] {
  return lineGaps(line, charWidthOf(line.items) * COLUMN_GAP_RATIO);
}

/**
 * Lines read top to bottom, with runs that hold up as tables replaced by a
 * Markdown table set off by blank lines. Everything else is {@link renderFlow}.
 */
function renderSequence(lines: Line[], pitch: number, charWidth: number): string[] {
  const out: string[] = [];
  const eps = charWidth * 0.25;
  let flowStart = 0;
  const flushFlow = (end: number) => {
    if (end > flowStart) out.push(...renderFlow(lines.slice(flowStart, end), pitch));
  };

  let i = 0;
  let refusedEnd = 0;
  let retries = 0;
  while (i < lines.length) {
    let gutters = cellGaps(lines[i]).map((g) => ({ ...g, rows: 1 }));
    if (gutters.length === 0) {
      i++;
      continue;
    }
    // Follow the row's cell gaps down while they stay clear. A gap only the
    // first row had (wide spacing inside a header cell) may close; a line that
    // crosses a gap two rows already held is the text after the table, and
    // ends the run before it can take that column away.
    let j = i + 1;
    while (j < lines.length) {
      if (pitch > 0 && lines[j - 1].y - lines[j].y > pitch * MAX_TABLE_ROW_STEP_RATIO) break;
      const line = lines[j];
      const gaps = cellGaps(line);
      const still: typeof gutters = [];
      let ends = false;
      for (const g of gutters) {
        if (!crosses(line, g, eps)) {
          still.push(spans(line, g, eps) ? { ...g, rows: g.rows + 1 } : g);
          continue;
        }
        const narrowed = gaps
          .map((gap) => ({ x0: Math.max(gap.x0, g.x0), x1: Math.min(gap.x1, g.x1) }))
          .find((gap) => gap.x1 - gap.x0 >= charWidth * COLUMN_GAP_RATIO);
        if (narrowed) still.push({ ...narrowed, rows: g.rows + 1 });
        else if (g.rows >= 2) ends = true;
      }
      if (ends || still.length === 0) break;
      gutters = still;
      j++;
    }

    const table = j - i >= MIN_TABLE_ROWS ? buildTable(lines.slice(i, j), gutters, charWidth) : null;
    if (!table) {
      // A refused run is retried from the next few lines (a caption-like line
      // with gaps of its own may sit above a real table), then skipped:
      // retrying from every line of a long refused run is quadratic in it.
      if (i >= refusedEnd) {
        refusedEnd = j;
        retries = 0;
      }
      i = ++retries > MAX_TABLE_RETRIES ? Math.max(i + 1, refusedEnd) : i + 1;
      continue;
    }
    flushFlow(i);
    if (out.length > 0 && out[out.length - 1] !== '') out.push('');
    out.push(...table.markdown, '');
    i += table.used;
    flowStart = i;
  }
  flushFlow(lines.length);
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * Rebuild one page's text from positioned items, preserving line breaks,
 * column/cell gaps and paragraph boundaries, reading column bands column by
 * column and tables as Markdown tables. Returns '' for an empty page.
 */
export function reconstructPageText(items: PdfTextItem[]): string {
  const positioned: Positioned[] = items
    // Whitespace-only items carry no text, only a width: pdfjs inserts one
    // across a gap between two runs, as wide as the gap itself, so keeping it
    // closed every column gutter and cell gap on a real PDF. The gap test
    // below puts the right amount of space back.
    .filter((i) => typeof i.str === 'string' && i.str.trim().length > 0 && Array.isArray(i.transform))
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
  const groups: Positioned[][] = [];
  for (const item of sorted) {
    const current = groups[groups.length - 1];
    const tolerance = Math.max(item.height, current?.[0]?.height ?? 0) * LINE_TOLERANCE_RATIO;
    if (current && Math.abs(current[0].y - item.y) <= tolerance) {
      current.push(item);
    } else {
      groups.push([item]);
    }
  }
  const lines: Line[] = groups.map((g) => ({ y: g[0].y, items: [...g].sort((a, b) => a.x - b.x) }));

  // Line pitch tells a paragraph break from an ordinary wrap. Median, not mean:
  // one figure or a page break would drag an average and split every paragraph.
  const pitch = medianPitch(lines);
  const charWidth = charWidthOf(positioned);

  const out: string[] = [];
  const block = (rendered: string[]) => {
    if (rendered.length === 0) return;
    if (out.length > 0 && out[out.length - 1] !== '') out.push('');
    out.push(...rendered);
  };

  let next = 0;
  for (const band of findColumnBands(lines, charWidth, pitch)) {
    block(renderSequence(lines.slice(next, band.start), pitch, charWidth));
    // Column by column. A single newline between columns, not a blank line: a
    // paragraph running off the foot of one column continues at the top of
    // the next, and the chunker keeps a paragraph together.
    // A table at the foot or head of a column still needs its blank line, or
    // the next column's first line would read as one more table row.
    const columns: string[] = [];
    for (const region of band.regions) {
      const regionPitch = region.length > 2 ? medianPitch(region) : pitch;
      const rendered = renderSequence(region, regionPitch || pitch, charWidth);
      const isRow = (l: string | undefined) => l?.startsWith('| ') === true;
      if (columns.length > 0 && (isRow(columns[columns.length - 1]) || isRow(rendered[0]))) columns.push('');
      columns.push(...rendered);
    }
    block(columns);
    next = band.end + 1;
  }
  block(renderSequence(lines.slice(next), pitch, charWidth));

  return out.join('\n').trim();
}
