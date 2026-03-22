'use client';

import { useQuery } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Agent {
  id: string;
  status: string;
  topic?: string;
  model: string;
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

  const getStatusDot = (status: string) => {
    switch (status) {
      case 'running':
        return <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />;
      case 'paused':
        return <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />;
      case 'completed':
        return <span className="w-1.5 h-1.5 rounded-full bg-primary" />;
      default:
        return <span className="w-1.5 h-1.5 rounded-full bg-on-surface-variant" />;
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Active Agents</CardTitle>
          <span className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">
            {agents.length} total
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-on-surface-variant">
            <Bot className="w-8 h-8 mb-2 opacity-40" />
            <p className="text-sm">No active agents</p>
          </div>
        ) : (
          <div className="divide-y divide-outline-variant/5">
            {agents.slice(0, 5).map((agent) => (
              <div
                key={agent.id}
                className="flex items-center justify-between py-3 hover:bg-surface-container-high/50 -mx-2 px-2 rounded-lg transition-colors"
              >
                <div className="flex items-center gap-3">
                  {getStatusDot(agent.status)}
                  <div>
                    <p className="font-medium text-white text-sm">
                      {agent.topic || 'General'}
                    </p>
                    <p className="text-xs text-on-surface-variant">
                      {agent.model}
                    </p>
                  </div>
                </div>
                <span
                  className={cn(
                    'text-[10px] uppercase tracking-widest font-bold px-2.5 py-1 rounded-full',
                    agent.status === 'running'
                      ? 'bg-emerald-500/10 text-emerald-400'
                      : agent.status === 'paused'
                        ? 'bg-amber-500/10 text-amber-400'
                        : 'bg-surface-container-high text-on-surface-variant'
                  )}
                >
                  {agent.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
