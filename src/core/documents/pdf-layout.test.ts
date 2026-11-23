/**
 * Layout-grounded PDF text reconstruction.
 *
 * Items are synthesized rather than read from a fixture PDF: the unit under
 * test is the geometry, and a hand-built page states the exact spacing each
 * case is about. The two cases that motivated the work are the table and the
 * two-column page — both came out of the old `items.join(' ')` as one
 * undifferentiated run.
 */
import { describe, expect, test } from 'vitest';
import { type PdfTextItem, reconstructPageText } from './pdf-layout';

/** One text fragment at (x, y), sized for a ~10pt font. */
const item = (str: string, x: number, y: number, charW = 5, height = 10): PdfTextItem => ({
  str,
  transform: [height, 0, 0, height, x, y],
  width: str.length * charW,
  height,
});

describe('reconstructPageText', () => {
  test('an empty page is empty, not a crash', () => {
    expect(reconstructPageText([])).toBe('');
    expect(reconstructPageText([{ str: '', transform: [10, 0, 0, 10, 0, 0] }])).toBe('');
  });

  test('items on one baseline become one line, in reading order', () => {
    // Deliberately out of order — pdfjs emits in draw order, not visual order.
    // 'Hello' spans x=10..35, so x=40 is an ordinary word space.
    const text = reconstructPageText([
      item('world', 40, 700),
      item('Hello', 10, 700),
    ]);
    expect(text).toBe('Hello world');
  });

  test('a word space and a column gutter are told apart by width', () => {
    const spaced = reconstructPageText([item('a', 10, 700), item('b', 18, 700)]);
    const guttered = reconstructPageText([item('a', 10, 700), item('b', 60, 700)]);
    expect(spaced).toBe('a b');
    expect(guttered).toBe('a  b');
  });

  test('separate baselines become separate lines', () => {
    const text = reconstructPageText([
      item('first line', 10, 700),
      item('second line', 10, 688),
    ]);
    expect(text.split('\n')).toEqual(['first line', 'second line']);
  });

  test('a table row keeps its cells apart', () => {
    // Three cells with wide gutters — the case that used to read as
    // "Widget 42 in stock".
    const text = reconstructPageText([
      item('Widget', 50, 700),
      item('42', 300, 700),
      item('in stock', 450, 700),
    ]);
    expect(text).toBe('Widget  42  in stock');
    // The separation is what matters: something downstream can split on it.
    expect(text.split(/\s{2,}/)).toEqual(['Widget', '42', 'in stock']);
  });

  test('a two-column page keeps the columns from merging into one word run', () => {
    const text = reconstructPageText([
      item('left column text', 50, 700),
      item('right column text', 320, 700),
    ]);
    expect(text).toContain('left column text  right column text');
  });

  test('a wide vertical step starts a new paragraph', () => {
    const text = reconstructPageText([
      item('para one line one', 10, 700),
      item('para one line two', 10, 688),
      item('para two', 10, 650), // >1.6× the 12pt pitch
    ]);
    expect(text).toBe('para one line one\npara one line two\n\npara two');
  });

  test('fragments of one word are not split by a font change', () => {
    // pdfjs emits "Octi" + "pus" when the middle changes font; they abut.
    const text = reconstructPageText([
      { str: 'Octi', transform: [10, 0, 0, 10, 10, 700], width: 20, height: 10 },
      { str: 'pus', transform: [10, 0, 0, 10, 30, 700], width: 15, height: 10 },
    ]);
    expect(text).toBe('Octipus');
  });

  test('a narrow whitespace item is a space, not text and not nothing', () => {
    // At a font change pdfjs reports the word space as a " " item ~1pt wide.
    const text = reconstructPageText([
      { str: 'foo', transform: [10, 0, 0, 10, 50, 700], width: 15, height: 10 },
      { str: ' ', transform: [10, 0, 0, 10, 65, 700], width: 1.1, height: 0 },
      { str: 'bar', transform: [10, 0, 0, 10, 66.1, 700], width: 18, height: 10 },
    ]);
    expect(text).toBe('foo bar');
  });

  test('a heading and body text do not merge just because they are close', () => {
    // A 24pt heading over 10pt body: a fixed baseline tolerance would fold the
    // body line into the heading. The tolerance scales with text height.
    const text = reconstructPageText([
      item('Heading', 10, 700, 12, 24),
      item('body text', 10, 682, 5, 10),
    ]);
    expect(text.split('\n')[0]).toBe('Heading');
    expect(text).toContain('body text');
  });

  test('items missing width or height still reconstruct', () => {
    const text = reconstructPageText([
      { str: 'a', transform: [10, 0, 0, 10, 10, 700] },
      { str: 'b', transform: [10, 0, 0, 10, 40, 700] },
    ]);
    expect(text).toContain('a');
    expect(text).toContain('b');
  });
});

// ── Column bands and tables ─────────────────────────────────────────────────
//
// Pages here are US Letter-ish: 10pt text with 5pt glyphs, a 12pt line pitch.
// A body column runs x=50..275 (45 characters), its neighbour from x=320, so
// the gutter between them is 45pt — nine glyphs — wide.

const FILLER = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor';

/** A prose line of exactly `chars` characters starting with `tag`. */
const prose = (tag: string, chars = 45): string => `${tag} ${FILLER}`.slice(0, chars);

/** `count` prose lines of one column at `x`, from baseline `top` down by `pitch`. */
const column = (tag: string, x: number, top: number, count: number, chars = 45, pitch = 12): PdfTextItem[] =>
  Array.from({ length: count }, (_, k) => item(prose(`${tag}${k + 1}`, chars), x, top - k * pitch));

const lines = (text: string) => text.split('\n');

/** First word of each line, or the whole line for a table row: the reading order at a glance. */
const order = (text: string) => lines(text).map((l) => (l.startsWith('|') ? l : l.split(' ')[0]));

describe('reconstructPageText — column bands', () => {
  test('a two-column page reads the left column, then the right, not across', () => {
    const text = reconstructPageText([...column('L', 50, 700, 6), ...column('R', 320, 700, 6)]);
    expect(lines(text)).toEqual([
      ...Array.from({ length: 6 }, (_, k) => prose(`L${k + 1}`)),
      ...Array.from({ length: 6 }, (_, k) => prose(`R${k + 1}`)),
    ]);
    // A body is not a table, however well its rows line up.
    expect(text).not.toContain('|');
  });

  test('full-width title, caption and footer interrupt the body and split it into bands', () => {
    const text = reconstructPageText([
      item('A Study of Layout', 250, 760), // centred: crosses the gutter
      ...column('A', 50, 730, 4),
      ...column('B', 320, 730, 4),
      item(`Figure 1: ${FILLER} ${FILLER}`.slice(0, 100), 50, 670), // full width
      ...column('C', 50, 640, 3),
      ...column('D', 320, 640, 3),
      item('Page 3', 290, 560), // centred footer, well below
    ]);
    expect(order(text)).toEqual([
      'A', '', 'A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4', '',
      'Figure', '', 'C1', 'C2', 'C3', 'D1', 'D2', 'D3', '', 'Page',
    ]);
  });

  test('three columns read in order', () => {
    // Columns of 30 characters (150pt) at x=50, 230, 410: 30pt gutters.
    const text = reconstructPageText([
      ...column('P', 50, 700, 5, 30),
      ...column('Q', 230, 700, 5, 30),
      ...column('S', 410, 700, 5, 30),
    ]);
    expect(order(text)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'S1', 'S2', 'S3', 'S4', 'S5']);
  });

  test('a paragraph break inside a column survives', () => {
    const text = reconstructPageText([
      ...column('L', 50, 700, 3),
      ...column('M', 50, 652, 3), // a 24pt step after L3: a new paragraph
      ...column('R', 320, 700, 6),
    ]);
    expect(order(text)).toEqual(['L1', 'L2', 'L3', '', 'M1', 'M2', 'M3', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
  });

  test('columns whose baselines drift apart still read as columns once three lines line up', () => {
    // The first three lines share baselines; after that the right column is
    // offset by half a line, so its lines group on their own.
    const text = reconstructPageText([
      ...column('L', 50, 700, 6),
      ...column('R', 320, 700, 3),
      ...column('S', 320, 658, 3),
    ]);
    expect(order(text)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'R1', 'R2', 'R3', 'S1', 'S2', 'S3']);
  });

  test('a page with no columns comes out exactly as before', () => {
    const text = reconstructPageText([...column('A', 50, 700, 3, 90), item('B1 the next paragraph', 50, 650)]);
    expect(text).toBe(`${prose('A1', 90)}\n${prose('A2', 90)}\n${prose('A3', 90)}\n\nB1 the next paragraph`);
  });

  test('a wide inter-word gap on a justified line is not a gutter', () => {
    // One item per word, as producers that justify by word spacing emit them.
    const words = (text: string, y: number, stretchAfter = -1): PdfTextItem[] => {
      let x = 50;
      return text.split(' ').map((w, k) => {
        const it = item(w, x, y);
        x += w.length * 5 + (k === stretchAfter ? 15 : 5);
        return it;
      });
    };
    const text = reconstructPageText([
      ...words('the quick brown fox jumps over the lazy dog again', 700),
      ...words('and so the story goes on for a while longer here', 688, 3),
      ...words('until the end of the paragraph is finally reached', 676, 3),
      ...words('with nothing much else to say about it at all now', 664),
    ]);
    // Two lines with a wide gap, and not in the same place: no gutter.
    expect(lines(text)).toEqual([
      'the quick brown fox jumps over the lazy dog again',
      'and so the story  goes on for a while longer here',
      'until the end of  the paragraph is finally reached',
      'with nothing much else to say about it at all now',
    ]);
  });

  test('three justified lines with a wide word gap in the same place are not two columns', () => {
    // 12pt is a loose word space at 10pt type, just over the 9pt cell-gap
    // test; lined up on three lines it looked like a gutter.
    const left = (k: number) => prose(`J${k}`, 37);
    const rightPart = (k: number) => `tail ${k} ${FILLER}`.slice(0, 36);
    const text = reconstructPageText([
      ...[0, 1, 2].flatMap((k) => [item(left(k), 50, 700 - k * 12), item(rightPart(k), 50 + 37 * 5 + 12, 700 - k * 12)]),
      item(prose('J3', 75), 50, 664),
    ]);
    expect(lines(text)).toEqual([0, 1, 2].map((k) => `${left(k)}  ${rightPart(k)}`).concat(prose('J3', 75)));
  });

  test('a narrow gutter still makes columns once it holds over six lines', () => {
    // 11pt, about LaTeX's two-column gutter at 10pt type.
    const text = reconstructPageText([...column('L', 50, 700, 6), ...column('R', 286, 700, 6)]);
    expect(order(text)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
  });

  test('two columns of short lines are neither columns nor a table', () => {
    // A list set in two columns: too short for prose, no header for a table.
    const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin'];
    const text = reconstructPageText(names.flatMap((n, k) => [item(n, 50, 700 - k * 12), item(`${n} Jr`, 320, 700 - k * 12)]));
    expect(lines(text)).toEqual(names.map((n) => `${n}  ${n} Jr`));
  });
});

/** A table row: each cell [text, x], or [text, x, 'right'] to end at x. Empty text is an empty cell. */
const row = (y: number, cells: Array<[string, number, 'right'?]>): PdfTextItem[] =>
  cells.filter(([s]) => s.length > 0).map(([s, x, align]) => item(s, align === 'right' ? x - s.length * 5 : x, y));

describe('reconstructPageText — tables', () => {
  test('a table with a header, an empty cell and a right-aligned number column becomes a Markdown table', () => {
    const text = reconstructPageText([
      item('Stock report', 50, 730),
      ...row(700, [['Item', 50], ['Colour', 200], ['Qty', 400, 'right']]),
      ...row(688, [['Widget', 50], ['Red', 200], ['1,200', 400, 'right']]),
      ...row(676, [['Gadget', 50], ['', 200], ['35', 400, 'right']]),
      ...row(664, [['Sprocket', 50], ['Blue', 200], ['7', 400, 'right']]),
      item('Figures as of Monday.', 50, 640),
    ]);
    expect(text).toBe(
      [
        'Stock report',
        '',
        '| Item | Colour | Qty |',
        '| --- | --- | ---: |',
        '| Widget | Red | 1,200 |',
        '| Gadget |  | 35 |',
        '| Sprocket | Blue | 7 |',
        '',
        'Figures as of Monday.',
      ].join('\n'),
    );
  });

  test('a wrapped cell joins its row when rows are spaced wider than lines', () => {
    const text = reconstructPageText([
      ...row(700, [['Part', 50], ['Notes', 200], ['Cost', 400, 'right']]),
      ...row(682, [['Bolt', 50], ['zinc plated', 200], ['4', 400, 'right']]),
      ...row(672, [['', 50], ['steel', 200]]), // 10pt under its row; rows are 18pt apart
      ...row(654, [['Nut', 50], ['brass', 200], ['2', 400, 'right']]),
      ...row(636, [['Washer', 50], ['nylon', 200], ['1', 400, 'right']]),
    ]);
    expect(lines(text)).toEqual([
      '| Part | Notes | Cost |',
      '| --- | --- | ---: |',
      '| Bolt | zinc plated steel | 4 |',
      '| Nut | brass | 2 |',
      '| Washer | nylon | 1 |',
    ]);
  });

  test('a pipe inside a cell is escaped', () => {
    const text = reconstructPageText([
      ...row(700, [['Flag', 50], ['Meaning', 200], ['Code', 400]]),
      ...row(688, [['a|b', 50], ['either', 200], ['1', 400]]),
      ...row(676, [['c', 50], ['plain', 200], ['2', 400]]),
      ...row(664, [['d', 50], ['other', 200], ['3', 400]]),
    ]);
    expect(lines(text)[2]).toBe('| a\\|b | either | 1 |');
  });

  test('a two-column table with a header and numbers is a table', () => {
    const text = reconstructPageText([
      ...row(700, [['Region', 50], ['Revenue', 300, 'right']]),
      ...row(688, [['North', 50], ['1,200', 300, 'right']]),
      ...row(676, [['South', 50], ['950', 300, 'right']]),
      ...row(664, [['West', 50], ['80', 300, 'right']]),
    ]);
    expect(lines(text).slice(0, 2)).toEqual(['| Region | Revenue |', '| --- | ---: |']);
  });

  test('a label/value form keeps its label  value lines', () => {
    const text = reconstructPageText([
      ...row(700, [['Name:', 50], ['Jane Doe', 200]]),
      ...row(688, [['Invoice:', 50], ['INV-0042', 200]]),
      ...row(676, [['Date:', 50], ['2026-11-02', 200]]),
      ...row(664, [['Total:', 50], ['$420.00', 200]]),
    ]);
    expect(lines(text)).toEqual(['Name:  Jane Doe', 'Invoice:  INV-0042', 'Date:  2026-11-02', 'Total:  $420.00']);
  });

  test('a key/value list without colons and without a header stays as lines', () => {
    const text = reconstructPageText([
      ...row(700, [['Invoice number', 50], ['INV-0042', 200]]),
      ...row(688, [['Issued', 50], ['2026-11-02', 200]]),
      ...row(676, [['Due', 50], ['2026-12-02', 200]]),
    ]);
    expect(lines(text)).toEqual(['Invoice number  INV-0042', 'Issued  2026-11-02', 'Due  2026-12-02']);
  });

  test.each(['•', '-', '–', '*', '▪', '☐'])('a list bulleted with %s keeps its lines', (bullet) => {
    const entries = ['Flour', '2 eggs', '1 cup milk', '50 g butter', '3 tbsp sugar'];
    const text = reconstructPageText(entries.flatMap((e, k) => [item(bullet, 50, 700 - k * 12), item(e, 68, 700 - k * 12)]));
    expect(lines(text)).toEqual(entries.map((e) => `${bullet}  ${e}`));
  });

  test('a numbered list keeps its lines', () => {
    const entries = ['Preheat the oven', 'Mix 2 eggs', 'Bake 40 min'];
    const text = reconstructPageText(entries.flatMap((e, k) => [item(`${k + 1}.`, 50, 700 - k * 12), item(e, 75, 700 - k * 12)]));
    expect(text).not.toContain('|');
  });

  test('a table of contents is not a table', () => {
    const toc: Array<[string, string]> = [
      ['Foreword', 'vii'],
      ['Preface', 'ix'],
      ['Introduction', '1'],
      ['Methods', '14'],
      ['Results', '37'],
    ];
    const plain = reconstructPageText(toc.flatMap(([t, p], k) => row(700 - k * 12, [[t, 50], [p, 400, 'right']])));
    expect(lines(plain)).toEqual(toc.map(([t, p]) => `${t}  ${p}`));
    // Dot leaders inside the title item, and as items of their own.
    const dotted = reconstructPageText(toc.flatMap(([t, p], k) => row(700 - k * 12, [[`${t} . . . . . . . .`, 50], [p, 400, 'right']])));
    expect(dotted).not.toContain('|');
    const leaders = reconstructPageText(
      toc.flatMap(([t, p], k) => row(700 - k * 12, [[t, 50], ['.'.repeat(30 - t.length), 200], [p, 400, 'right']])),
    );
    expect(leaders).not.toContain('|');
  });

  test('two rows are not a table', () => {
    const text = reconstructPageText([
      ...row(700, [['Item', 50], ['Colour', 200], ['Qty', 400]]),
      ...row(688, [['Widget', 50], ['Red', 200], ['12', 400]]),
    ]);
    expect(lines(text)).toEqual(['Item  Colour  Qty', 'Widget  Red  12']);
  });

  test('cells that do not line up are not a table', () => {
    // Gaps stay clear of each other, but each cell starts and ends somewhere new.
    const text = reconstructPageText([
      ...row(700, [['ab', 50], ['cdefgh', 180], ['ij', 400]]),
      ...row(688, [['klmnopq', 70], ['uv', 260], ['wxyzabcde', 430]]),
      ...row(676, [['c', 100], ['defghij', 200], ['no', 480]]),
    ]);
    expect(text).not.toContain('|');
  });

  test('a full-width table between two column bands reads band, table, band', () => {
    const text = reconstructPageText([
      ...column('A', 50, 760, 3),
      ...column('B', 320, 760, 3),
      // The table's middle column sits on the body's gutter.
      ...row(716, [['Metric', 50], ['Baseline', 280], ['Score (F1)', 500, 'right']]),
      ...row(704, [['Recall', 50], ['0.61', 280], ['0.74', 500, 'right']]),
      ...row(692, [['Precision', 50], ['0.58', 280], ['0.69', 500, 'right']]),
      ...column('C', 50, 670, 3),
      ...column('D', 320, 670, 3),
    ]);
    expect(order(text)).toEqual([
      'A1', 'A2', 'A3', 'B1', 'B2', 'B3', '',
      '| Metric | Baseline | Score (F1) |',
      '| --- | --- | ---: |',
      '| Recall | 0.61 | 0.74 |',
      '| Precision | 0.58 | 0.69 |',
      '', 'C1', 'C2', 'C3', 'D1', 'D2', 'D3',
    ]);
  });

  test('a table inside one column of a two-column page is a table within that column', () => {
    const text = reconstructPageText([
      ...column('L', 50, 700, 3),
      ...row(664, [['Key', 50], ['Low', 140], ['High', 240]]),
      ...row(652, [['a', 50], ['1', 140], ['9', 240]]),
      ...row(640, [['b', 50], ['2', 140], ['8', 240]]),
      ...row(628, [['c', 50], ['3', 140], ['7', 240]]),
      ...column('R', 320, 700, 7),
    ]);
    expect(order(text)).toEqual([
      'L1', 'L2', 'L3', '',
      '| Key | Low | High |',
      '| --- | --- | --- |',
      '| a | 1 | 9 |',
      '| b | 2 | 8 |',
      '| c | 3 | 7 |',
      '', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7',
    ]);
  });

  test('a large page stays fast', () => {
    // 60 lines of two columns over a 40-row table.
    const big = [
      ...column('L', 50, 760, 60, 45, 6),
      ...column('R', 320, 760, 60, 45, 6),
      ...row(388, [['Name', 50], ['Count', 200], ['Double', 400, 'right']]),
      ...Array.from({ length: 40 }, (_, k) => row(380 - k * 8, [[`r${k}`, 50], [`${k}`, 200], [`${k * 2}`, 400, 'right']])).flat(),
    ];
    const started = performance.now();
    const text = reconstructPageText(big);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(text).toContain('| r1 | 1 | 2 |');
  });

  test('a page with a huge number of items takes the plain path, fast', () => {
    // 20,000 gapped items on one baseline (a pathological producer): column
    // and table detection are skipped, and the line reads as it always did.
    const many = Array.from({ length: 20000 }, (_, k) => item('ab', 50 + k * 30, 700));
    const started = performance.now();
    const text = reconstructPageText(many);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(text.split('  ').length).toBe(20000);
  });

  test('a dense grid just under those bounds is still bounded', () => {
    // 20 lines of 499 gapped items: ~500 persistent gutters. Pairing every
    // gutter run with every other took ~7.7s; they are now not paired at all.
    // The bound is loose because coverage and a busy runner slow this ~10x;
    // the unbounded version takes far longer under the same conditions.
    const grid = Array.from({ length: 20 }, (_, l) => Array.from({ length: 499 }, (_, k) => item('ab', 50 + k * 30, 700 - l * 12))).flat();
    const started = performance.now();
    reconstructPageText(grid);
    expect(performance.now() - started).toBeLessThan(6000);
  });

  test('a long run that is neither columns nor a table stays fast', () => {
    // Every line starts a candidate table that runs to the foot of the page
    // and is then refused (two columns, no header): the worst case for the scan.
    const list = Array.from({ length: 400 }, (_, k) => row(780 - k * 1.9, [[`name ${k}`, 50], [`other ${k}`, 320]])).flat();
    const started = performance.now();
    const text = reconstructPageText(list.map((it) => ({ ...it, height: 1.5 })));
    // Retried from every line this took ~250ms; bounded retries take ~30ms.
    expect(performance.now() - started).toBeLessThan(2000);
    expect(text).not.toContain('|');
  });
});
