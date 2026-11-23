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
 *    reads them is a chunker and a language model. A table with no header row
 *    is held to more: more rows, tighter alignment, a column of numbers, and
 *    none of the shapes of a list, a form or a contents page. It comes out
 *    under an empty header row, which Markdown requires and which claims
 *    nothing about what the columns are.
 *  - **Tables across a page break** are read with the page before in view
 *    ({@link reconstructPage}): rows at the head of a page whose columns sit
 *    where the previous page's closing table had them continue that table,
 *    with or without a repeated header.
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
  /** pdfjs reported a whitespace item just before this one (in its own order). */
  spaceBefore?: boolean;
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

/**
 * A gutter at least this many glyphs wide needs {@link MIN_GUTTER_LINES}; a
 * narrower one (still over the cell-gap width) needs
 * {@link MIN_NARROW_GUTTER_LINES}. A loose justified word space reaches about
 * 2.5 glyphs; a LaTeX two-column gutter is about 2.2, which is why narrow
 * gutters are not refused outright but asked for more lines.
 */
const WIDE_GUTTER_RATIO = 3;
const MIN_NARROW_GUTTER_LINES = 6;

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

/**
 * A table with no header row has only its grid to go on, so it needs more of
 * one: this many rows, every one with two or more filled cells, and
 * {@link MIN_HEADERLESS_ALIGNED} of every column's cells on one edge.
 */
const MIN_HEADERLESS_ROWS = 4;
const MIN_HEADERLESS_ALIGNED = 0.8;

/** A step this many page line pitches tall ends a table: it is a separate block. */
const MAX_TABLE_ROW_STEP_RATIO = 2.5;

/** A line closer than this fraction of the row pitch continues the row above (a wrapped cell). */
const CONTINUATION_STEP_RATIO = 0.75;

/** Above this many items on a page, or on one baseline, the page is read line by line only. */
const MAX_LAYOUT_ITEMS = 10000;
const MAX_LAYOUT_LINE_ITEMS = 500;

/** Above this many persistent gutters on a page, it is not read as column bands. */
const MAX_GUTTER_RUNS = 16;

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
    } else if (
      (gap > charWidth * 0.3 || (items[j].spaceBefore === true && gap > -charWidth * 0.3)) &&
      !prev.str.endsWith(' ') &&
      !items[j].str.startsWith(' ')
    ) {
      // A word gap, or a narrow one pdfjs said was a space (see `spaceBefore`).
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

  // A strip only a little wider than a loose word space needs twice the
  // evidence: three justified lines can stretch a space at the same place.
  const runs = followGutters(lines, minWidth, eps, edgeStep).filter(
    (r) => r.evidence >= (r.x1 - r.x0 >= charWidth * WIDE_GUTTER_RATIO ? MIN_GUTTER_LINES : MIN_NARROW_GUTTER_LINES),
  );
  // Prose pages have a gutter or three. Dozens of persistent gutters are a
  // grid (a wide table), which the table pass reads; pairing every run with
  // every other here would be quadratic in them for nothing.
  if (runs.length > MAX_GUTTER_RUNS) return [];
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

/** Dot leaders: a run of dots (spaced or not), an ellipsis, or underscores. */
const LEADER = /(\.\s?){4,}|…|_{3,}/;

/** A number, an amount, a date or a page number — arabic or roman. */
const isNumberLike = (s: string): boolean =>
  /^[(+\-–−]?[$€£¥]?\s?\d[\d.,:/\-–\s]*[%)]?$/.test(s.trim()) || /^(?:[ivxlcdm]{1,6}|[IVXLCDM]{1,6})$/.test(s.trim());

/** A roman numeral up to 89, as front matter and list markers use them. */
const ROMAN = '(?=[ivxl])l?x{0,3}(?:ix|iv|v?i{0,3})';

/** A numbered list's own marker — `1.`, `2)`, `(a)`, `iv.` — not a value. */
const LIST_NUMBER = new RegExp(`^\\(?(?:\\d{1,3}|[a-z]|${ROMAN})[.)]$`, 'i');

/** A page number on a line of its own (`7`, `- 7 -`, `Page 7 of 12`, `vii`): page furniture, not content. */
const PAGE_NUMBER = new RegExp(`^[-–—\\s]*(?:page\\s+)?(?:\\d{1,4}|${ROMAN})(?:\\s*(?:of|/)\\s*\\d{1,4})?[-–—\\s]*$`, 'i');

const ROMAN_ONLY = new RegExp(`^${ROMAN}$`, 'i');

/** Escape a cell for a Markdown table: a pipe would end the cell. */
const escapeCell = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

interface TableCell {
  text: string;
  x0: number;
  x1: number;
}

type Anchor = 'left' | 'right' | 'centre';

const EDGES: Record<Anchor, (c: TableCell) => number> = {
  left: (c) => c.x0,
  right: (c) => c.x1,
  centre: (c) => (c.x0 + c.x1) / 2,
};

/** One column of a table: the edge its cells share and where that edge is. */
interface ColumnShape {
  anchor: Anchor;
  at: number;
}

/**
 * What a page's closing table leaves for the next page to continue: where its
 * columns are, and its header row as emitted (null when it had none), so a
 * header the next page repeats is recognised and not read as a row.
 */
export interface TableShape {
  columns: ColumnShape[];
  header: string | null;
}

/**
 * The edge most of a column's cells share, where it is, and how many share it.
 * On a tie the edge the cells sit on most exactly wins: numbers a digit apart
 * in width are within tolerance on the left too, but only flush on the right.
 */
function columnAnchor(cells: TableCell[], tolerance: number): ColumnShape & { count: number } {
  let best: ColumnShape & { count: number; spread: number } = { anchor: 'left', at: 0, count: 0, spread: 0 };
  for (const anchor of ['left', 'right', 'centre'] as const) {
    const at = median(cells.map(EDGES[anchor]));
    const near = cells.map((c) => Math.abs(EDGES[anchor](c) - at)).filter((d) => d <= tolerance);
    const spread = near.reduce((sum, d) => sum + d, 0);
    if (near.length > best.count || (near.length === best.count && spread < best.spread)) {
      best = { anchor, at, count: near.length, spread };
    }
  }
  return { anchor: best.anchor, at: best.at, count: best.count };
}

type Row = Array<TableCell | null>;

const filled = (row: Row) => row.filter((c) => c !== null).length;

/**
 * Whether the first row reads as a header: in a column whose body is numbers,
 * a first cell that is a number too (a page number, a list number, a value)
 * says the first row is just another row — a list or a table of contents.
 * Two columns are as often a key/value list as a table, so they need a first
 * row with no digits in it over a column of numbers.
 */
function hasHeaderRow(rows: Row[], column: (c: number, from?: number) => TableCell[]): boolean {
  const header = rows[0];
  const numericBody = (c: number) => {
    const body = column(c, 1);
    return body.length > 0 && body.filter((cell) => isNumberLike(cell.text)).length * 2 > body.length;
  };
  const numericColumns = header.map((_, c) => c).filter(numericBody);
  if (numericColumns.some((c) => header[c] !== null && isNumberLike(header[c].text))) return false;
  if (header.length === 2) {
    if (header.some((cell) => cell !== null && /\d/.test(cell.text))) return false;
    if (numericColumns.length === 0) return false;
  }
  return true;
}

/** A column of page numbers: whole numbers (or roman numerals) that never go down. */
function isPageColumn(cells: TableCell[]): boolean {
  const texts = cells.map((cell) => cell.text.trim());
  if (!texts.every((t) => /^\d{1,4}$/.test(t) || ROMAN_ONLY.test(t))) return false;
  const arabic = texts.filter((t) => /^\d+$/.test(t)).map(Number);
  return arabic.every((n, k) => k === 0 || n >= arabic[k - 1]);
}

/**
 * Whether rows with no header row still hold up as a table. The grid is all
 * there is to go on, so it has to be unmistakable, and none of the other
 * things that also line up in columns:
 *
 *  - enough rows ({@link MIN_HEADERLESS_ROWS}), each with two or more cells,
 *    and every column's cells on one edge ({@link MIN_HEADERLESS_ALIGNED});
 *  - a column that is numbers all the way down: a grid of words with no
 *    header is a list set in columns as often as it is data;
 *  - with two columns, both of them numbers: a word beside a number is a
 *    label and its value (`Total  420.00`) as often as it is a table row;
 *  - not a numbered list (`1.`, `2.` down the first column);
 *  - not a contents page: page numbers that only go up, beside words.
 *
 * Prose in columns never gets this far: its cells are too long.
 */
function isHeaderlessTable(rows: Row[], columns: number, column: (c: number) => TableCell[], strictlyAligned: boolean): boolean {
  if (!strictlyAligned || rows.length < MIN_HEADERLESS_ROWS || rows.some((r) => filled(r) < 2)) return false;
  const all = Array.from({ length: columns }, (_, c) => column(c));
  const numeric = all.filter((cells) => cells.every((cell) => isNumberLike(cell.text)));
  if (numeric.length === 0 || (columns === 2 && numeric.length < 2)) return false;
  if (all[0].filter((cell) => LIST_NUMBER.test(cell.text.trim())).length * 2 >= all[0].length) return false;
  const words = all.some((cells) => cells.every((cell) => !isNumberLike(cell.text)));
  return !(words && isPageColumn(all[columns - 1]));
}

interface BuiltTable {
  markdown: string[];
  used: number;
  shape: TableShape;
  /** The rows continue the previous page's table: `markdown` is rows only, no header or separator. */
  continued: boolean;
}

/**
 * The lines of one candidate run as a Markdown table, or null when it does not
 * hold up as one. `lines` all leave every gutter in `gutters` empty. Returns
 * how many of the lines the table used, since trailing lines that turn out to
 * be text below the table are given back.
 *
 * With `previous` (the table the page before ended with, when this run opens
 * the page), rows whose columns sit where that table's did continue it: they
 * may be as few as one, and need no header of their own. A first row equal to
 * that table's header is the header repeated, and is dropped. A run with a
 * header of its own is a new table that shares the columns, read without
 * `previous`.
 */
function buildTable(lines: Line[], gutters: Gutter[], charWidth: number, previous: TableShape | null): BuiltTable | null {
  const sorted = [...gutters].sort((a, b) => a.x0 - b.x0);
  const columns = sorted.length + 1;
  if (columns < 2) return null;

  const grid: Row[] = lines.map((line) => {
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

  const rows: Row[] = [];
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

  if (rows.length === 0) return null;

  const column = (c: number, from = 0) =>
    rows.slice(from).map((r) => r[c]).filter((cell): cell is TableCell => cell !== null);
  const tolerance = Math.max(charWidth, 1);

  // Columns where the previous page's table had them: every column has a
  // cell, and most of its cells sit on that column's edge.
  const continuing =
    previous !== null &&
    previous.columns.length === columns &&
    previous.columns.every((col, c) => {
      const cells = column(c);
      const on = cells.filter((cell) => Math.abs(EDGES[col.anchor](cell) - col.at) <= tolerance).length;
      return cells.length > 0 && on >= Math.ceil(cells.length * MIN_TABLE_ALIGNED);
    });

  // A continuation can be a row or two at the head of a page: the table
  // above vouches for its columns, so it is not asked to line up on its own.
  const fullRows = rows.filter((r) => filled(r) >= 2).length;
  if (fullRows < (continuing ? 1 : MIN_TABLE_ROWS) || fullRows < rows.length * 0.6) return null;

  const anchors: ColumnShape[] = [];
  let strictlyAligned = true;
  for (let c = 0; c < columns; c++) {
    const cells = column(c);
    if (cells.length < (continuing ? 1 : 2)) return null;
    // Long cells are prose in columns, not a table.
    if (median(cells.map((cell) => cell.text.length)) > MAX_TABLE_CELL_CHARS) return null;
    const { anchor, at, count } = columnAnchor(cells, tolerance);
    if (!continuing && count < Math.ceil(cells.length * MIN_TABLE_ALIGNED)) return null;
    if (count < Math.ceil(cells.length * MIN_HEADERLESS_ALIGNED)) strictlyAligned = false;
    anchors.push({ anchor, at });
  }

  // A form's labels end in a colon: that is `label  value`, and the lines it
  // already came out as say so better than a table would.
  const labels = column(0);
  if (labels.filter((cell) => cell.text.trimEnd().endsWith(':')).length * 2 >= labels.length) return null;

  for (let c = 0; c < columns; c++) {
    const cells = column(c);
    // One short token down a whole column is a list marker (•, -, ☐), not data.
    if (cells.length >= MIN_TABLE_ROWS && cells[0].text.length <= 3 && cells.every((cell) => cell.text === cells[0].text)) {
      return null;
    }
    // Dot leaders are a table of contents.
    if (cells.filter((cell) => LEADER.test(cell.text)).length * 2 >= cells.length) return null;
  }

  const toRow = (r: Row) => `| ${r.map((cell) => (cell ? escapeCell(cell.text) : '')).join(' | ')} |`;

  if (continuing && previous) {
    const repeated = previous.header !== null && toRow(rows[0]) === previous.header;
    if (!repeated && hasHeaderRow(rows, column)) return buildTable(lines, gutters, charWidth, null);
    return { markdown: rows.slice(repeated ? 1 : 0).map(toRow), used, shape: previous, continued: true };
  }

  const separator = `| ${anchors.map((a) => (a.anchor === 'right' ? '---:' : '---')).join(' | ')} |`;
  if (hasHeaderRow(rows, column)) {
    const header = toRow(rows[0]);
    const markdown = [header, separator, ...rows.slice(1).map(toRow)];
    return { markdown, used, shape: { columns: anchors, header }, continued: false };
  }
  if (!isHeaderlessTable(rows, columns, column, strictlyAligned)) return null;
  // Markdown has no table without a header row. An empty one says the columns
  // have no names; invented ones (`Column 1`) would be embedded and searched
  // as if the document said them.
  const markdown = [`|${' |'.repeat(columns)}`, separator, ...rows.map(toRow)];
  return { markdown, used, shape: { columns: anchors, header: null }, continued: false };
}

/** Cell gaps of a line as its own rendering sees them: wider than COLUMN_GAP_RATIO of its glyphs. */
function cellGaps(line: Line): Gutter[] {
  return lineGaps(line, charWidthOf(line.items) * COLUMN_GAP_RATIO);
}

/** What the sequences of one page share about tables, in reading order. */
interface TableState {
  /** The previous page's closing table, while nothing but page numbers has been read on this page. */
  previous: TableShape | null;
  /** The page opened by continuing `previous`. */
  continued: boolean;
  /** The last table read on the page. */
  last: TableShape | null;
}

const isPageNumber = (line: string): boolean => PAGE_NUMBER.test(line);

/**
 * Lines read top to bottom, with runs that hold up as tables replaced by a
 * Markdown table set off by blank lines. Everything else is {@link renderFlow}.
 *
 * While `state.previous` is set, a table opening the sequence (below nothing
 * but page numbers) may continue it: its rows come out with no header or
 * separator, and the page numbers above it are dropped, since they would
 * otherwise sit in the middle of the joined table.
 */
function renderSequence(lines: Line[], pitch: number, charWidth: number, state: TableState): string[] {
  const out: string[] = [];
  const eps = charWidth * 0.25;
  let flowStart = 0;
  const flushFlow = (end: number) => {
    if (end > flowStart) out.push(...renderFlow(lines.slice(flowStart, end), pitch));
  };
  let lead = 0;
  if (state.previous) while (lead < lines.length && isPageNumber(renderItems(lines[lead].items))) lead++;

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

    const carry = i <= lead ? state.previous : null;
    const table = j - i >= (carry ? 1 : MIN_TABLE_ROWS) ? buildTable(lines.slice(i, j), gutters, charWidth, carry) : null;
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
    if (table.continued) state.continued = true;
    else flushFlow(i);
    if (out.length > 0 && out[out.length - 1] !== '') out.push('');
    out.push(...table.markdown, '');
    state.last = table.shape;
    i += table.used;
    flowStart = i;
  }
  flushFlow(lines.length);
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  // Only the page's opening sequence can continue the page before.
  state.previous = null;
  return out;
}

/** One page's text, and what it says about a table running across its edges. */
export interface PdfPageText {
  text: string;
  /** The table the page ends with (nothing but page numbers after it), for the next page to continue. */
  openTable: TableShape | null;
  /** The page opens with rows continuing the previous page's table: `text` starts with them, with no header. */
  continuesTable: boolean;
}

/**
 * One page's text, as {@link reconstructPageText}, read knowing the table the
 * previous page ended with (`previous`, that page's `openTable`), so rows at
 * the head of this page that continue it come out as more of its rows. Pass
 * the pages in order and join them with {@link joinPdfPages}.
 */
export function reconstructPage(items: PdfTextItem[], previous: TableShape | null = null): PdfPageText {
  // Whitespace-only items are not text: pdfjs inserts one across a gap between
  // two runs, as wide as the gap itself, so measuring it as text closed every
  // column gutter and cell gap on a real PDF. It is still a statement that a
  // space sits there: at a font change pdfjs reports an ordinary word space
  // this way, about a point wide — narrower than the word-gap test — so the
  // item it precedes keeps `spaceBefore` and the gap test honours it.
  const positioned: Positioned[] = [];
  let pendingSpace = false;
  for (const i of items) {
    if (typeof i.str !== 'string' || !Array.isArray(i.transform)) continue;
    if (i.str.trim().length === 0) {
      if (i.str.length > 0) pendingSpace = true;
      continue;
    }
    positioned.push({
      str: i.str,
      // pdfjs transform is [scaleX, skewX, skewY, scaleY, translateX, translateY].
      x: i.transform[4] ?? 0,
      y: i.transform[5] ?? 0,
      width: i.width ?? 0,
      // Height can be absent on some producers; the vertical scale is the
      // honest fallback, and 1 keeps the tolerances non-zero either way.
      height: i.height || Math.abs(i.transform[3]) || 1,
      spaceBefore: pendingSpace,
    });
    pendingSpace = false;
  }

  if (positioned.length === 0) return { text: '', openTable: null, continuesTable: false };

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

  // Column and table detection compare gaps across lines and grow faster
  // than the item count when one baseline holds thousands of gapped items.
  // No real page is near these bounds (a dense page is ~5k items, a line a
  // few hundred at one item per glyph); a producer that is gets the plain
  // line-by-line reading rather than a stalled worker.
  if (positioned.length > MAX_LAYOUT_ITEMS || lines.some((l) => l.items.length > MAX_LAYOUT_LINE_ITEMS)) {
    return { text: renderFlow(lines, pitch).join('\n').trim(), openTable: null, continuesTable: false };
  }

  const out: string[] = [];
  const block = (rendered: string[]) => {
    if (rendered.length === 0) return;
    if (out.length > 0 && out[out.length - 1] !== '') out.push('');
    out.push(...rendered);
  };

  const state: TableState = { previous, continued: false, last: null };
  let next = 0;
  for (const band of findColumnBands(lines, charWidth, pitch)) {
    block(renderSequence(lines.slice(next, band.start), pitch, charWidth, state));
    // Column by column. A single newline between columns, not a blank line: a
    // paragraph running off the foot of one column continues at the top of
    // the next, and the chunker keeps a paragraph together.
    // A table at the foot or head of a column still needs its blank line, or
    // the next column's first line would read as one more table row.
    const columns: string[] = [];
    for (const region of band.regions) {
      const regionPitch = region.length > 2 ? medianPitch(region) : pitch;
      const rendered = renderSequence(region, regionPitch || pitch, charWidth, state);
      const isRow = (l: string | undefined) => l?.startsWith('| ') === true;
      if (columns.length > 0 && (isRow(columns[columns.length - 1]) || isRow(rendered[0]))) columns.push('');
      columns.push(...rendered);
    }
    block(columns);
    next = band.end + 1;
  }
  block(renderSequence(lines.slice(next), pitch, charWidth, state));

  const text = out.join('\n').trim();
  // The page ends with a table when nothing but page numbers follows it.
  const tail = text.split('\n');
  while (tail.length > 0 && (tail[tail.length - 1] === '' || isPageNumber(tail[tail.length - 1]))) tail.pop();
  const openTable = tail.length > 0 && tail[tail.length - 1].startsWith('| ') ? state.last : null;
  return { text, openTable, continuesTable: state.continued };
}

/**
 * Rebuild one page's text from positioned items, preserving line breaks,
 * column/cell gaps and paragraph boundaries, reading column bands column by
 * column and tables as Markdown tables. Returns '' for an empty page.
 */
export function reconstructPageText(items: PdfTextItem[]): string {
  return reconstructPage(items).text;
}

/**
 * Pages read in order, as one text: pages apart by a blank line, except where
 * a page continues the table the one before ended with. There the page
 * numbers under the table are dropped and the rows follow on, so the table
 * is one table, under its header, for the chunker to split and repeat.
 */
export function joinPdfPages(pages: PdfPageText[]): string {
  let out = '';
  for (const page of pages) {
    if (!page.text) continue;
    if (out && page.continuesTable && page.text.startsWith('| ')) {
      const kept = out.split('\n');
      while (kept.length > 0 && (kept[kept.length - 1] === '' || isPageNumber(kept[kept.length - 1]))) kept.pop();
      out = `${kept.join('\n')}\n${page.text}`;
    } else {
      out = out ? `${out}\n\n${page.text}` : page.text;
    }
  }
  return out;
}
