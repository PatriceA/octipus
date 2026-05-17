/**
 * art_widget_pie_chart — SVG donut chart. No JS dependency: arc paths
 * computed server-side. Accepts the same `[{key, value}]` / `[{key, count}]`
 * shape as bar_chart so transforms can drive either.
 */

import type { ToolboxTool } from '../types';
import { asArray, asNumber, asString, escapeHtml, type WidgetRender } from './_shared';

interface Datum {
  key: string;
  value: number;
}

interface Params {
  data: unknown;
  valueKey?: string;
  emptyText?: string;
  /** "pie" or "donut" (default). */
  style?: 'pie' | 'donut';
}

const PALETTE = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#84cc16', '#14b8a6', '#f97316',
];

export const pieChartWidget: ToolboxTool<Params, WidgetRender> = {
  id: 'art_widget_pie_chart',
  family: 'widget',
  description: 'SVG pie / donut chart for `[{ key, value }]` data. Pure server-side render, no JS dep.',
  keywords: ['pie', 'donut', 'chart', 'share', 'composition'],
  defaultPermission: 'ALLOW',
  params: {
    data: { type: 'array', required: true, description: 'Bound array of `{ key, value|count }`.' },
    valueKey: { type: 'string', default: 'value', description: 'Field holding the slice magnitude.' },
    style: { type: 'string', enum: ['pie', 'donut'], default: 'donut', description: 'Chart style.' },
    emptyText: { type: 'string', default: 'No data.', description: 'Shown when data is empty.' },
  },
  returns: '`{ html, css }` — SVG + legend.',
  examples: [
    {
      summary: 'Label distribution (from group_count)',
      params: { data: [{ key: 'bug', count: 5 }, { key: 'p1', count: 3 }] },
    },
  ],

  async execute(params) {
    const points = normalize(params.data, params.valueKey);
    if (points.length === 0) {
      return { html: `<p class="aw-empty">${escapeHtml(params.emptyText ?? 'No data.')}</p>` };
    }
    const total = points.reduce((s, p) => s + p.value, 0);
    if (total === 0) {
      return { html: `<p class="aw-empty">${escapeHtml('All values are zero.')}</p>` };
    }

    const r = 50;
    const cx = 60;
    const cy = 60;
    const innerR = params.style === 'pie' ? 0 : 28;

    let cursor = -Math.PI / 2;
    const slices: string[] = [];
    const legend: string[] = [];
    points.forEach((p, i) => {
      const frac = p.value / total;
      const angle = frac * Math.PI * 2;
      const color = PALETTE[i % PALETTE.length];

      const x1 = cx + Math.cos(cursor) * r;
      const y1 = cy + Math.sin(cursor) * r;
      const x2 = cx + Math.cos(cursor + angle) * r;
      const y2 = cy + Math.sin(cursor + angle) * r;
      const large = angle > Math.PI ? 1 : 0;

      let path: string;
      if (innerR > 0) {
        const xi1 = cx + Math.cos(cursor) * innerR;
        const yi1 = cy + Math.sin(cursor) * innerR;
        const xi2 = cx + Math.cos(cursor + angle) * innerR;
        const yi2 = cy + Math.sin(cursor + angle) * innerR;
        path = `M ${xi1} ${yi1} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${xi2} ${yi2} A ${innerR} ${innerR} 0 ${large} 0 ${xi1} ${yi1} Z`;
      } else {
        path = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
      }

      slices.push(`<path d="${path}" fill="${color}"><title>${escapeHtml(p.key)}: ${p.value} (${(frac * 100).toFixed(1)}%)</title></path>`);
      legend.push(`<li><span class="aw-pie-swatch" style="background:${color}"></span>${escapeHtml(p.key)} <span class="aw-pie-num">${p.value}</span></li>`);
      cursor += angle;
    });

    return {
      html: `<div class="aw-pie"><svg viewBox="0 0 120 120" role="img" aria-label="pie chart">${slices.join('')}</svg><ul class="aw-pie-legend">${legend.join('')}</ul></div>`,
      css: PIE_CSS,
    };
  },
};

function normalize(input: unknown, valueKey?: string): Datum[] {
  const arr = asArray(input);
  const out: Datum[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const key = asString(o.key ?? o.name ?? o.label ?? '');
    const valRaw = valueKey ? o[valueKey] : (o.value ?? o.count);
    const v = asNumber(valRaw);
    if (key === '' || v === null || v < 0) continue;
    out.push({ key, value: v });
  }
  return out;
}

const PIE_CSS = `
.aw-pie { display: flex; align-items: center; gap: 24px; font: 13px/1.5 system-ui, sans-serif; }
.aw-pie svg { width: 140px; height: 140px; flex: 0 0 auto; }
.aw-pie-legend { list-style: none; padding: 0; margin: 0; }
.aw-pie-legend li { display: flex; align-items: center; gap: 8px; padding: 3px 0; color: #374151; }
.aw-pie-swatch { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
.aw-pie-num { color: #6b7280; margin-left: 8px; font-variant-numeric: tabular-nums; }
.aw-empty { color: #6b7280; font-style: italic; padding: 16px; }
`;

export default pieChartWidget;
