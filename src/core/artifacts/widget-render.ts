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
