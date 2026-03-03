'use client';

import { useQuery } from '@tanstack/react-query';
import { Bot, PlayCircle, PauseCircle, CheckCircle } from 'lucide-react';
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

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'running':
        return <PlayCircle className="w-4 h-4 text-green-500" />;
      case 'paused':
        return <PauseCircle className="w-4 h-4 text-yellow-500" />;
      case 'completed':
        return <CheckCircle className="w-4 h-4 text-blue-500" />;
      default:
        return <Bot className="w-4 h-4 text-gray-500" />;
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active Agents</CardTitle>
      </CardHeader>
      <CardContent>
        {agents.length === 0 ? (
          <p className="text-center text-gray-500 dark:text-gray-400 py-8">
            No active agents
          </p>
        ) : (
          <div className="space-y-3">
            {agents.slice(0, 5).map((agent) => (
              <div
                key={agent.id}
                className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg"
              >
                <div className="flex items-center gap-3">
                  {getStatusIcon(agent.status)}
                  <div>
                    <p className="font-medium text-gray-900 dark:text-gray-100 text-sm">
                      {agent.topic || 'General'}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {agent.model}
                    </p>
                  </div>
                </div>
                <span
                  className={cn(
                    'text-xs font-medium px-2 py-1 rounded',
                    agent.status === 'running'
                      ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                      : 'bg-gray-100 text-gray-800 dark:bg-gray-600 dark:text-gray-300'
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
