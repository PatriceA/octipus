/**
 * The manifest field for dashboards (docs/PLUGIN-PACKAGES.md#dashboards).
 * Kept apart from ./manifest.ts, which spreads `DASHBOARD_FIELDS` into its
 * schema and adds `dashboardProblems`.
 *
 * A dashboard is a declaration the host draws with its own components: each
 * widget names one of the package's `read` tools and fixed arguments, and
 * shows what that tool returns. Nothing of the package runs in the browser,
 * and nothing from the browser reaches the tool.
 */
import { z } from 'zod';
import {
  PLUGIN_WIDGET_MAX_REFRESH_SECONDS,
  PLUGIN_WIDGET_MIN_REFRESH_SECONDS,
  PLUGIN_WIDGET_TYPES,
  type PluginDashboardDecl,
  type PluginToolEffect,
} from '@/shared/plugin-package';

/** Dashboards one package may declare, and widgets one dashboard may hold. */
export const MAX_DASHBOARDS = 10;
export const MAX_WIDGETS = 24;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ICON_RE = /^[a-z][a-z0-9-]{0,39}$/;

function jsonSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

const widgetSchema = z.object({
  id: z.string().regex(ID_RE, 'dashboards: a widget id is lower-case letters, digits and -'),
  type: z.enum(PLUGIN_WIDGET_TYPES, { error: () => `dashboards: a widget type is one of ${PLUGIN_WIDGET_TYPES.join(', ')}` }),
  title: z.string().trim().min(1).max(80),
  tool: z.string().min(1).max(64),
  input: z.record(z.string().max(100), z.unknown()).refine((v) => jsonSize(v) <= 4000, 'dashboards: a widget\'s input is at most 4000 characters of JSON').optional(),
  refreshSeconds: z.number().int()
    .min(PLUGIN_WIDGET_MIN_REFRESH_SECONDS, `dashboards: refreshSeconds is at least ${PLUGIN_WIDGET_MIN_REFRESH_SECONDS}`)
    .max(PLUGIN_WIDGET_MAX_REFRESH_SECONDS, `dashboards: refreshSeconds is at most ${PLUGIN_WIDGET_MAX_REFRESH_SECONDS}`)
    .optional(),
  width: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
}).strict();

const dashboardSchema = z.object({
  id: z.string().regex(ID_RE, 'dashboards: an id is lower-case letters, digits and -'),
  title: z.string().trim().min(1).max(60),
  icon: z.string().regex(ICON_RE, 'dashboards: an icon is a lucide icon name such as chart-bar').optional(),
  widgets: z.array(widgetSchema).min(1, 'dashboards: a dashboard has at least one widget').max(MAX_WIDGETS, `dashboards: at most ${MAX_WIDGETS} widgets`),
}).strict();

/** Spread into the manifest's object schema. */
export const DASHBOARD_FIELDS = {
  dashboards: z.array(dashboardSchema).min(1, 'dashboards: declare at least one, or leave the field out').max(MAX_DASHBOARDS, `dashboards: at most ${MAX_DASHBOARDS}`).optional(),
};

/**
 * The checks across fields, as messages (each one refuses the install): ids
 * unique, every widget's tool declared and a `read` tool (a dashboard reads
 * whenever it is shown, so it never runs anything that changes data).
 */
export function dashboardProblems(m: { dashboards?: PluginDashboardDecl[]; tools?: Record<string, { effect: PluginToolEffect }> }): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of m.dashboards ?? []) {
    if (seen.has(d.id)) out.push(`dashboards: "${d.id}" is declared twice`);
    seen.add(d.id);
    const widgets = new Set<string>();
    for (const w of d.widgets) {
      if (widgets.has(w.id)) out.push(`dashboards: ${d.id} has the widget "${w.id}" twice`);
      widgets.add(w.id);
      const tool = Object.hasOwn(m.tools ?? {}, w.tool) ? m.tools?.[w.tool] : undefined;
      if (!tool) out.push(`dashboards: ${d.id}/${w.id} names the tool ${w.tool}, which is not declared`);
      else if (tool.effect !== 'read') out.push(`dashboards: ${d.id}/${w.id} names ${w.tool}, a ${tool.effect} tool; a widget's tool is a read tool (a dashboard reads whenever it is shown)`);
    }
  }
  return out;
}
