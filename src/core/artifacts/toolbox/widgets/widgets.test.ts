import { describe, expect, test } from 'bun:test';
import type { ToolboxContext } from '../types';
import { barChartWidget } from './bar_chart';
import { jsonTreeWidget } from './json_tree';
import { kpiCardWidget } from './kpi_card';
import { listWidget } from './list';
import { markdownWidget } from './markdown';
import { tableWidget } from './table';

const ctx: ToolboxContext = { principalId: '', workspaceId: '' };

describe('art_widget_table', () => {
  test('renders rows with picked columns', async () => {
    const out = await tableWidget.execute(
      { rows: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }], columns: ['a', 'b'] },
      ctx,
    );
    expect(out.html).toContain('<th>A</th>');
    expect(out.html).toContain('<td>1</td>');
    expect(out.html).toContain('<td>y</td>');
  });
  test('escapes cell content', async () => {
    const out = await tableWidget.execute({ rows: [{ a: '<script>' }] }, ctx);
    expect(out.html).toContain('&lt;script&gt;');
  });
  test('shows empty text on empty rows', async () => {
    const out = await tableWidget.execute({ rows: [], emptyText: 'nothing' }, ctx);
    expect(out.html).toContain('nothing');
  });
});

describe('art_widget_list', () => {
  test('renders title + link + summary', async () => {
    const out = await listWidget.execute(
      { items: [{ title: 'Hello', link: 'https://x/y', summary: 'sub' }] },
      ctx,
    );
    expect(out.html).toContain('href="https://x/y"');
    expect(out.html).toContain('Hello');
    expect(out.html).toContain('sub');
  });
  test('omits link when missing', async () => {
    const out = await listWidget.execute({ items: [{ title: 'Plain' }] }, ctx);
    expect(out.html).not.toContain('href');
    expect(out.html).toContain('Plain');
  });
});

describe('art_widget_kpi_card', () => {
  test('formats numbers with precision', async () => {
    const out = await kpiCardWidget.execute({ value: 12.345, precision: 1, label: 'V' }, ctx);
    expect(out.html).toContain('12.3');
    expect(out.html).toContain('V');
  });
  test('shows positive delta in pos class', async () => {
    const out = await kpiCardWidget.execute({ value: 1, delta: '+5' }, ctx);
    expect(out.html).toContain('aw-kpi-delta pos');
  });
  test('shows negative delta in neg class', async () => {
    const out = await kpiCardWidget.execute({ value: 1, delta: '-2' }, ctx);
    expect(out.html).toContain('aw-kpi-delta neg');
  });
});

describe('art_widget_markdown', () => {
  test('renders headings and paragraphs', async () => {
    const out = await markdownWidget.execute({ text: '# Hi\n\nthere' }, ctx);
    expect(out.html).toContain('<h1>Hi</h1>');
    expect(out.html).toContain('<p>there</p>');
  });
  test('renders bullet lists', async () => {
    const out = await markdownWidget.execute({ text: '- one\n- two' }, ctx);
    expect(out.html).toContain('<ul>');
    expect(out.html.match(/<li>/g)?.length).toBe(2);
  });
  test('renders fenced code blocks escaped', async () => {
    const out = await markdownWidget.execute({ text: '```\n<script>\n```' }, ctx);
    expect(out.html).toContain('<pre><code>&lt;script&gt;');
  });
  test('renders inline bold/italic/code/link', async () => {
    const out = await markdownWidget.execute(
      { text: 'hello **bold** and *em* and `code` and [link](https://x).' },
      ctx,
    );
    expect(out.html).toContain('<strong>bold</strong>');
    expect(out.html).toContain('<em>em</em>');
    expect(out.html).toContain('<code>code</code>');
    expect(out.html).toContain('href="https://x"');
  });
  test('rejects non-http link schemes', async () => {
    const out = await markdownWidget.execute({ text: '[x](javascript:alert(1))' }, ctx);
    expect(out.html).not.toContain('href="javascript');
  });
});

describe('art_widget_json_tree', () => {
  test('renders nested objects and arrays', async () => {
    const out = await jsonTreeWidget.execute({ data: { a: [1, 'two', { b: true }] } }, ctx);
    expect(out.html).toContain('<details');
    expect(out.html).toContain('aw-json-str');
    expect(out.html).toContain('aw-json-bool');
  });
  test('handles primitives at the root', async () => {
    const out = await jsonTreeWidget.execute({ data: 42 }, ctx);
    expect(out.html).toContain('aw-json-num');
  });
});

describe('art_widget_bar_chart', () => {
  test('renders bars sorted desc with percentage widths', async () => {
    const out = await barChartWidget.execute(
      { data: [{ key: 'a', count: 3 }, { key: 'b', count: 9 }, { key: 'c', count: 6 }] },
      ctx,
    );
    expect(out.html.indexOf('>b<')).toBeLessThan(out.html.indexOf('>c<'));
    expect(out.html).toContain('width:100%');
  });
  test('uses value field when count absent', async () => {
    const out = await barChartWidget.execute(
      { data: [{ key: 'x', value: 5 }] },
      ctx,
    );
    expect(out.html).toContain('>x<');
    expect(out.html).toContain('>5<');
  });
  test('renders empty text', async () => {
    const out = await barChartWidget.execute({ data: [] }, ctx);
    expect(out.html).toContain('No data');
  });
});
