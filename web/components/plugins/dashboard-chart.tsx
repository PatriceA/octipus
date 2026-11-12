'use client';

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
import type { PluginWidgetData } from '../../../src/shared/plugin-package';

type ChartData = Extract<PluginWidgetData, { type: 'chart' }>;

/** Series colours, in the app's palette. */
const COLORS = ['#8CACFF', '#7FD1AE', '#F2C97D', '#F28B82', '#C3A6FF', '#7CD4E8', '#F6AE7B', '#B0B0B0'];

const axis = { fill: '#8A8A8A', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' };
const tooltip = {
  contentStyle: { background: '#151515', border: '1px solid #2A2A2A', borderRadius: 4, color: '#FFFFFF', fontSize: 11, padding: '4px 8px' },
  labelStyle: { color: '#8A8A8A', fontSize: 10 },
};

/**
 * A plugin dashboard's chart widget (docs/PLUGIN-PACKAGES.md#dashboards),
 * drawn from checked data: points keyed by `x` and each series' key.
 * Split out so recharts loads only where a dashboard has a chart.
 */
export default function DashboardChart({ data }: { data: ChartData }) {
  const points = data.points.map((p) => ({ ...p, [data.x]: String(p[data.x] ?? '') }));
  if (data.kind === 'pie') {
    const series = data.series[0];
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={points} dataKey={series.key} nameKey={data.x} innerRadius="45%" outerRadius="80%" stroke="#0E0E0E">
            {points.map((p, i) => <Cell key={String(p[data.x])} fill={COLORS[i % COLORS.length]} />)}
          </Pie>
          <Tooltip {...tooltip} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
    );
  }
  const common = (
    <>
      <CartesianGrid strokeDasharray="2 4" stroke="#2A2A2A" strokeOpacity={0.7} />
      <XAxis dataKey={data.x} tick={axis} tickLine={false} axisLine={{ stroke: '#2A2A2A' }} />
      <YAxis tick={axis} tickLine={false} axisLine={false} width={40} />
      <Tooltip {...tooltip} />
      {data.series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
    </>
  );
  const margin = { top: 4, right: 8, bottom: 0, left: 0 };
  return (
    <ResponsiveContainer width="100%" height="100%">
      {data.kind === 'bar' ? (
        <BarChart data={points} margin={margin}>
          {common}
          {data.series.map((s, i) => <Bar key={s.key} dataKey={s.key} name={s.label} fill={COLORS[i % COLORS.length]} />)}
        </BarChart>
      ) : data.kind === 'area' ? (
        <AreaChart data={points} margin={margin}>
          {common}
          {data.series.map((s, i) => (
            <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={COLORS[i % COLORS.length]} fill={COLORS[i % COLORS.length]} fillOpacity={0.15} />
          ))}
        </AreaChart>
      ) : (
        <LineChart data={points} margin={margin}>
          {common}
          {data.series.map((s, i) => <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={COLORS[i % COLORS.length]} strokeWidth={1.5} dot={false} />)}
        </LineChart>
      )}
    </ResponsiveContainer>
  );
}
