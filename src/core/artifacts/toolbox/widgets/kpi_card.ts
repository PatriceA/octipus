/**
 * art_widget_kpi_card — single big number with optional label and delta.
 * The bind passes `value` already resolved from the data bus; the widget
 * just formats and renders.
 */

import type { ToolboxTool } from '../types';
import { asNumber, asString, escapeHtml, type WidgetRender } from './_shared';

interface Params {
  value: unknown;
  label?: string;
  delta?: unknown;
  unit?: string;
  /** Number of decimals when value is numeric. */
  precision?: number;
}

export const kpiCardWidget: ToolboxTool<Params, WidgetRender> = {
  id: 'art_widget_kpi_card',
  family: 'widget',
  description: 'A single big number with optional label, unit, and signed delta.',
  keywords: ['kpi', 'metric', 'big number', 'stat', 'card'],
  defaultPermission: 'ALLOW',
  params: {
    value: { type: 'string', required: true, description: 'Bound value (number or string).' },
    label: { type: 'string', description: 'Caption shown below the value.' },
    delta: { type: 'string', description: 'Optional signed delta vs prior period.' },
    unit: { type: 'string', description: 'Unit shown after the value, e.g. "$", "ms", "%".' },
    precision: { type: 'number', description: 'Decimal places when value is numeric.' },
  },
  returns: '`{ html, css }` — single card.',
  examples: [
    {
      summary: 'Star count',
      params: { value: 1234, label: 'Stars', delta: '+42' },
    },
  ],

  async execute(params) {
    const num = asNumber(params.value);
    const formatted = num !== null
      ? num.toFixed(typeof params.precision === 'number' ? params.precision : 0)
      : asString(params.value);
    const unit = params.unit ? `<span class="aw-kpi-unit">${escapeHtml(params.unit)}</span>` : '';
    const delta = params.delta != null && asString(params.delta) !== ''
      ? `<div class="aw-kpi-delta ${asString(params.delta).startsWith('-') ? 'neg' : 'pos'}">${escapeHtml(asString(params.delta))}</div>`
      : '';
    const label = params.label
      ? `<div class="aw-kpi-label">${escapeHtml(params.label)}</div>`
      : '';

    return {
      html: `<div class="aw-kpi"><div class="aw-kpi-value">${escapeHtml(formatted)}${unit}</div>${delta}${label}</div>`,
      css: KPI_CSS,
    };
  },
};

const KPI_CSS = `
.aw-kpi { padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; font: 14px system-ui, sans-serif; }
.aw-kpi-value { font-size: 36px; font-weight: 700; color: #111827; line-height: 1.1; }
.aw-kpi-unit { font-size: 18px; font-weight: 500; color: #6b7280; margin-left: 4px; }
.aw-kpi-delta { font-size: 13px; margin-top: 4px; font-weight: 500; }
.aw-kpi-delta.pos { color: #047857; }
.aw-kpi-delta.neg { color: #b91c1c; }
.aw-kpi-label { font-size: 13px; color: #6b7280; margin-top: 8px; text-transform: uppercase; letter-spacing: 0.04em; }
`;

export default kpiCardWidget;
