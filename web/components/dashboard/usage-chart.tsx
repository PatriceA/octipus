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
              <CartesianGrid strokeDasharray="2 4" stroke="#3A4250" strokeOpacity={0.5} />
              <XAxis
                dataKey="date"
                tick={{ fill: '#8A93A0', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}
                tickLine={false}
                axisLine={{ stroke: '#3A4250' }}
              />
              <YAxis
                tick={{ fill: '#8A93A0', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}
                tickLine={false}
                axisLine={false}
                width={32}
              />
              <Tooltip
                formatter={(value) => [`${Number(value).toFixed(1)}K`, 'tokens']}
                contentStyle={{
                  background: '#161B22',
                  border: '1px solid #3A4250',
                  borderRadius: 4,
                  color: '#E6E6E6',
                  fontSize: 11,
                  fontFamily: 'JetBrains Mono, monospace',
                  padding: '4px 8px',
                }}
                labelStyle={{ color: '#8A93A0', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}
                itemStyle={{ color: '#7AA2D4' }}
                cursor={{ stroke: '#5A6677', strokeDasharray: '2 4' }}
              />
              <Line
                type="monotone"
                dataKey="tokens"
                stroke="#7AA2D4"
                strokeWidth={1.5}
                dot={false}
                activeDot={{ r: 3, fill: '#7AA2D4', stroke: '#0F1216', strokeWidth: 2 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
