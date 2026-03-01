'use client';

import { useQuery } from '@tanstack/react-query';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
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
        <CardTitle>Token Usage (14 days)</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip
                formatter={(value: number) => [`${value.toFixed(1)}K tokens`, 'Usage']}
              />
              <Line
                type="monotone"
                dataKey="tokens"
                stroke="#0ea5e9"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
