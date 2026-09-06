/**
 * The markdown parser and the two writers.
 *
 * The docx assertions deliberately go through `mammoth` — the same library the
 * document processor uses to READ Word files. Hand-checking the XML would only
 * prove the strings are what this file wrote; converting the package back to
 * markdown proves a real Word reader can open it, which is the only property
 * that matters for a file the user is going to send to a client.
 */
import { describe, expect, it } from 'vitest';
import {
  DocumentExportError,
  markdownToDocx,
  markdownToSheets,
  sheetName,
  sheetsToXlsx,
} from './export';
import { parseInline, parseMarkdown, runsToText } from './markdown';

async function docxToMarkdown(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.convertToMarkdown({ buffer });
  return result.value;
}

describe('parseInline', () => {
  it('reads bold, italic and code', () => {
    expect(parseInline('a **b** c *d* e `f`')).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' c ' },
      { text: 'd', italic: true },
      { text: ' e ' },
      { text: 'f', code: true },
    ]);
  });

  it('does not read emphasis inside a code span', () => {
    expect(parseInline('`**a**`')).toEqual([{ text: '**a**', code: true }]);
  });

  it('keeps a link label and its destination', () => {
    expect(runsToText(parseInline('see [the docs](https://example.com)')))
      .toBe('see the docs (https://example.com)');
  });

  it('does not repeat a bare link', () => {
    expect(runsToText(parseInline('[https://x.dev](https://x.dev)'))).toBe('https://x.dev');
  });
});

describe('parseMarkdown', () => {
  it('reads headings, paragraphs and rules', () => {
    const blocks = parseMarkdown('# Title\n\nSome text.\n\n---\n');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'rule']);
    expect(blocks[0]).toMatchObject({ level: 1 });
  });

  it('joins a wrapped paragraph into one block', () => {
    const blocks = parseMarkdown('one\ntwo\n\nthree');
    expect(blocks).toHaveLength(2);
    if (blocks[0].kind !== 'paragraph') throw new Error('expected a paragraph');
    expect(runsToText(blocks[0].runs)).toBe('one two');
  });

  it('reads a nested bullet list', () => {
    const [list] = parseMarkdown('- a\n  - b\n- c');
    expect(list.kind).toBe('list');
    if (list.kind !== 'list') throw new Error('expected a list');
    expect(list.ordered).toBe(false);
    expect(list.items.map((i) => i.level)).toEqual([0, 1, 0]);
  });

  it('keeps an ordered list separate from a bullet list', () => {
    const blocks = parseMarkdown('1. a\n2. b\n\n- c');
    expect(blocks.map((b) => b.kind)).toEqual(['list', 'list']);
    expect((blocks[0] as { ordered: boolean }).ordered).toBe(true);
    expect((blocks[1] as { ordered: boolean }).ordered).toBe(false);
  });

  it('reads a table and names it after the heading above it', () => {
    const blocks = parseMarkdown('## Q1 revenue\n\n| Region | Total |\n| --- | ---: |\n| EMEA | 10 |\n');
    const table = blocks.find((b) => b.kind === 'table');
    expect(table).toBeDefined();
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(table.caption).toBe('Q1 revenue');
    expect(table.header.map(runsToText)).toEqual(['Region', 'Total']);
    expect(table.rows[0].map(runsToText)).toEqual(['EMEA', '10']);
  });

  it('squares off a ragged table row', () => {
    const [table] = parseMarkdown('| a | b | c |\n| - | - | - |\n| 1 |\n');
    if (table.kind !== 'table') throw new Error('expected a table');
    expect(table.rows[0]).toHaveLength(3);
  });

  it('keeps a fenced code block verbatim', () => {
    const [code] = parseMarkdown('```ts\nconst a = 1;\n# not a heading\n```');
    expect(code).toEqual({ kind: 'code', text: 'const a = 1;\n# not a heading', language: 'ts' });
  });

  it('reads a block quote', () => {
    const [quote] = parseMarkdown('> a\n> b');
    if (quote.kind !== 'quote') throw new Error('expected a quote');
    expect(runsToText(quote.runs)).toBe('a b');
  });
});

describe('markdownToDocx', () => {
  it('produces a package a Word reader can open', async () => {
    const buffer = await markdownToDocx(
      '# Quarterly review\n\nRevenue grew **12%** this quarter.\n\n## Regions\n\n- EMEA\n- APAC\n\n| Region | Total |\n| --- | --- |\n| EMEA | 10 |\n| APAC | 20 |\n',
      { title: 'Quarterly review' },
    );
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');

    const round = await docxToMarkdown(buffer);
    expect(round).toContain('# Quarterly review');
    expect(round).toContain('## Regions');
    expect(round).toContain('__12%__');
    expect(round).toContain('EMEA');
    expect(round).toContain('APAC');
  }, 30_000);

  it('adds the title as a heading when the markdown has none', async () => {
    const buffer = await markdownToDocx('Just a sentence.', { title: 'Untitled report' });
    const round = await docxToMarkdown(buffer);
    expect(round).toContain('# Untitled report');
    // mammoth escapes the full stop on the way back out, so match the words.
    expect(round).toContain('Just a sentence');
  }, 30_000);

  it('does not repeat a title the markdown already opens with', async () => {
    const buffer = await markdownToDocx('# Report\n\nBody.', { title: 'Report' });
    const round = await docxToMarkdown(buffer);
    expect(round.match(/# Report/g)).toHaveLength(1);
  }, 30_000);

  it('keeps code block line breaks', async () => {
    const buffer = await markdownToDocx('```\nline one\nline two\n```', { title: 'Code' });
    const round = await docxToMarkdown(buffer);
    expect(round).toContain('line one');
    expect(round).toContain('line two');
  }, 30_000);

  it('escapes markup that would otherwise break the XML', async () => {
    const buffer = await markdownToDocx('A & B <tag> "quoted"', { title: 'Escapes' });
    const round = await docxToMarkdown(buffer);
    expect(round).toContain('A & B <tag> "quoted"');
  }, 30_000);

  it('refuses an empty document', async () => {
    await expect(markdownToDocx('   ', { title: 'Empty' })).rejects.toThrow(DocumentExportError);
  });
});

describe('sheetName', () => {
  it('strips the characters Excel forbids and caps the length', () => {
    const taken = new Set<string>();
    expect(sheetName('Q1: revenue/costs [draft]', taken)).toBe('Q1 revenue costs draft');
    expect(sheetName('x'.repeat(40), taken)).toHaveLength(31);
  });

  it('disambiguates a repeat instead of overwriting it', () => {
    const taken = new Set<string>();
    expect(sheetName('Totals', taken)).toBe('Totals');
    expect(sheetName('Totals', taken)).toBe('Totals (2)');
  });
});

describe('markdownToSheets', () => {
  it('makes one sheet per table, named after its heading', () => {
    const sheets = markdownToSheets(
      '## Revenue\n\n| Region | Total |\n| - | - |\n| EMEA | 10 |\n\n## Costs\n\n| Item | Amount |\n| - | - |\n| Cloud | 4.5 |\n',
    );
    expect(sheets.map((s) => s.name)).toEqual(['Revenue', 'Costs']);
    expect(sheets[0].rows).toEqual([['Region', 'Total'], ['EMEA', 10]]);
    expect(sheets[1].rows[1]).toEqual(['Cloud', 4.5]);
  });

  it('keeps a leading zero as text rather than losing it', () => {
    const sheets = markdownToSheets('| Phone |\n| - |\n| 0207123456 |\n');
    expect(sheets[0].rows[1]).toEqual(['0207123456']);
  });

  it('numbers a table with no heading above it', () => {
    const sheets = markdownToSheets('| a |\n| - |\n| 1 |\n');
    expect(sheets[0].name).toBe('Table 1');
  });
});

describe('sheetsToXlsx', () => {
  it('writes a workbook SheetJS can read back', async () => {
    const buffer = await sheetsToXlsx(markdownToSheets(
      '## Revenue\n\n| Region | Total |\n| - | - |\n| EMEA | 10 |\n| APAC | 20 |\n',
    ));
    const XLSX = await import('xlsx');
    const book = XLSX.read(buffer, { type: 'buffer' });
    expect(book.SheetNames).toEqual(['Revenue']);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets.Revenue, { header: 1 });
    expect(rows).toEqual([['Region', 'Total'], ['EMEA', 10], ['APAC', 20]]);
  }, 30_000);

  it('says what is missing when the markdown has no table', async () => {
    await expect(sheetsToXlsx(markdownToSheets('# Just prose\n\nNo tables here.')))
      .rejects.toThrow(/at least one markdown table/);
  });
});
