'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useWorkspaceId } from '@/lib/workspace-context';

interface UsageStats { requestCount?: number; reportedCost?: number; estimatedCost?: number; unknownCostRequests?: number; cacheReadTokens?: number; cacheCreationTokens?: number; totalInputTokens?: number }
/** Detailed accounting has one home, away from the start screen's work state. */
export function UsageSummary() {
  const workspaceId = useWorkspaceId();
  const query = useQuery({ queryKey: ['usage-summary', workspaceId], retry: false, queryFn: async () => {
    const result = await api.get<{ stats?: UsageStats }>('/models/usage');
    if (!result.stats) throw new Error('Usage statistics are unavailable.');
    return result.stats;
  } });
  const stats = query.data;
  const amount = (value: number | undefined) => value == null ? 'Unavailable' : `$${value.toFixed(4)}`;
  const count = (value: number | undefined) => value == null ? 'Unavailable' : value.toLocaleString();
  return <section className="rounded-xl border border-outline-variant bg-surface-container p-5"><h2 className="text-base font-semibold">Recorded usage</h2>
    {query.isPending ? <p className="text-sm mt-3">Loading usage…</p> : query.error ? <p role="status" className="text-sm mt-3 text-warning">Could not refresh usage. {stats && 'The figures below may be out of date.'} <button className="underline" onClick={() => void query.refetch()}>Retry usage</button></p> : null}
    {stats && <dl className="grid grid-cols-2 md:grid-cols-3 gap-5 mt-5 text-xs">{[
      ['Provider-reported cost', amount(stats.reportedCost)], ['Estimated cost', amount(stats.estimatedCost)], ['Requests with unknown cost', count(stats.unknownCostRequests)],
      ['Requests', count(stats.requestCount)], ['Cache reads', count(stats.cacheReadTokens)], ['Cache writes', count(stats.cacheCreationTokens)],
    ].map(([name, value]) => <div key={name}><dt className="text-on-surface-variant">{name}</dt><dd className="font-semibold mt-2 text-base">{value}</dd></div>)}</dl>}
    <p className="text-xs text-on-surface-variant mt-5">Reported and estimated amounts are separate. Provider billing remains authoritative.</p>
  </section>;
}
