'use client';

import { useQuery } from '@tanstack/react-query';
import { Activity, Bot, MessageSquare, Zap } from 'lucide-react';
import { HealthStatus } from '@/components/dashboard/health-status';
import { FeatureStatus } from '@/components/dashboard/feature-status';
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
    ollama: ServiceHealth;
    openai: ServiceHealth;
    anthropic: ServiceHealth;
    gemini: ServiceHealth;
    deepseek: ServiceHealth;
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
      const statuses = [h.database, h.redis, h.litellm, h.ollama, h.openai, h.anthropic, h.gemini, h.deepseek]
        .map(s => s?.status)
        .filter(s => s && s !== 'not_configured');
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
        <p className="mt-2 text-on-surface-variant">Live overview of your AI infrastructure — active agents, sessions, token usage, and system health.</p>
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

      {/* System Health */}
      <HealthStatus health={health?.health} isFetching={healthFetching} />

      {/* Feature Status */}
      <FeatureStatus />

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
