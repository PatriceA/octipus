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
      if (!h) return 3000;
      const statuses = [h.database, h.redis, h.litellm, h.ollama, h.openai, h.anthropic, h.gemini, h.deepseek, h.grok, h.voyage, h.openrouter, h.custom]
        .map(s => s?.status)
        .filter(s => s && s !== 'not_configured');
      const allHealthy = statuses.every(s => s === 'healthy');
      return allHealthy ? 30000 : 5000;
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
    { name: 'active agents',  value: health?.agents?.running || 0,         icon: Bot,             tone: 'text-primary' },
    { name: 'total sessions', value: health?.agents?.total || 0,           icon: MessageSquare,   tone: 'text-tertiary' },
    { name: 'api requests',   value: usage?.stats?.requestCount || 0,      icon: Activity,        tone: 'text-primary' },
    { name: 'total cost',     value: `$${(usage?.stats?.totalCost || 0).toFixed(2)}`, icon: Zap, tone: 'text-warning' },
  ];

  const runningAgents = health?.agents?.running ?? 0;
  const statusVariant = runningAgents > 0 ? 'success' : 'neutral';
  const statusLabel = runningAgents > 0 ? `${runningAgents} live` : 'idle';

  return (
    <div className="space-y-6 font-mono">
      {/* Page header — TUI-style title row: `❯ dashboard` + status. */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-primary text-lg font-bold" aria-hidden>❯</span>
          <h1 className="text-xl text-on-surface">dashboard</h1>
          <StatusBadge variant={statusVariant} dot pulse={runningAgents > 0}>
            {statusLabel}
          </StatusBadge>
        </div>
        <p className="text-[12px] text-on-surface-variant">
          live overview · agents · sessions · token usage · system health
        </p>
      </div>

      {/* Stat counters. Big mono number, label as `▸ name` so they
          read like ticker rows rather than marketing cards. */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {stats.map((stat) => (
          <Card key={stat.name} variant="default" className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-on-surface-variant">
                  <span aria-hidden className="text-outline-variant">▸</span>
                  {stat.name}
                </p>
                <p className="mt-2 text-3xl text-on-surface tabular-nums">
                  {stat.value}
                </p>
              </div>
              <stat.icon className={`w-4 h-4 mt-1 shrink-0 ${stat.tone}`} aria-hidden />
            </div>
          </Card>
        ))}
      </div>

      <HealthStatus health={health?.health} isFetching={healthFetching} />

      <FeatureStatus />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <UsageChart />
        <ActiveAgents />
      </div>

      <RecentSessions />
    </div>
  );
}
