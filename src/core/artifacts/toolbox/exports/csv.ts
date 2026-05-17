/**
 * art_export_csv — emit RFC4180-ish CSV from an array of row objects.
 * Returns `{ filename, contentType, body }` so the export route can stream
 * the response without re-implementing serialization.
 */

import type { ToolboxTool } from '../types';

export interface ExportPayload {
  filename: string;
  contentType: string;
  body: string;
}

interface Params {
  rows: unknown;
  columns?: string[];
  filename?: string;
}

export const csvExporter: ToolboxTool<Params, ExportPayload> = {
  id: 'art_export_csv',
  family: 'export',
  description: 'Emit RFC4180-ish CSV from an array of row objects. Columns auto-detected if omitted.',
  keywords: ['csv', 'export', 'download', 'spreadsheet', 'excel'],
  defaultPermission: 'ALLOW',
  params: {
    rows: { type: 'array', required: true, description: 'Bound array of flat row objects.' },
    columns: { type: 'array', description: 'Ordered column ids. Omit to auto-pick top-level keys of the first row.' },
    filename: { type: 'string', description: 'Suggested filename; `.csv` appended if missing.' },
  },
  returns: '`{ filename, contentType, body }` — body is the CSV string.',
  examples: [
    {
      summary: 'Export issues table',
      params: { rows: [], columns: ['number', 'title', 'state'], filename: 'issues' },
    },
  ],
  tips: [
    'Nested objects are stringified via JSON.stringify — flatten upstream with `art_transform_columns` (future) if you need dotted paths.',
    'Cells are quoted only when they contain a comma, quote, or newline.',
  ],

  async execute(params) {
    if (!Array.isArray(params.rows)) {
      throw new Error('art_export_csv: `rows` must be an array');
    }
    const cols: string[] = params.columns && params.columns.length > 0
      ? params.columns
      : Object.keys((params.rows[0] as Record<string, unknown> | undefined) ?? {});

    const lines: string[] = [];
    lines.push(cols.map(quote).join(','));
    for (const row of params.rows) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      lines.push(cols.map((c) => quote(stringify(r[c]))).join(','));
    }

    const name = (params.filename ?? 'export').replace(/\.csv$/i, '');
    return {
      filename: `${name}.csv`,
      contentType: 'text/csv; charset=utf-8',
      // Excel-friendly CRLF.
      body: lines.join('\r\n') + '\r\n',
    };
  },
};

function quote(raw: string): string {
  if (/[",\r\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

function stringify(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export default csvExporter;
