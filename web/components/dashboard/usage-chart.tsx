'use client';

import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';

// recharts is most of the dashboard's weight; the card and its data load
// first and the chart fills the reserved space when its chunk arrives.
const UsageLineChart = lazy(() => import('./usage-line-chart'));

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
          <Suspense fallback={null}>
            <UsageLineChart data={chartData} />
          </Suspense>
        </div>
      </CardContent>
    </Card>
  );
}
