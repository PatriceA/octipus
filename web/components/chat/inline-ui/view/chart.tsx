'use client';

/**
 * A view's Chart (spec §2.6). recharts loads on first use (`chart-impl.tsx`),
 * so the chat bundle carries none of it for people who never see a chart.
 * The point cap from the limits applies to live data; a text alternative
 * (a summary label and a "Show data" table) is always there.
 */
import { lazy, Suspense } from 'react';
import { INLINE_UI_VIEW_LIMITS } from '../../../../../src/shared/inline-ui/limits';
import { formatNumber, isJsonObject, type JsonObject, toNumber, valueToText } from '../../../../../src/shared/inline-ui/view';
import { type NodeProps, useViewRuntime } from './runtime';

const ChartImpl = lazy(() => import('./chart-impl'));

export interface ChartPoint { x: string; [series: string]: string | number | null }

const TYPE_NAME = { bar: 'Bar', line: 'Line', area: 'Area', pie: 'Pie' } as const;

export function Chart({ c, r }: NodeProps<'Chart'>) {
  const rt = useViewRuntime();
  const rows = Array.isArray(r.data) ? r.data.filter(isJsonObject) : [];
  const capped: JsonObject[] = rows.slice(0, INLINE_UI_VIEW_LIMITS.chartPoints);
  const series = c.type === 'pie' ? c.series.slice(0, 1) : c.series;
  const points: ChartPoint[] = capped.map((row) => {
    const point: ChartPoint = { x: valueToText(row[c.x], rt.format) };
    for (const s of series) {
      const n = toNumber(row[s.key]);
      point[s.key] = Number.isFinite(n) ? n : null;
    }
    return point;
  });
  const height = Math.max(120, Math.min(480, typeof c.height === 'number' ? c.height : 240));
  const label = (s: { key: string; label?: string }) => s.label || s.key;

  const ranges = series.map((s) => {
    const values = points.map((p) => p[s.key]).filter((v): v is number => typeof v === 'number');
    if (values.length === 0) return `${label(s)}: no values`;
    return `${label(s)} from ${formatNumber(Math.min(...values), undefined, rt.format)} to ${formatNumber(Math.max(...values), undefined, rt.format)}`;
  });
  const summary = `${TYPE_NAME[c.type]} chart by ${c.x}, ${points.length} ${points.length === 1 ? 'point' : 'points'}: ${ranges.join('; ')}`;

  return (
    <figure className="flex flex-col gap-1 min-w-0" data-testid="inline-ui-chart">
      <div role="img" aria-label={summary} style={{ height }} className="w-full min-w-0">
        <Suspense fallback={<div className="h-full w-full animate-pulse rounded-md bg-surface-container-high/50" />}>
          <ChartImpl type={c.type} points={points} series={series.map((s) => ({ key: s.key, label: label(s) }))} stacked={!!c.stacked} />
        </Suspense>
      </div>
      {rows.length > capped.length && <p className="text-xs text-on-surface-variant">Showing the first {capped.length} of {rows.length} points.</p>}
      <details className="text-xs text-on-surface-variant">
        <summary className="cursor-pointer select-none hover:text-on-surface">Show data</summary>
        <div className="mt-1 max-h-60 overflow-auto rounded-md border border-outline-variant/50">
          <table className="w-full border-collapse text-xs">
            <caption className="sr-only">{summary}</caption>
            <thead className="bg-surface-container-high">
              <tr>
                <th scope="col" className="px-2 py-1 text-left font-medium">{c.x}</th>
                {series.map((s) => <th key={s.key} scope="col" className="px-2 py-1 text-right font-medium">{label(s)}</th>)}
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={i} className="border-t border-outline-variant/30 text-on-surface">
                  <th scope="row" className="px-2 py-1 text-left font-normal">{p.x}</th>
                  {series.map((s) => <td key={s.key} className="px-2 py-1 text-right tabular-nums">{p[s.key] === null ? '—' : formatNumber(p[s.key], undefined, rt.format)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
