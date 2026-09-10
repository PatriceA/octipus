'use client';

import { useQuery } from '@tanstack/react-query';
import { Activity, Bot, MessageSquare, Zap } from 'lucide-react';
import { ActiveAgents } from '@/components/dashboard/active-agents';
import { AwayDigestCard } from '@/components/dashboard/away-digest';
import { FeatureStatus } from '@/components/dashboard/feature-status';
import { HealthStatus } from '@/components/dashboard/health-status';
import { RecentSessions } from '@/components/dashboard/recent-sessions';
import { UsageChart } from '@/components/dashboard/usage-chart';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
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
    storage: ServiceHealth;
    scheduler: ServiceHealth;
    litellm: ServiceHealth;
    ollama: ServiceHealth;
    openai: ServiceHealth;
    anthropic: ServiceHealth;
    gemini: ServiceHealth;
    vertex: ServiceHealth;
    deepseek: ServiceHealth;
    grok: ServiceHealth;
    mistral: ServiceHealth;
    zai: ServiceHealth;
    moonshot: ServiceHealth;
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
  const healthQuery = useQuery({
    queryKey: ['health'],
    retry: false,
    queryFn: async () => await api.get<HealthData>('/health/detailed'),
    refetchInterval: (query) => {
      const h = query.state.data?.health;
      if (!h) return 3000;
      const statuses = [h.database, h.storage, h.litellm, h.ollama, h.openai, h.anthropic, h.gemini, h.deepseek, h.grok, h.mistral, h.zai, h.moonshot, h.voyage, h.openrouter, h.custom]
        .map(s => s?.status)
        .filter(s => s && s !== 'not_configured');
      const allHealthy = statuses.every(s => s === 'healthy');
      return allHealthy ? 30000 : 5000;
    },
  });

  const usageQuery = useQuery({
    queryKey: ['usage'],
    retry: false,
    queryFn: async () => await api.get<UsageData>('/models/usage'),
  });

  // The user's own session count. The card previously showed `health.agents.total`
  // — the GLOBAL agent count — so creating one chat (root agent + worker = 2
  // agents) read as "2 sessions". `total` is the full per-user count.
  const sessionsQuery = useQuery({
    queryKey: ['sessions', 'count'],
    retry: false,
    queryFn: async () => await api.get<{ total?: number }>('/sessions?limit=1'),
  });

  const health = healthQuery.data;
  const usage = usageQuery.data;
  const sessionData = sessionsQuery.data;
  const healthFetching = healthQuery.isFetching;
  const stats = [
    { name: 'active agents', value: health?.agents?.running, icon: Bot, tone: 'text-primary', query: healthQuery },
    { name: 'your sessions', value: sessionData?.total, icon: MessageSquare, tone: 'text-tertiary', query: sessionsQuery },
    { name: 'api requests', value: usage?.stats?.requestCount, icon: Activity, tone: 'text-primary', query: usageQuery },
    { name: 'total cost', value: usage?.stats?.totalCost == null ? undefined : `$${usage.stats.totalCost.toFixed(2)}`, icon: Zap, tone: 'text-warning', query: usageQuery },
  ];
  const runningAgents = health?.agents?.running;
  const statusVariant = healthQuery.isError ? 'neutral' : runningAgents ? 'success' : 'neutral';
  const statusLabel = healthQuery.isError ? 'status unavailable'
    : runningAgents == null ? (healthQuery.isPending ? 'loading' : 'status unavailable')
    : runningAgents > 0 ? `${runningAgents} live` : 'idle';

  return (
    <div className="space-y-6 font-mono">
      {/* Page header — shared `octi:~/dashboard $` path prompt + status. */}
      <PageHeader
        title="dashboard"
        description="live overview · agents · sessions · token usage · system health"
        badge={
          <StatusBadge variant={statusVariant} dot pulse={runningAgents != null && runningAgents > 0}>
            {statusLabel}
          </StatusBadge>
        }
      />

      <div className="flex flex-wrap gap-3 text-sm" aria-label="Start work">
        <a href="/chat" className="text-primary underline">Work on a project</a>
        <a href="/research" className="text-primary underline">Research a question</a>
        <a href="/tasks" className="text-primary underline">Plan follow-up tasks</a>
      </div>

      {/* What happened since the user last looked — the first thing to read. */}
      <AwayDigestCard />

      {/* Stat counters. Big mono number, label as `> name` so they
          read like ticker rows rather than marketing cards. */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 stagger">
        {stats.map((stat) => (
          <Card key={stat.name} variant="default" className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-on-surface-variant">
                  <span aria-hidden className="text-primary font-bold">&gt;</span>
                  {stat.name}
                </p>
                <p className="mt-2 text-3xl text-on-surface tabular-nums">
                  {stat.value ?? (stat.query.isPending ? 'Loading…' : 'Unavailable')}
                </p>
                {stat.query.isError && (
                  <div className="mt-2 text-xs text-warning" role="status">
                    <p>{stat.value != null ? `Stale · last updated ${new Date(stat.query.dataUpdatedAt).toLocaleTimeString()}` : 'Could not load this value.'}</p>
                    <p>{stat.query.error?.message}</p>
                    <button className="underline mt-1" onClick={() => void stat.query.refetch()}>Retry {stat.name}</button>
                  </div>
                )}
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
