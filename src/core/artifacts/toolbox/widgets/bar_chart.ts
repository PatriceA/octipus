/**
 * art_widget_bar_chart — CSS-only horizontal bar chart, no JS dependency.
 * Bind it to `art_transform_group_count` output (or any `[{key, value}]` /
 * `[{key, count}]` shape).
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
}

export const barChartWidget: ToolboxTool<Params, WidgetRender> = {
  id: 'art_widget_bar_chart',
  family: 'widget',
  description: 'CSS-only horizontal bar chart for `[{ key, value }]` / `[{ key, count }]` shapes.',
  keywords: ['bar', 'chart', 'histogram', 'rank', 'count'],
  defaultPermission: 'ALLOW',
  params: {
    data: { type: 'array', required: true, description: 'Bound array of `{ key, value }` or `{ key, count }`.' },
    valueKey: { type: 'string', default: 'value', description: 'Field with the bar magnitude. `count` also tried as fallback.' },
    emptyText: { type: 'string', default: 'No data.', description: 'Shown when data is empty.' },
  },
  returns: '`{ html, css }` — horizontal bars sized as % of the max.',
  examples: [
    {
      summary: 'Label histogram (from group_count)',
      params: { data: [{ key: 'bug', count: 5 }, { key: 'p1', count: 3 }] },
    },
  ],
  tips: ['Bars are sorted descending by value; sort upstream if you need a different order.'],

  async execute(params) {
    const points = normalize(params.data, params.valueKey);
    if (points.length === 0) {
      return { html: `<p class="aw-empty">${escapeHtml(params.emptyText ?? 'No data.')}</p>` };
    }
    const max = Math.max(...points.map((p) => p.value), 1);
    const sorted = [...points].sort((a, b) => b.value - a.value);
    const rows = sorted
      .map((p) => {
        const pct = Math.max(2, Math.round((p.value / max) * 100));
        return `<div class="aw-bar-row">
          <div class="aw-bar-key">${escapeHtml(p.key)}</div>
          <div class="aw-bar-track"><div class="aw-bar-fill" style="width:${pct}%"></div></div>
          <div class="aw-bar-value">${escapeHtml(String(p.value))}</div>
        </div>`;
      })
      .join('');
    return { html: `<div class="aw-bar">${rows}</div>`, css: BAR_CSS };
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
    if (key === '' || v === null) continue;
    out.push({ key, value: v });
  }
  return out;
}

const BAR_CSS = `
.aw-bar { display: flex; flex-direction: column; gap: 6px; font: 13px/1.4 system-ui, sans-serif; }
.aw-bar-row { display: grid; grid-template-columns: minmax(80px, 160px) 1fr 60px; gap: 12px; align-items: center; }
.aw-bar-key { color: #374151; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aw-bar-track { background: #f3f4f6; border-radius: 4px; height: 14px; overflow: hidden; }
.aw-bar-fill { background: linear-gradient(90deg, #6366f1, #818cf8); height: 100%; border-radius: 4px; }
.aw-bar-value { text-align: right; color: #6b7280; font-variant-numeric: tabular-nums; }
.aw-empty { color: #6b7280; font-style: italic; padding: 16px; }
`;

export default barChartWidget;
