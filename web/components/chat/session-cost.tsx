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
  const { data, isError, errorUpdatedAt, dataUpdatedAt, isFetching, refetch } = useQuery({
    queryKey: ['session-cost', sessionId],
    queryFn: async () => {
      const response = await api.get<{ stats: Stats }>(`/models/usage/session/${encodeURIComponent(sessionId)}`);
      const stats = response?.stats;
      if (!stats || ![stats.requestCount, stats.totalCost, stats.totalInputTokens, stats.totalOutputTokens].every(value => typeof value === 'number' && Number.isFinite(value))) {
        throw new Error('Invalid session usage response');
      }
      return response;
    },
    refetchInterval: 15000, retry: false,
  });
  const s = data?.stats;
  // React Query can return to pending during an initial-error retry. Keep the
  // error visible until a successful response, and preserve cached totals.
  const unavailable = isError || errorUpdatedAt > dataUpdatedAt;
  const retry = <button type="button" className="ml-2 underline disabled:opacity-60" disabled={isFetching} onClick={() => void refetch()}>
    {isFetching ? 'Retrying…' : 'Retry usage'}
  </button>;
  if (!s) return <div data-testid="session-usage" className="min-h-7 shrink-0 px-4 py-1 text-xs text-on-surface-variant">
    {unavailable ? <>Session usage unavailable{retry}</> : 'Loading session usage…'}
  </div>;
  if (!s.requestCount) return <div data-testid="session-usage" className="min-h-7 shrink-0 px-4 py-1 text-xs text-on-surface-variant">
    No session usage recorded{unavailable && <> · update unavailable{retry}</>}
  </div>;
  return <details data-testid="session-usage" className="min-h-7 shrink-0 px-4 py-1 text-xs text-on-surface-variant font-mono">
    <summary className="cursor-pointer">Session cost ${s.totalCost.toFixed(4)}{s.unknownCostRequests ? ' · incomplete' : (s.estimatedCost ?? 0) > 0 ? ' · includes estimates' : ''}{unavailable && ' · update unavailable'}</summary>
    {unavailable && <p>Showing the last recorded usage.{retry}</p>}
    <div className="flex flex-wrap gap-x-4 gap-y-1 py-2">
      <span>Reported ${(s.reportedCost ?? 0).toFixed(4)}</span><span>Estimated ${(s.estimatedCost ?? 0).toFixed(4)}</span>
      <span>Unknown cost: {s.unknownCostRequests ?? 0} requests</span>
      {!!s.unknownUsageRequests && <span>Missing token usage: {s.unknownUsageRequests} requests</span>}
      <span>Input {s.totalInputTokens.toLocaleString()} · output {s.totalOutputTokens.toLocaleString()}</span>
      <span>Cache reads {Number(s.cacheReadTokens ?? 0).toLocaleString()} · writes {Number(s.cacheCreationTokens ?? 0).toLocaleString()}</span>
    </div>
  </details>;
}
