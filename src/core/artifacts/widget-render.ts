/**
 * Widget renderer — turns artifact_widgets rows into HTML, either by
 * resolving `<x-widget id="<slot>"/>` placeholders in a user template or
 * by building a default CSS-grid layout when no template is set.
 *
 * Bindings: each widget row has `bind_json` mapping widget-param-name →
 * data-bus path (e.g. `{ rows: "issues.items" }`). The renderer resolves
 * those paths in the data bus before invoking the widget's execute().
 *
 * Errors in one widget are isolated — the slot renders an error block
 * instead of crashing the whole page. Detailed error goes to coreLogger.
 */

import { artifactsRepository } from '@/db/repositories/artifacts-repository';
import type { ArtifactWidget } from '@/db/schema/artifact-widgets';
import { coreLogger } from '@/utils/logger';
import { escapeHtml } from './render';
import { ensureToolboxLoaded, getToolboxRegistry } from './toolbox';

/** Resolve a dotted path on the data bus. */
function resolvePath(root: Record<string, unknown>, expr: string): unknown {
  if (!expr) return root;
  const parts = expr.split('.').map((p) => p.trim()).filter(Boolean);
  let cur: unknown = root;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(p)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return cur;
}

export interface WidgetRenderResult {
  /** Map of slot → rendered HTML (or error block). */
  bySlot: Record<string, string>;
  /** Concatenated CSS from every successfully rendered widget. */
  css: string;
  /** Map of slot → error message; empty if all widgets rendered cleanly. */
  errors: Record<string, string>;
}

/**
 * Render every widget on an artifact. Caller decides whether to splice the
 * results into a template (via `resolveWidgetTags`) or assemble a default
 * layout (via `renderDefaultLayout`).
 */
export async function renderWidgets(
  artifactId: string,
  dataBus: Record<string, unknown>,
): Promise<WidgetRenderResult> {
  await ensureToolboxLoaded();
  const widgets = await artifactsRepository.listWidgets(artifactId);
  const bySlot: Record<string, string> = {};
  const errors: Record<string, string> = {};
  const cssChunks = new Set<string>();

  for (const w of widgets) {
    const { html, css, error } = await renderOne(w, dataBus);
    bySlot[w.slot] = html;
    if (css) cssChunks.add(css);
    if (error) {
      errors[w.slot] = error;
      coreLogger.error(
        { artifactId, slot: w.slot, toolId: w.toolId, error },
        'artifact.widget.render_failed',
      );
    }
  }

  return { bySlot, css: [...cssChunks].join('\n'), errors };
}

async function renderOne(
  widget: ArtifactWidget,
  dataBus: Record<string, unknown>,
): Promise<{ html: string; css?: string; error?: string }> {
  const tool = getToolboxRegistry().get(widget.toolId);
  if (!tool) {
    return {
      html: errorBlock(widget.slot, `unknown widget tool "${widget.toolId}"`),
      error: `unknown widget tool "${widget.toolId}"`,
    };
  }
  if (tool.family !== 'widget') {
    return {
      html: errorBlock(widget.slot, `tool "${widget.toolId}" is a ${tool.family}, expected widget`),
      error: `wrong family: ${tool.family}`,
    };
  }

  // Resolve binds against the data bus.
  const resolvedBinds: Record<string, unknown> = {};
  for (const [paramName, pathExpr] of Object.entries(widget.bindJson ?? {})) {
    resolvedBinds[paramName] = resolvePath(dataBus, pathExpr);
  }
  const params = { ...(widget.paramsJson ?? {}), ...resolvedBinds };

  try {
    const out = await tool.execute(params, {
      principalId: '',
      workspaceId: '',
      artifactId: undefined,
      nodeName: widget.slot,
    });
    if (!out || typeof out !== 'object') {
      throw new Error('widget returned non-object');
    }
    const result = out as { html?: unknown; css?: unknown };
    if (typeof result.html !== 'string') {
      throw new Error('widget returned no `html` string');
    }
    return {
      html: `<div class="aw-slot" data-slot="${escapeHtml(widget.slot)}">${result.html}</div>`,
      css: typeof result.css === 'string' ? result.css : undefined,
    };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    return {
      html: errorBlock(widget.slot, message),
      error: message,
    };
  }
}

function errorBlock(slot: string, message: string): string {
  return `<div class="aw-slot aw-slot-error" data-slot="${escapeHtml(slot)}">
    <strong>Widget "${escapeHtml(slot)}" failed</strong>
    <p>${escapeHtml(message)}</p>
  </div>`;
}

/**
 * Replace `<x-widget id="<slot>"/>` (self-closing) and `<x-widget id="<slot>"></x-widget>`
 * placeholders in `template` with each widget's rendered HTML. Slots not
 * present in `bySlot` are left as-is (renderer chose to ignore them).
 */
const X_WIDGET_RE = /<x-widget\s+id=["']([a-zA-Z0-9_-]+)["']\s*(?:\/|><\/x-widget)>/g;

export function resolveWidgetTags(template: string, bySlot: Record<string, string>): string {
  return template.replace(X_WIDGET_RE, (match, slot) => {
    if (!(slot in bySlot)) return match;
    return bySlot[slot];
  });
}

/**
 * Build a CSS-grid layout from rendered widgets when the artifact has no
 * template. Widgets render in repository order (position asc, then
 * created_at). Span hint comes from `params_json.span` (1 = full width
 * default; 2 = double).
 */
export async function renderDefaultLayout(
  artifactId: string,
  bySlot: Record<string, string>,
): Promise<string> {
  const widgets = await artifactsRepository.listWidgets(artifactId);
  if (widgets.length === 0) return '';
  const cells = widgets
    .map((w) => {
      const span = Number((w.paramsJson as Record<string, unknown>)?.span ?? 1) || 1;
      const html = bySlot[w.slot] ?? '';
      return `<div class="aw-cell" style="grid-column: span ${Math.min(Math.max(span, 1), 4)}">${html}</div>`;
    })
    .join('');
  return `<div class="aw-grid">${cells}</div>`;
}

export const DEFAULT_LAYOUT_CSS = `
.aw-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; padding: 16px; }
.aw-cell { min-width: 0; }
.aw-slot { display: block; }
.aw-slot-error { background: #fef2f2; color: #b91c1c; padding: 12px; border: 1px solid #fecaca; border-radius: 6px; }
.aw-slot-error p { margin: 6px 0 0; font-size: 13px; }
`;

/**
 * Baseline stylesheet injected into every hosted artifact page (both the
 * outer chrome and the sandboxed embed). Self-contained — no @import, no
 * external fonts, so the embed CSP doesn't have to whitelist anything.
 *
 * Token names mirror the Octipus web app's surface/on-surface/outline
 * palette so artifacts feel native even when opened on the bare artifact
 * subdomain without the rest of the web app's CSS.
 *
 * Respects `prefers-color-scheme` — same artifact looks right whether the
 * viewer's OS is light or dark.
 */
export const ARTIFACT_BASE_CSS = `
:root {
  color-scheme: light dark;
  --octi-surface: #fafaf9;
  --octi-surface-container: #f5f5f4;
  --octi-surface-container-high: #ececeb;
  --octi-on-surface: #1c1b1f;
  --octi-on-surface-variant: #49454f;
  --octi-outline: #d6d3d1;
  --octi-outline-variant: #e7e5e4;
  --octi-primary: #6750a4;
  --octi-link: #4f46e5;
  --octi-error: #b91c1c;
  --octi-success: #15803d;
  --octi-warning: #b45309;
  --octi-mono: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace;
  --octi-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --octi-surface: #1c1b1f;
    --octi-surface-container: #211f24;
    --octi-surface-container-high: #2b2930;
    --octi-on-surface: #e6e1e5;
    --octi-on-surface-variant: #cac4d0;
    --octi-outline: #49454f;
    --octi-outline-variant: #36343b;
    --octi-link: #a5b4fc;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--octi-sans);
  font-size: 14px;
  line-height: 1.55;
  color: var(--octi-on-surface);
  background: var(--octi-surface);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
h1, h2, h3, h4, h5, h6 { margin: 0 0 0.5em; font-weight: 600; line-height: 1.3; color: var(--octi-on-surface); }
h1 { font-size: 1.5rem; }
h2 { font-size: 1.25rem; }
h3 { font-size: 1.125rem; }
h4, h5, h6 { font-size: 1rem; }
p { margin: 0 0 1em; }
a { color: var(--octi-link); text-decoration: none; }
a:hover { text-decoration: underline; }
code, kbd, samp, pre { font-family: var(--octi-mono); font-size: 0.92em; }
code { background: var(--octi-surface-container); padding: 0.1em 0.35em; border-radius: 4px; }
pre {
  background: var(--octi-surface-container);
  padding: 12px 14px;
  border-radius: 6px;
  overflow-x: auto;
  border: 1px solid var(--octi-outline-variant);
}
pre code { background: transparent; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 0 0 1em; font-size: 0.92em; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--octi-outline-variant); }
th { font-weight: 600; color: var(--octi-on-surface-variant); background: var(--octi-surface-container); }
tbody tr:hover { background: var(--octi-surface-container); }
ul, ol { margin: 0 0 1em; padding-left: 1.5em; }
li { margin-bottom: 0.25em; }
hr { border: 0; border-top: 1px solid var(--octi-outline-variant); margin: 1.5em 0; }
blockquote {
  margin: 0 0 1em;
  padding: 0.5em 1em;
  border-left: 3px solid var(--octi-outline);
  color: var(--octi-on-surface-variant);
  background: var(--octi-surface-container);
}
img, svg, canvas { max-width: 100%; }
.aw-card, .octi-card {
  background: var(--octi-surface-container);
  border: 1px solid var(--octi-outline-variant);
  border-radius: 10px;
  padding: 16px;
}
.octi-page { max-width: 1200px; margin: 0 auto; padding: 24px; }
`;

/**
 * Outer-chrome stylesheet (page that hosts the iframe). Provides the title
 * bar styling and the iframe container layout. Kept distinct from
 * ARTIFACT_BASE_CSS because the outer doc loads the iframe inline — no
 * tight CSP applies — and the layout concerns differ (sticky header etc.).
 */
export const ARTIFACT_OUTER_CSS = `
${ARTIFACT_BASE_CSS}
.octi-outer { display: flex; flex-direction: column; min-height: 100vh; }
.octi-outer-header {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 20px;
  background: var(--octi-surface-container);
  border-bottom: 1px solid var(--octi-outline-variant);
}
.octi-outer-header h1 { font-size: 1.05rem; margin: 0; font-weight: 600; }
.octi-outer-brand { font-size: 0.75rem; color: var(--octi-on-surface-variant); letter-spacing: 0.05em; text-transform: uppercase; }
.octi-outer-frame { flex: 1; border: 0; width: 100%; background: var(--octi-surface); }
`;
