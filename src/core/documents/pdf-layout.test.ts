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
