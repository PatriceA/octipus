import { describe, expect, test } from 'bun:test';
import type { ToolboxContext } from '../types';
import { csvExporter } from './csv';
import { jsonExporter } from './json';
import { markdownExporter } from './markdown';

const ctx: ToolboxContext = { principalId: '', workspaceId: '' };

describe('art_export_csv', () => {
  test('emits header + rows in column order', async () => {
    const out = await csvExporter.execute(
      { rows: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }], columns: ['a', 'b'] },
      ctx,
    );
    expect(out.contentType).toBe('text/csv; charset=utf-8');
    expect(out.body).toBe('a,b\r\n1,x\r\n2,y\r\n');
  });
  test('quotes values containing comma, quote, or newline', async () => {
    const out = await csvExporter.execute(
      { rows: [{ a: 'has,comma' }, { a: 'has"quote' }, { a: 'has\nnewline' }], columns: ['a'] },
      ctx,
    );
    expect(out.body).toContain('"has,comma"');
    expect(out.body).toContain('"has""quote"');
    expect(out.body).toContain('"has\nnewline"');
  });
  test('auto-picks columns from first row', async () => {
    const out = await csvExporter.execute({ rows: [{ x: 1, y: 2 }] }, ctx);
    expect(out.body.startsWith('x,y')).toBe(true);
  });
  test('stringifies nested values', async () => {
    const out = await csvExporter.execute(
      { rows: [{ a: { nested: true } }], columns: ['a'] },
      ctx,
    );
    expect(out.body).toContain('"{""nested"":true}"');
  });
  test('appends .csv to filename', async () => {
    const a = await csvExporter.execute({ rows: [], filename: 'foo' }, ctx);
    const b = await csvExporter.execute({ rows: [], filename: 'foo.csv' }, ctx);
    expect(a.filename).toBe('foo.csv');
    expect(b.filename).toBe('foo.csv');
  });
});

describe('art_export_json', () => {
  test('pretty-prints by default', async () => {
    const out = await jsonExporter.execute({ data: { a: 1 } }, ctx);
    expect(out.contentType).toBe('application/json; charset=utf-8');
    expect(out.body).toContain('\n');
    expect(out.body).toContain('  ');
  });
  test('indent=0 yields single line', async () => {
    const out = await jsonExporter.execute({ data: { a: 1 }, indent: 0 }, ctx);
    expect(out.body).toBe('{"a":1}');
  });
  test('clamps indent to a reasonable range', async () => {
    const out = await jsonExporter.execute({ data: { a: 1 }, indent: 99 }, ctx);
    // 8-space indent
    expect(out.body).toContain('        "a"');
  });
});

describe('art_export_markdown', () => {
  test('renders a markdown table', async () => {
    const out = await markdownExporter.execute(
      { rows: [{ a: 1, b: 'x' }], columns: ['a', 'b'], title: 'T' },
      ctx,
    );
    expect(out.contentType).toBe('text/markdown; charset=utf-8');
    expect(out.body).toContain('# T');
    expect(out.body).toContain('| a | b |');
    expect(out.body).toContain('| 1 | x |');
  });
  test('escapes pipes', async () => {
    const out = await markdownExporter.execute({ rows: [{ a: 'a|b' }] }, ctx);
    expect(out.body).toContain('a\\|b');
  });
});
