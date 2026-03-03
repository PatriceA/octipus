'use client';

import { useQuery } from '@tanstack/react-query';
import { Activity, Bot, LayoutDashboard, MessageSquare, Zap } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { HealthStatus } from '@/components/dashboard/health-status';
import { UsageChart } from '@/components/dashboard/usage-chart';
import { RecentSessions } from '@/components/dashboard/recent-sessions';
import { ActiveAgents } from '@/components/dashboard/active-agents';
import { api } from '@/lib/api';

interface ServiceHealth {
  status: string;
  latency?: number;
  message?: string;
}

interface HealthData {
  health?: {
    database: ServiceHealth;
    redis: ServiceHealth;
    litellm: ServiceHealth;
  };
  agents?: { running: number; total: number };
}

interface UsageData {
  stats?: { requestCount: number; totalCost: number };
}

export default function DashboardPage() {
  const { data: health, isFetching: healthFetching } = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      try {
        return await api.get<HealthData>('/health/detailed');
      } catch {
        return null;
      }
    },
    refetchInterval: (query) => {
      const h = query.state.data?.health;
      if (!h) return 3000; // No data yet — poll fast
      const statuses = [h.database, h.redis, h.litellm]
        .map(s => s?.status);
      const allHealthy = statuses.every(s => s === 'healthy');
      return allHealthy ? 30000 : 5000; // Slow down once all green
    },
  });

  const { data: usage } = useQuery({
    queryKey: ['usage'],
    queryFn: async () => {
      try {
        return await api.get<UsageData>('/models/usage');
      } catch {
        return null;
      }
    },
  });

  const stats = [
    {
      name: 'Active Agents',
      value: health?.agents?.running || 0,
      icon: Bot,
      color: 'text-blue-600',
    },
    {
      name: 'Total Sessions',
      value: health?.agents?.total || 0,
      icon: MessageSquare,
      color: 'text-green-600',
    },
    {
      name: 'API Requests',
      value: usage?.stats?.requestCount || 0,
      icon: Activity,
      color: 'text-purple-600',
    },
    {
      name: 'Total Cost',
      value: `$${(usage?.stats?.totalCost || 0).toFixed(2)}`,
      icon: Zap,
      color: 'text-orange-600',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary-100 dark:bg-primary-950/40 flex items-center justify-center">
          <LayoutDashboard className="w-5 h-5 text-primary-600 dark:text-primary-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Dashboard</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Overview of your assistant&apos;s activity</p>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => (
          <Card key={stat.name} className="p-5">
            <div className="flex items-center gap-4">
              <div className={`p-3 rounded-xl bg-gray-50 dark:bg-gray-800/60 ${stat.color}`}>
                <stat.icon className="w-6 h-6" />
              </div>
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {stat.name}
                </p>
                <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                  {stat.value}
                </p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Health Status */}
      <HealthStatus health={health?.health} isFetching={healthFetching} />

      {/* Charts and Lists */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <UsageChart />
        <ActiveAgents />
      </div>

      {/* Recent Sessions */}
      <RecentSessions />
    </div>
  );
}
