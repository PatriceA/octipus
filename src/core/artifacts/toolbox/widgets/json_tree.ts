/**
 * art_widget_json_tree — collapsible JSON viewer using <details>. Useful
 * as a default fallback when no other widget fits, or for debugging which
 * shape a source returns.
 */

import type { ToolboxTool } from '../types';
import { escapeHtml, type WidgetRender } from './_shared';

interface Params {
  data: unknown;
  /** Auto-expand depths up to this number (default 1). */
  expandDepth?: number;
}

export const jsonTreeWidget: ToolboxTool<Params, WidgetRender> = {
  id: 'art_widget_json_tree',
  family: 'widget',
  description: 'Collapsible JSON viewer — useful for debugging source shapes.',
  keywords: ['json', 'tree', 'inspect', 'debug', 'view'],
  defaultPermission: 'ALLOW',
  params: {
    data: { type: 'object', required: true, description: 'Anything JSON-serialisable.' },
    expandDepth: { type: 'number', default: 1, description: 'Depths up to which nodes start expanded.' },
  },
  returns: '`{ html, css }` — nested `<details>` tree.',
  examples: [{ summary: 'Inspect raw source payload', params: { data: { hello: 'world' } } }],

  async execute(params) {
    const depth = typeof params.expandDepth === 'number' ? params.expandDepth : 1;
    return { html: `<div class="aw-json">${renderNode(params.data, 0, depth)}</div>`, css: JSON_CSS };
  },
};

function renderNode(value: unknown, depth: number, openTo: number): string {
  if (value === null) return `<span class="aw-json-null">null</span>`;
  if (typeof value === 'string') return `<span class="aw-json-str">"${escapeHtml(value)}"</span>`;
  if (typeof value === 'number') return `<span class="aw-json-num">${escapeHtml(String(value))}</span>`;
  if (typeof value === 'boolean') return `<span class="aw-json-bool">${value}</span>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `<span class="aw-json-empty">[]</span>`;
    const open = depth < openTo ? ' open' : '';
    return `<details class="aw-json-node"${open}><summary>Array(${value.length})</summary>${
      value.map((v, i) => `<div class="aw-json-row"><span class="aw-json-key">${i}:</span> ${renderNode(v, depth + 1, openTo)}</div>`).join('')
    }</details>`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `<span class="aw-json-empty">{}</span>`;
    const open = depth < openTo ? ' open' : '';
    return `<details class="aw-json-node"${open}><summary>{${entries.length}}</summary>${
      entries.map(([k, v]) => `<div class="aw-json-row"><span class="aw-json-key">${escapeHtml(k)}:</span> ${renderNode(v, depth + 1, openTo)}</div>`).join('')
    }</details>`;
  }
  return `<span class="aw-json-unknown">${escapeHtml(String(value))}</span>`;
}

const JSON_CSS = `
.aw-json { font: 13px/1.5 ui-monospace, monospace; color: #1f2937; }
.aw-json-node { margin-left: 0; }
.aw-json-node summary { cursor: pointer; color: #6b7280; }
.aw-json-row { margin-left: 16px; }
.aw-json-key { color: #6b7280; }
.aw-json-str { color: #047857; }
.aw-json-num { color: #1d4ed8; }
.aw-json-bool { color: #b91c1c; }
.aw-json-null, .aw-json-empty { color: #9ca3af; font-style: italic; }
`;

export default jsonTreeWidget;
