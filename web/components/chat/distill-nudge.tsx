import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, X } from 'lucide-react';
import type { DistillNudgeDecision, DistillNudgeOutcome, DistillNudgeView } from '../../../src/shared/distill-nudge';
import { api } from '@/lib/api';

/**
 * The offer to distil the latest finished run into a skill
 * (docs/SESSION-LEARNING.md, "Offer to distil a finished task"). The server
 * decides whether there is one; this strip only shows it and sends the
 * owner's decision. Accepting files a pending proposal, which is still
 * approved on Skills → Proposals.
 *
 * `refreshKey` changes when a turn of the session answered: the offer is
 * read again then (it lapses once another answer follows it).
 */
export default function DistillNudge({ sessionId, refreshKey, hidden }: { sessionId: string | null; refreshKey: number; hidden?: boolean }) {
  const client = useQueryClient();
  const key = ['distill-nudge', sessionId, refreshKey];
  const query = useQuery({
    queryKey: key, enabled: !!sessionId,
    queryFn: () => api.get<{ nudge: DistillNudgeView | null }>(`/sessions/${sessionId}/distill-nudge`),
  });
  const decide = useMutation({
    mutationFn: (decision: DistillNudgeDecision) =>
      api.post<DistillNudgeOutcome>(`/sessions/${sessionId}/distill-nudge/${query.data?.nudge?.messageId}`, { decision }),
    onSuccess: (outcome) => {
      if (outcome.state === 'dismissed') client.setQueryData(key, { nudge: null });
      if (outcome.optedOut) void client.invalidateQueries({ queryKey: ['profile'] });
    },
  });
  if (!sessionId || hidden) return null;
  const outcome = decide.data;
  if (outcome?.state === 'accepted') {
    return <div role="status" data-testid="distill-nudge" className="mx-4 my-1 flex items-center gap-2 rounded-lg border border-outline-variant/20 px-3 py-2 text-xs text-on-surface-variant">
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
      <span className="flex-1">{outcome.message}</span>
      {outcome.distilled && <a href="/skills/proposals" className="text-primary hover:underline">Review proposal</a>}
    </div>;
  }
  if (!query.data?.nudge) return null;
  const busy = decide.isPending;
  return <div role="region" aria-label="Distil into a skill" data-testid="distill-nudge"
    className="mx-4 my-1 flex flex-wrap items-center gap-2 rounded-lg border border-outline-variant/20 px-3 py-2 text-xs text-on-surface-variant">
    <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
    <span className="flex-1">That took several steps. Save how it was done as a skill? You review it before it is used.</span>
    <button type="button" disabled={busy} onClick={() => decide.mutate('accept')}
      className="rounded bg-primary/10 px-2 py-1 text-primary disabled:opacity-50">{busy && decide.variables === 'accept' ? 'Distilling…' : 'Distil into a skill'}</button>
    <button type="button" disabled={busy} onClick={() => decide.mutate('never')}
      className="rounded px-2 py-1 hover:bg-surface-container-high disabled:opacity-50">Don't ask again</button>
    <button type="button" disabled={busy} onClick={() => decide.mutate('dismiss')} title="Not now" aria-label="Not now"
      className="rounded p-1 hover:bg-surface-container-high disabled:opacity-50"><X className="h-3.5 w-3.5" /></button>
    {decide.isError && <p role="alert" className="w-full text-error">{String(decide.error?.message ?? 'Could not distil this run')}</p>}
  </div>;
}
