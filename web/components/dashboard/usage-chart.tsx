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
        <div className="flex items-center justify-between">
          <CardTitle>Token Usage (14 days)</CardTitle>
          <span className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">
            K tokens
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#484847" strokeOpacity={0.2} />
              <XAxis
                dataKey="date"
                tick={{ fill: '#adaaaa', fontSize: 10, fontWeight: 700 }}
                tickLine={false}
                axisLine={{ stroke: '#484847', strokeOpacity: 0.2 }}
              />
              <YAxis
                tick={{ fill: '#adaaaa', fontSize: 10, fontWeight: 700 }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                formatter={(value) => [`${Number(value).toFixed(1)}K tokens`, 'Usage']}
                contentStyle={{
                  background: '#1a1a1a',
                  border: '1px solid rgba(72, 72, 71, 0.2)',
                  borderRadius: '0.75rem',
                  color: '#ffffff',
                  fontSize: '12px',
                  fontWeight: 700,
                }}
                labelStyle={{ color: '#adaaaa', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700 }}
                itemStyle={{ color: '#8cacff' }}
              />
              <Line
                type="monotone"
                dataKey="tokens"
                stroke="#8cacff"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: '#8cacff', stroke: '#0e0e0e', strokeWidth: 2 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
