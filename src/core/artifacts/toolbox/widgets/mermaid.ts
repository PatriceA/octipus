/**
 * art_widget_mermaid — capture a Mermaid diagram source on the artifact.
 *
 * NOTE: the strict CSP on hosted embeds (`src/core/artifacts/csp.ts`)
 * blocks unhashed inline scripts and external script sources, so we cannot
 * load mermaid.js at view time. Phase 4 will bundle mermaid into
 * `octipus-artifact-widgets.js` with a CSP-pinned sha; until then, the
 * widget renders the captured source inside a `<pre>` and tags the block
 * with `data-mermaid="true"` so the future SDK can lazy-upgrade it
 * without a schema change. Agents pick this tool for diagrams now and
 * the upgrade is purely cosmetic later.
 */

import type { ToolboxTool } from '../types';
import { asString, escapeHtml, type WidgetRender } from './_shared';

interface Params {
  source: unknown;
  caption?: string;
}

export const mermaidWidget: ToolboxTool<Params, WidgetRender> = {
  id: 'art_widget_mermaid',
  family: 'widget',
  description: 'Capture a Mermaid diagram source (flow/seq/erd/gantt/…). Renders as code until the bundled renderer lands; agents wire it now.',
  keywords: ['mermaid', 'diagram', 'flowchart', 'sequence', 'erd', 'gantt'],
  defaultPermission: 'ALLOW',
  params: {
    source: { type: 'string', required: true, description: 'Mermaid diagram source code.' },
    caption: { type: 'string', description: 'Optional caption shown below the diagram.' },
  },
  returns: '`{ html, css }` — `<pre data-mermaid="true">…</pre>` block, ready for client-side upgrade.',
  examples: [
    {
      summary: 'Sequence diagram',
      params: { source: 'sequenceDiagram\n  A->>B: hi\n  B-->>A: hello' },
    },
  ],
  tips: [
    'Diagram source is captured verbatim — agents can regenerate it from data instead of hand-writing each time.',
    'Caption is escaped and shown below the diagram.',
  ],

  async execute(params) {
    const source = asString(params.source);
    if (!source.trim()) {
      throw new Error('art_widget_mermaid: `source` is required');
    }
    const caption = params.caption
      ? `<figcaption class="aw-mermaid-caption">${escapeHtml(asString(params.caption))}</figcaption>`
      : '';
    return {
      html: `<figure class="aw-mermaid"><pre data-mermaid="true">${escapeHtml(source)}</pre>${caption}</figure>`,
      css: MERMAID_CSS,
    };
  },
};

const MERMAID_CSS = `
.aw-mermaid { margin: 0; padding: 16px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fafafa; }
.aw-mermaid pre { font: 12px/1.4 ui-monospace, monospace; white-space: pre; overflow-x: auto; margin: 0; color: #1f2937; }
.aw-mermaid-caption { font: 13px/1.4 system-ui, sans-serif; color: #6b7280; margin-top: 8px; text-align: center; }
`;

export default mermaidWidget;
