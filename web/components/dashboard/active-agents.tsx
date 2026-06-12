'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge, type StatusVariant } from '@/components/ui/status-badge';
import { api } from '@/lib/api';

interface Agent {
  id: string;
  status: string;
  topic?: string;
  model: string;
}

function statusVariant(status: string): StatusVariant {
  switch (status) {
    case 'running':   return 'success';
    case 'paused':    return 'warning';
    case 'completed': return 'info';
    default:          return 'neutral';
  }
}

export function ActiveAgents() {
  const { data } = useQuery({
    queryKey: ['agents'],
    queryFn: async () => {
      try {
        return await api.get<Agent[] | { agents: Agent[] }>('/agents');
      } catch {
        return [];
      }
    },
    refetchInterval: 5000,
  });

  const agents: Agent[] = Array.isArray(data) ? data : ((data as { agents: Agent[] })?.agents || []);
  const anyRunning = agents.some((a) => a.status === 'running');

  return (
    <Card glow={anyRunning ? 'ok' : undefined}>
      <CardHeader>
        <CardTitle>active agents</CardTitle>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-outline-variant">
          {agents.length} total
        </span>
      </CardHeader>
      <CardContent className="p-0">
        {agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-on-surface-variant">
            <p aria-hidden className="text-[16px] text-outline mb-1">[ ]</p>
            <p className="text-[12px]">no active agents</p>
          </div>
        ) : (
          <div className="divide-y divide-outline-variant/40">
            {agents.slice(0, 5).map((agent) => (
              <div
                key={agent.id}
                className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-surface-container-high transition-colors"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span
                    aria-hidden
                    className={`dot ${agent.status === 'running' ? 'dot-ok dot-live text-tertiary' : agent.status === 'paused' ? 'dot-warn' : 'dot-idle'}`}
                  />
                  <div className="min-w-0">
                    <p className="text-[13px] text-on-surface truncate">
                      {agent.topic || 'general'}
                    </p>
                    <p className="text-[11px] text-on-surface-variant truncate">
                      {agent.model}
                    </p>
                  </div>
                </div>
                <StatusBadge variant={statusVariant(agent.status)} dot={false}>
                  {agent.status}
                </StatusBadge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
