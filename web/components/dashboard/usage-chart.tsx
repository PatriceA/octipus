'use client';

import { useQuery } from '@tanstack/react-query';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';

interface DailyUsage {
  date: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

export function UsageChart() {
  const { data } = useQuery({
    queryKey: ['usage-daily'],
    queryFn: async () => {
      try {
        return await api.get<DailyUsage[] | { daily: DailyUsage[] }>('/models/usage/daily?days=14');
      } catch {
        return { daily: [] };
      }
    },
  });

  const dailyData: DailyUsage[] = Array.isArray(data) ? data : ((data as { daily: DailyUsage[] })?.daily || []);
  const chartData = dailyData.map((d: any) => ({
    date: new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    tokens: ((d.inputTokens || 0) + (d.outputTokens || 0)) / 1000,
    cost: d.cost || 0,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>token usage · 14d</CardTitle>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-outline-variant">k tokens</span>
      </CardHeader>
      <CardContent>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              {/* Grid + axes in the new dim-blue palette so the chart reads
                  like an oscilloscope trace rather than a marketing graph. */}
              <CartesianGrid strokeDasharray="2 4" stroke="#2A2A2A" strokeOpacity={0.7} />
              <XAxis
                dataKey="date"
                tick={{ fill: '#8A8A8A', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}
                tickLine={false}
                axisLine={{ stroke: '#2A2A2A' }}
              />
              <YAxis
                tick={{ fill: '#8A8A8A', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}
                tickLine={false}
                axisLine={false}
                width={32}
              />
              <Tooltip
                formatter={(value) => [`${Number(value).toFixed(1)}K`, 'tokens']}
                contentStyle={{
                  background: '#151515',
                  border: '1px solid #2A2A2A',
                  borderRadius: 4,
                  color: '#FFFFFF',
                  fontSize: 11,
                  fontFamily: 'JetBrains Mono, monospace',
                  padding: '4px 8px',
                }}
                labelStyle={{ color: '#8A8A8A', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}
                itemStyle={{ color: '#8CACFF' }}
                cursor={{ stroke: '#767575', strokeDasharray: '2 4' }}
              />
              <Line
                type="monotone"
                dataKey="tokens"
                stroke="#8CACFF"
                strokeWidth={1.5}
                dot={false}
                activeDot={{ r: 3, fill: '#8CACFF', stroke: '#0E0E0E', strokeWidth: 2 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
