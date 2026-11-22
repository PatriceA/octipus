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
});
