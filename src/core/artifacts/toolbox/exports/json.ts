/**
 * art_export_json — pretty-printed JSON snapshot of any value. Cheap,
 * works as a fallback when a more specialised export does not fit.
 */

import type { ToolboxTool } from '../types';
import type { ExportPayload } from './csv';

interface Params {
  data: unknown;
  filename?: string;
  /** Indentation width (default 2). 0 disables. */
  indent?: number;
}

export const jsonExporter: ToolboxTool<Params, ExportPayload> = {
  id: 'art_export_json',
  family: 'export',
  description: 'Pretty-printed JSON snapshot of any value — useful as a universal fallback download.',
  keywords: ['json', 'export', 'download', 'snapshot'],
  defaultPermission: 'ALLOW',
  params: {
    data: { type: 'object', required: true, description: 'Any JSON-serialisable value.' },
    filename: { type: 'string', description: 'Suggested filename; `.json` appended if missing.' },
    indent: { type: 'number', default: 2, description: 'Indent width; 0 emits a single line.' },
  },
  returns: '`{ filename, contentType, body }`.',
  examples: [
    { summary: 'Snapshot raw source payload', params: { data: { hello: 'world' }, filename: 'snapshot' } },
  ],

  async execute(params) {
    const indent = typeof params.indent === 'number' ? Math.max(0, Math.min(8, params.indent)) : 2;
    const name = (params.filename ?? 'export').replace(/\.json$/i, '');
    return {
      filename: `${name}.json`,
      contentType: 'application/json; charset=utf-8',
      body: indent > 0 ? JSON.stringify(params.data, null, indent) : JSON.stringify(params.data),
    };
  },
};

export default jsonExporter;
