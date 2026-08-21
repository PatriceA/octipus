/**
 * art_export_markdown — render an array of row objects as a Markdown table.
 * Pairs with the markdown widget for the visible view; this one is for
 * download / copy-paste into another doc.
 */

import type { ToolboxTool } from '../types';
import type { ExportPayload } from './csv';

interface Params {
  rows: unknown;
  columns?: string[];
  title?: string;
  filename?: string;
}

export const markdownExporter: ToolboxTool<Params, ExportPayload> = {
  id: 'art_export_markdown',
  family: 'export',
  description: 'Render an array of row objects as a Markdown table (optionally titled).',
  keywords: ['markdown', 'md', 'table', 'export', 'download'],
  defaultPermission: 'ALLOW',
  params: {
    rows: { type: 'array', required: true, description: 'Bound array of row objects.' },
    columns: { type: 'array', description: 'Ordered column ids; auto-picked from row 0 if omitted.' },
    title: { type: 'string', description: 'Optional `# title` line above the table.' },
    filename: { type: 'string', description: 'Suggested filename; `.md` appended if missing.' },
  },
  returns: '`{ filename, contentType, body }`.',
  examples: [
    { summary: 'Top labels report', params: { rows: [], title: 'Top labels' } },
  ],

  async execute(params) {
    if (!Array.isArray(params.rows)) {
      throw new Error('art_export_markdown: `rows` must be an array');
    }
    const cols = params.columns && params.columns.length > 0
      ? params.columns
      : Object.keys((params.rows[0] as Record<string, unknown> | undefined) ?? {});

    const lines: string[] = [];
    if (params.title) {
      lines.push(`# ${params.title}`, '');
    }
    if (cols.length === 0) {
      lines.push('_(no columns)_');
    } else {
      lines.push(`| ${cols.map(esc).join(' | ')} |`);
      lines.push(`| ${cols.map(() => '---').join(' | ')} |`);
      for (const row of params.rows) {
        if (!row || typeof row !== 'object') continue;
        const r = row as Record<string, unknown>;
        lines.push(`| ${cols.map((c) => esc(stringify(r[c]))).join(' | ')} |`);
      }
    }

    const name = (params.filename ?? 'export').replace(/\.md$/i, '');
    return {
      filename: `${name}.md`,
      contentType: 'text/markdown; charset=utf-8',
      body: lines.join('\n') + '\n',
    };
  },
};

function esc(raw: string): string {
  return raw
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

function stringify(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export default markdownExporter;
