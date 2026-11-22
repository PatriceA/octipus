'use client';

/** The recharts drawing of a view's Chart, split out so recharts loads only where a chart is shown. */
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ChartPoint } from './chart';

/** Series colours from the theme tokens, so a chart follows light and dark. */
const COLORS = ['var(--color-primary)', 'var(--color-secondary)', 'var(--color-accent)', 'var(--color-tertiary)', 'var(--color-warning)', 'var(--color-error)'];
const color = (i: number) => COLORS[i % COLORS.length];

const axis = { fill: 'var(--color-on-surface-variant)', fontSize: 11 };
const tooltip = {
  contentStyle: { background: 'var(--color-surface-container-high)', border: '1px solid var(--color-outline-variant)', borderRadius: 6, color: 'var(--color-on-surface)', fontSize: 12, padding: '4px 8px' },
  labelStyle: { color: 'var(--color-on-surface-variant)', fontSize: 11 },
  itemStyle: { color: 'var(--color-on-surface)' },
  cursor: { fill: 'var(--color-surface-container-highest)', fillOpacity: 0.4 },
};
const legend = { wrapperStyle: { fontSize: 12, color: 'var(--color-on-surface-variant)' } };

export default function ViewChart({ type, points, series, stacked }: {
  type: 'bar' | 'line' | 'area' | 'pie';
  points: ChartPoint[];
  series: Array<{ key: string; label: string }>;
  stacked: boolean;
}) {
  if (type === 'pie') {
    const s = series[0];
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          {s && (
            <Pie data={points} dataKey={s.key} nameKey="x" innerRadius="45%" outerRadius="80%" stroke="var(--color-surface-container-low)" isAnimationActive={false}>
              {points.map((p, i) => <Cell key={`${p.x}:${i}`} fill={color(i)} />)}
            </Pie>
          )}
          <Tooltip {...tooltip} />
          <Legend {...legend} />
        </PieChart>
      </ResponsiveContainer>
    );
  }
  const stack = stacked ? 'stack' : undefined;
  const common = (
    <>
      <CartesianGrid strokeDasharray="2 4" stroke="var(--color-outline-variant)" strokeOpacity={0.7} vertical={false} />
      <XAxis dataKey="x" tick={axis} tickLine={false} axisLine={{ stroke: 'var(--color-outline-variant)' }} minTickGap={8} />
      <YAxis tick={axis} tickLine={false} axisLine={false} width={44} />
      <Tooltip {...tooltip} />
      {series.length > 1 && <Legend {...legend} />}
    </>
  );
  const margin = { top: 8, right: 8, bottom: 0, left: 0 };
  return (
    <ResponsiveContainer width="100%" height="100%">
      {type === 'bar' ? (
        <BarChart data={points} margin={margin}>
          {common}
          {series.map((s, i) => <Bar key={s.key} dataKey={s.key} name={s.label} fill={color(i)} stackId={stack} radius={stacked ? 0 : [3, 3, 0, 0]} isAnimationActive={false} />)}
        </BarChart>
      ) : type === 'area' ? (
        <AreaChart data={points} margin={margin}>
          {common}
          {series.map((s, i) => <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={color(i)} fill={color(i)} fillOpacity={0.18} stackId={stack} isAnimationActive={false} />)}
        </AreaChart>
      ) : (
        <LineChart data={points} margin={margin}>
          {common}
          {series.map((s, i) => <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={color(i)} strokeWidth={2} dot={points.length <= 24} isAnimationActive={false} />)}
        </LineChart>
      )}
    </ResponsiveContainer>
  );
}
