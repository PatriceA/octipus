/**
 * End to end through pdfjs: a PDF built byte by byte here, read back with the
 * same `getTextContent` call the processor makes, then reconstructed.
 *
 * The synthetic-item tests in `pdf-layout.test.ts` state the geometry exactly;
 * these catch what only the real extractor does — such as the whitespace-only
 * filler items pdfjs inserts between two runs, which span the gap they sit in.
 */
import { describe, expect, test } from 'vitest';
import { joinPdfPages, type PdfPageText, type PdfTextItem, reconstructPage, reconstructPageText } from './pdf-layout';

/** [text, x, y] drawn in 10pt Helvetica. */
type Run = [string, number, number];

const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

/** Each run drawn with its own text object. */
const runsContent = (runs: Run[]): string =>
  runs.map(([s, x, y]) => `BT /F1 10 Tf ${x} ${y} Td (${esc(s)}) Tj ET`).join('\n');

/** A PDF (US Letter) with one page per content stream; /F1 is Helvetica, /F2 Courier. */
function buildPdf(contents: string[]): Uint8Array {
  // Objects 1-4 are the catalog, the page tree and the two fonts; each page
  // is then a page object followed by its content stream.
  const pageRef = (p: number) => `${5 + p * 2} 0 R`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${contents.map((_, p) => pageRef(p)).join(' ')}] /Count ${contents.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    ...contents.flatMap((content, p) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + p * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    ]),
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

async function extract(runs: Run[] | string): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const stream = typeof runs === 'string' ? runs : runsContent(runs);
  const task = pdfjsLib.getDocument({ data: buildPdf([stream]), verbosity: 0 });
  const pdf = await task.promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  const text = reconstructPageText(content.items as PdfTextItem[]);
  await task.destroy();
  return text;
}

/** Every page, read in order with the table each leaves open, and joined: what the processor does. */
async function extractPages(pages: Run[][]): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjsLib.getDocument({ data: buildPdf(pages.map(runsContent)), verbosity: 0 });
  const pdf = await task.promise;
  const read: PdfPageText[] = [];
  let open: PdfPageText['openTable'] = null;
  for (let p = 1; p <= pdf.numPages; p++) {
    const content = await (await pdf.getPage(p)).getTextContent();
    const page = reconstructPage(content.items as PdfTextItem[], open);
    open = page.openTable;
    read.push(page);
  }
  await task.destroy();
  return joinPdfPages(read);
}

describe('reconstructPageText on pdfjs output', () => {
  test('the filler space pdfjs puts across a gap does not erase the gap', async () => {
    // pdfjs reports this line as three items: the left run, a " " whose width
    // spans the whole gutter, and the right run. Counted as text, the filler
    // closed the gap and the two runs read as one sentence.
    const text = await extract([
      ['Widget', 50, 700],
      ['in stock', 320, 700],
    ]);
    expect(text).toBe('Widget  in stock');
  });

  test('a word space at a font change is kept, though pdfjs reports it as a narrow filler', async () => {
    // pdfjs puts the space between two fonts in a " " item about 1pt wide:
    // narrower than the word-gap test, so dropping it glued the words.
    expect(await extract('BT /F1 10 Tf 50 700 Td [(foo) -110] TJ /F2 10 Tf (bar) Tj ET')).toBe('foo bar');
    expect(
      await extract('BT /F2 10 Tf 50 700 Td [(code) -105] TJ /F1 10 Tf [(word) -160] TJ /F2 10 Tf (more) Tj ET'),
    ).toBe('code word more');
  });

  test('a two-column page under a title reads title, left column, right column', async () => {
    const left = [
      'Layout matters for retrieval because a',
      'chunk that interleaves two columns says',
      'nothing a reader could ever have read.',
      'Each column is its own flow of text.',
    ];
    const right = [
      'The right column continues the thought',
      'and only makes sense after the left one',
      'has been read from its top to its foot.',
      'Reading across mixes the two of them.',
    ];
    const text = await extract([
      ['Reading Order in Two-Column Pages', 220, 760],
      ...left.map((s, k): Run => [s, 50, 720 - k * 12]),
      ...right.map((s, k): Run => [s, 320, 720 - k * 12]),
    ]);
    expect(text).toBe(['Reading Order in Two-Column Pages', '', ...left, ...right].join('\n'));
  });

  test('a table comes out as a Markdown table', async () => {
    const rows: Array<[string, string, string]> = [
      ['Plan', 'Seats', 'Price'],
      ['Starter', '5', '$10'],
      ['Team', '25', '$45'],
      ['Business', '100', '$160'],
    ];
    const text = await extract([
      ['Pricing', 50, 760],
      ...rows.flatMap(([a, b, c], k): Run[] => [
        [a, 50, 730 - k * 14],
        [b, 200, 730 - k * 14],
        [c, 350, 730 - k * 14],
      ]),
    ]);
    expect(text).toBe(
      [
        'Pricing',
        '',
        '| Plan | Seats | Price |',
        '| --- | --- | --- |',
        '| Starter | 5 | $10 |',
        '| Team | 25 | $45 |',
        '| Business | 100 | $160 |',
      ].join('\n'),
    );
  });

  /** Three cells per row at x = 50, 200, 350, rows 14pt apart from `top`. */
  const tableRuns = (top: number, rows: Array<[string, string, string]>): Run[] =>
    rows.flatMap(([a, b, c], k): Run[] => [
      [a, 50, top - k * 14],
      [b, 200, top - k * 14],
      [c, 350, top - k * 14],
    ]);

  test('a table with no header row comes out under an empty header', async () => {
    const text = await extract(
      tableRuns(730, [
        ['Starter', '5', '$10'],
        ['Team', '25', '$45'],
        ['Business', '100', '$160'],
        ['Enterprise', '500', '$600'],
      ]),
    );
    expect(text).toBe(
      [
        '| | | |',
        '| --- | --- | --- |',
        '| Starter | 5 | $10 |',
        '| Team | 25 | $45 |',
        '| Business | 100 | $160 |',
        '| Enterprise | 500 | $600 |',
      ].join('\n'),
    );
  });

  test('a table continued on the next page without its header is one table', async () => {
    const text = await extractPages([
      [
        ['Pricing', 50, 760],
        ...tableRuns(730, [
          ['Plan', 'Seats', 'Price'],
          ['Starter', '5', '$10'],
          ['Team', '25', '$45'],
        ]),
        ['1', 300, 40],
      ],
      [
        ['2', 300, 770],
        ...tableRuns(740, [
          ['Business', '100', '$160'],
          ['Enterprise', '500', '$600'],
        ]),
        ['Prices exclude tax.', 50, 690],
      ],
    ]);
    expect(text).toBe(
      [
        'Pricing',
        '',
        '| Plan | Seats | Price |',
        '| --- | --- | --- |',
        '| Starter | 5 | $10 |',
        '| Team | 25 | $45 |',
        '| Business | 100 | $160 |',
        '| Enterprise | 500 | $600 |',
        '',
        'Prices exclude tax.',
      ].join('\n'),
    );
  });
});
