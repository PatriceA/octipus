/**
 * What a dashboard widget's tool returns, checked before the host draws it
 * (docs/PLUGIN-PACKAGES.md#dashboards). The tool answers with JSON (as
 * structured content, or as the text of its first text block) in the shape
 * of its widget type (`PluginWidgetData`); anything else is refused, and the
 * widget shows that it could not be drawn.
 *
 * - **Bounded.** Strings, lists, rows, columns and series are capped; the
 *   whole answer is at most 256 KB of JSON.
 * - **Text is text.** The web app draws every string as text: no HTML, no
 *   Markdown, no images.
 * - **Links leave the house.** A widget's link is https only, to a host the
 *   package declares in `network` (`hostAllowed`): a package with network is
 *   at protection level 1 already, so a link adds no way out; a package
 *   without network gets none, or a click could carry what it read away.
 */
import { z } from 'zod';
import { hostAllowed } from '@/security/egress-proxy';
import type { PluginWidgetData, PluginWidgetType } from '@/shared/plugin-package';

/** The most JSON one widget's data may weigh (characters). */
export const MAX_WIDGET_JSON = 256 * 1024;

const tone = z.enum(['good', 'warn', 'bad', 'neutral']).optional();
const text = (max: number) => z.string().max(max);
const updatedAt = z.string().max(40).optional();
const value = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);
const link = z.object({ url: z.string().max(2000), label: z.string().max(200).optional() }).strict().optional();
const key = z.string().min(1).max(64);

const schemas: Record<PluginWidgetType, z.ZodType> = {
  stat: z.object({
    value: z.union([z.number().finite(), z.string().max(40)]), label: text(100).optional(), unit: text(20).optional(),
    delta: z.number().finite().optional(), tone, caption: text(200).optional(), updatedAt,
  }).strict(),
  list: z.object({
    items: z.array(z.object({ title: text(200), subtitle: text(300).optional(), value: text(60).optional(), tone, link }).strict()).max(100),
    updatedAt,
  }).strict(),
  table: z.object({
    columns: z.array(z.object({ key, label: text(100), align: z.enum(['left', 'right']).optional() }).strict()).min(1).max(20),
    rows: z.array(z.object({ values: z.record(key, value), tone, link }).strict()).max(500),
    updatedAt,
  }).strict(),
  chart: z.object({
    kind: z.enum(['bar', 'line', 'area', 'pie']),
    x: key,
    series: z.array(z.object({ key, label: text(100) }).strict()).min(1).max(8),
    points: z.array(z.record(key, value)).max(500),
    updatedAt,
  }).strict(),
  text: z.object({ text: text(20_000), updatedAt }).strict(),
};

export type WidgetDataOutcome = { ok: true; data: PluginWidgetData } | { ok: false; error: string };

/** The JSON a tool result carries: its structured content, else the text of its first text block. */
function payloadOf(result: unknown): { value: unknown } | { error: string } {
  if (!result || typeof result !== 'object') return { error: 'The tool returned nothing' };
  const r = result as { isError?: unknown; structuredContent?: unknown; content?: unknown };
  const firstText = Array.isArray(r.content)
    ? (r.content.find((c) => c && typeof c === 'object' && (c as { type?: unknown }).type === 'text') as { text?: unknown } | undefined)?.text
    : undefined;
  if (r.isError === true) return { error: `The tool failed: ${typeof firstText === 'string' ? firstText.slice(0, 300) : 'no reason given'}` };
  if (r.structuredContent && typeof r.structuredContent === 'object') return { value: r.structuredContent };
  if (typeof firstText !== 'string') return { error: 'The tool returned no JSON (structured content, or a text block)' };
  if (firstText.length > MAX_WIDGET_JSON) return { error: `The widget's data is over ${MAX_WIDGET_JSON} characters` };
  try {
    return { value: JSON.parse(firstText) };
  } catch {
    return { error: 'The tool\'s text is not JSON' };
  }
}

/** Whether `url` is https to a host of `network`. */
export function linkAllowed(url: string, network: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  return hostAllowed(network, u.hostname, u.port ? Number(u.port) : 443);
}

/** Every link of `data`, wherever its type puts them. */
function linksOf(data: PluginWidgetData): string[] {
  if (data.type === 'list') return data.items.flatMap((i) => (i.link ? [i.link.url] : []));
  if (data.type === 'table') return data.rows.flatMap((r) => (r.link ? [r.link.url] : []));
  return [];
}

/**
 * The widget data in a tool result, checked against `type` and the package's
 * `network`; or why it cannot be drawn (said to the viewer, never more than
 * the tool itself said).
 */
export function widgetData(result: unknown, type: PluginWidgetType, network: readonly string[]): WidgetDataOutcome {
  const payload = payloadOf(result);
  if ('error' in payload) return { ok: false, error: payload.error };
  let size: number;
  try {
    size = JSON.stringify(payload.value)?.length ?? 0;
  } catch {
    return { ok: false, error: 'The widget\'s data is not JSON' };
  }
  if (size > MAX_WIDGET_JSON) return { ok: false, error: `The widget's data is over ${MAX_WIDGET_JSON} characters` };
  const value = payload.value && typeof payload.value === 'object' && !Array.isArray(payload.value)
    ? { ...(payload.value as Record<string, unknown>) }
    : payload.value;
  // The type is the widget's, as declared: the tool need not repeat it, and may not change it.
  if (value && typeof value === 'object' && 'type' in value) {
    if ((value as { type?: unknown }).type !== type) return { ok: false, error: `The tool returned ${String((value as { type?: unknown }).type)} data for a ${type} widget` };
    delete (value as { type?: unknown }).type;
  }
  const parsed = schemas[type].safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `The data does not fit a ${type} widget: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid'}` };
  }
  const data = { type, ...(parsed.data as object) } as PluginWidgetData;
  const bad = linksOf(data).find((u) => !linkAllowed(u, network));
  if (bad !== undefined) return { ok: false, error: 'A link goes to a host the plugin does not declare (links are https, to its network hosts only)' };
  if (data.type === 'chart') {
    const keys = new Set([data.x, ...data.series.map((s) => s.key)]);
    if (keys.size !== data.series.length + 1) return { ok: false, error: 'The chart\'s x and series keys are not distinct' };
  }
  return { ok: true, data };
}
