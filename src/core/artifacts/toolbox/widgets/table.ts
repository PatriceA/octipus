/**
 * art_widget_table — render an array of row objects as an HTML table.
 * Columns are a list of dotted paths; the header label is derived from the
 * last path segment unless `columnLabels` maps it explicitly.
 */

import type { ToolboxTool } from '../types';
import { asArray, asString, escapeHtml, path, type WidgetRender } from './_shared';

interface Params {
  rows: unknown;
  columns?: string[];
  columnLabels?: Record<string, string>;
  emptyText?: string;
}

export const tableWidget: ToolboxTool<Params, WidgetRender> = {
  id: 'art_widget_table',
  family: 'widget',
  description: 'Render an array of row objects as an HTML table; pick columns by dotted path.',
  keywords: ['table', 'grid', 'rows', 'columns', 'list'],
  defaultPermission: 'ALLOW',
  params: {
    rows: { type: 'array', required: true, description: 'Bound array of row objects.' },
    columns: {
      type: 'array',
      description: 'Dotted paths picked from each row. Omit to auto-pick top-level keys of the first row.',
    },
    columnLabels: { type: 'object', description: 'Map of `path → header label`.' },
    emptyText: { type: 'string', default: 'No rows.', description: 'Shown when rows is empty.' },
  },
  returns: '`{ html, css }` — table with sticky header.',
  examples: [
    {
      summary: 'GitHub issues table',
      params: { rows: [], columns: ['number', 'title', 'labels.0.name', 'updated_at'] },
    },
  ],

  async execute(params) {
    const rows = asArray(params.rows);
    if (rows.length === 0) {
      return { html: `<p class="aw-empty">${escapeHtml(params.emptyText ?? 'No rows.')}</p>` };
    }
    const cols = params.columns && params.columns.length > 0
      ? params.columns
      : Object.keys(rows[0] as Record<string, unknown>);

    const head = cols
      .map((c) => `<th>${escapeHtml(params.columnLabels?.[c] ?? labelFor(c))}</th>`)
      .join('');
    const body = rows
      .map((row) => `<tr>${cols.map((c) => `<td>${escapeHtml(asString(path(row, c)))}</td>`).join('')}</tr>`)
      .join('');

    return {
      html: `<div class="aw-table-wrap"><table class="aw-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
      css: TABLE_CSS,
    };
  },
};

function labelFor(path: string): string {
  const last = path.split('.').filter((p) => !/^\d+$/.test(p)).pop() ?? path;
  return last.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const TABLE_CSS = `
.aw-table-wrap { overflow-x: auto; border: 1px solid #e5e7eb; border-radius: 6px; }
.aw-table { width: 100%; border-collapse: collapse; font: 14px/1.4 system-ui, sans-serif; }
.aw-table th, .aw-table td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #f3f4f6; }
.aw-table thead th { background: #f9fafb; position: sticky; top: 0; font-weight: 600; }
.aw-table tbody tr:hover { background: #f9fafb; }
.aw-empty { color: #6b7280; font-style: italic; padding: 16px; }
`;

export default tableWidget;
