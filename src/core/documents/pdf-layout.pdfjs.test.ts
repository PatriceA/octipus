/**
 * End to end through pdfjs: a PDF built byte by byte here, read back with the
 * same `getTextContent` call the processor makes, then reconstructed.
 *
 * The synthetic-item tests in `pdf-layout.test.ts` state the geometry exactly;
 * these catch what only the real extractor does — such as the whitespace-only
 * filler items pdfjs inserts between two runs, which span the gap they sit in.
 */
import { describe, expect, test } from 'vitest';
import { type PdfTextItem, reconstructPageText } from './pdf-layout';

/** [text, x, y] drawn in 10pt Helvetica. */
type Run = [string, number, number];

/** A one-page PDF (US Letter) drawing each run with its own text object. */
function buildPdf(runs: Run[]): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = runs.map(([s, x, y]) => `BT /F1 10 Tf ${x} ${y} Td (${esc(s)}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
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

async function extract(runs: Run[]): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjsLib.getDocument({ data: buildPdf(runs), verbosity: 0 });
  const pdf = await task.promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  const text = reconstructPageText(content.items as PdfTextItem[]);
  await task.destroy();
  return text;
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
});
