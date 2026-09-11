'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface Stats {
  totalCost: number; reportedCost?: number; estimatedCost?: number;
  unknownCostRequests?: number; unknownUsageRequests?: number; requestCount: number;
  totalInputTokens: number; totalOutputTokens: number;
  cacheReadTokens?: number; cacheCreationTokens?: number;
}
export function SessionCost({ sessionId }: { sessionId: string }) {
  const { data, isError } = useQuery({
    queryKey: ['session-cost', sessionId],
    queryFn: () => api.get<{ stats: Stats }>(`/models/usage/session/${encodeURIComponent(sessionId)}`),
    refetchInterval: 15000, retry: false,
  });
  if (isError) return <p className="px-4 text-xs text-on-surface-variant">Session usage unavailable</p>;
  const s = data?.stats;
  if (!s?.requestCount) return null;
  return <details className="px-4 py-1 text-xs text-on-surface-variant font-mono">
    <summary className="cursor-pointer">Session cost ${s.totalCost.toFixed(4)}{s.unknownCostRequests ? ' · incomplete' : (s.estimatedCost ?? 0) > 0 ? ' · includes estimates' : ''}</summary>
    <div className="flex flex-wrap gap-x-4 gap-y-1 py-2">
      <span>Reported ${(s.reportedCost ?? 0).toFixed(4)}</span><span>Estimated ${(s.estimatedCost ?? 0).toFixed(4)}</span>
      <span>Unknown cost: {s.unknownCostRequests ?? 0} requests</span>
      {!!s.unknownUsageRequests && <span>Missing token usage: {s.unknownUsageRequests} requests</span>}
      <span>Input {s.totalInputTokens.toLocaleString()} · output {s.totalOutputTokens.toLocaleString()}</span>
      <span>Cache reads {Number(s.cacheReadTokens ?? 0).toLocaleString()} · writes {Number(s.cacheCreationTokens ?? 0).toLocaleString()}</span>
    </div>
  </details>;
}
