'use client';

import { useQuery } from '@tanstack/react-query';
import { Activity, Bot, MessageSquare, Zap } from 'lucide-react';
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
      iconBg: 'bg-primary/10',
      iconColor: 'text-primary',
      trend: null,
    },
    {
      name: 'Total Sessions',
      value: health?.agents?.total || 0,
      icon: MessageSquare,
      iconBg: 'bg-emerald-500/10',
      iconColor: 'text-emerald-400',
      trend: null,
    },
    {
      name: 'API Requests',
      value: usage?.stats?.requestCount || 0,
      icon: Activity,
      iconBg: 'bg-primary/10',
      iconColor: 'text-primary',
      trend: null,
    },
    {
      name: 'Total Cost',
      value: `$${(usage?.stats?.totalCost || 0).toFixed(2)}`,
      icon: Zap,
      iconBg: 'bg-amber-500/10',
      iconColor: 'text-amber-400',
      trend: null,
    },
  ];

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <h1 className="text-4xl font-extrabold tracking-tighter text-white">Dashboard</h1>
        <p className="mt-1 text-sm text-on-surface-variant">Overview of your assistant&apos;s activity</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => (
          <div key={stat.name} className="bg-surface-container rounded-[1rem] p-6 ring-1 ring-outline-variant/10">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">
                  {stat.name}
                </p>
                <p className="mt-2 text-4xl font-extrabold tracking-tight text-white">
                  {stat.value}
                </p>
              </div>
              <div className={`p-3 rounded-full ${stat.iconBg}`}>
                <stat.icon className={`w-5 h-5 ${stat.iconColor}`} />
              </div>
            </div>
          </div>
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
