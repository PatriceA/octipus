'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Puzzle } from 'lucide-react';
import { api } from '@/lib/api';
import { ConnectorCard } from './connector-card';
import { CocoIndexCard } from './cocoindex-card';

interface ConnectorStatus {
  id: string;
  name: string;
  description: string;
  logoUrl: string;
  connected: boolean;
  expiresAt?: string;
}

export function ConnectorsTab() {
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['connectors'],
    queryFn: () => api.get<{ connectors: ConnectorStatus[] }>('/connectors'),
    refetchInterval: 30_000,
  });

  const connectors = data?.connectors ?? [];

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['connectors'] });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-medium text-on-surface">Built-in Connectors</h2>
        <p className="text-xs text-on-surface-variant mt-0.5">
          Connect an account or install an optional local service for agents to use through MCP.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-6 text-on-surface-variant text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading connectors...
        </div>
      ) : error ? (
        <p role="alert" className="text-sm text-error">Could not load account connectors: {error.message}</p>
      ) : connectors.length === 0 ? (
        <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-8 text-center">
          <Puzzle className="w-8 h-8 text-on-surface-variant mx-auto mb-2" />
          <p className="text-on-surface-variant">No connectors available</p>
        </div>
      ) : (
        <div className="space-y-3">
          {connectors.map((c) => (
            <ConnectorCard
              key={c.id}
              id={c.id}
              name={c.name}
              description={c.description}
              logoUrl={c.logoUrl}
              connected={c.connected}
              expiresAt={c.expiresAt}
              onStatusChange={refresh}
            />
          ))}
        </div>
      )}
      <CocoIndexCard />
    </div>
  );
}
