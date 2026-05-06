'use client';

import { useQuery } from '@tanstack/react-query';
import { Activity, Bot, MessageSquare, Zap } from 'lucide-react';
import { ActiveAgents } from '@/components/dashboard/active-agents';
import { FeatureStatus } from '@/components/dashboard/feature-status';
import { HealthStatus } from '@/components/dashboard/health-status';
import { RecentSessions } from '@/components/dashboard/recent-sessions';
import { UsageChart } from '@/components/dashboard/usage-chart';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
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
    grok: ServiceHealth;
    voyage: ServiceHealth;
    openrouter: ServiceHealth;
    custom: ServiceHealth;
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
      const statuses = [h.database, h.redis, h.litellm, h.ollama, h.openai, h.anthropic, h.gemini, h.deepseek, h.grok, h.voyage, h.openrouter, h.custom]
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

  const runningAgents = health?.agents?.running ?? 0;
  const statusVariant = runningAgents > 0 ? 'success' : 'neutral';
  const statusLabel = runningAgents > 0 ? `${runningAgents} live` : 'idle';

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-extrabold tracking-tighter text-white font-headline">Dashboard</h1>
            <StatusBadge variant={statusVariant} dot pulse={runningAgents > 0}>
              {statusLabel}
            </StatusBadge>
          </div>
          <p className="text-on-surface-variant">
            Live overview of your AI infrastructure — active agents, sessions, token usage, and system health.
          </p>
        </div>
      </div>

      {/* Bento Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => (
          <Card key={stat.name} variant="bento" className="p-6">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">
                  {stat.name}
                </p>
                <p className="mt-2 text-4xl font-extrabold tracking-tight text-white font-headline">
                  {stat.value}
                </p>
              </div>
              <div className={`p-3 rounded-lg ${stat.iconBg}`}>
                <stat.icon className={`w-5 h-5 ${stat.iconColor}`} />
              </div>
            </div>
          </Card>
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
