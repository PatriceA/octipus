import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import type { DistillNudgeDecision, DistillNudgeOutcome, DistillNudgeView } from '../../../src/shared/distill-nudge';
import { api, ApiError } from '@/lib/api';

/**
 * The offer to distil a finished run into a skill
 * (docs/SESSION-LEARNING.md, "Offer to distil a finished task"). The server
 * decides whether there is one; this strip only shows it and sends the
 * owner's decision. Accepting files a pending proposal, which is still
 * approved on Skills → Proposals.
 *
 * Mounted per session. `refreshKey` changes when that session answered or
 * announced an offer (`session.skill_nudge`): the offer is read again. What
 * a decision returned stays shown until another offer arrives, whatever
 * other turns answer meanwhile.
 */
export default function DistillNudge({ sessionId, refreshKey, hidden }: { sessionId: string | null; refreshKey: number; hidden?: boolean }) {
  const client = useQueryClient();
  const [settled, setSettled] = useState<{ messageId: string; outcome?: DistillNudgeOutcome; closed?: string } | null>(null);
  const query = useQuery({
    queryKey: ['distill-nudge', sessionId, refreshKey], enabled: !!sessionId,
    queryFn: () => api.get<{ nudge: DistillNudgeView | null }>(`/sessions/${sessionId}/distill-nudge`),
  });
  const nudge = query.data?.nudge ?? null;
  const decide = useMutation({
    mutationFn: ({ messageId, decision }: { messageId: string; decision: DistillNudgeDecision }) =>
      api.post<DistillNudgeOutcome>(`/sessions/${sessionId}/distill-nudge/${messageId}`, { decision }),
    onSuccess: (outcome, { messageId }) => {
      setSettled({ messageId, ...(outcome.state === 'accepted' ? { outcome } : {}) });
      if (outcome.optedOut) void client.invalidateQueries({ queryKey: ['profile'] });
    },
    onError: (error, { messageId }) => {
      // Closed for good (a cut-off reply, too many failures) or no longer open: say so, offer nothing more.
      const body = error instanceof ApiError ? error.body : {};
      if (body.final === true || body.code === 'lapsed' || body.code === 'decided') setSettled({ messageId, closed: error.message });
    },
  });
  if (!sessionId || hidden) return null;
  const open = nudge && nudge.messageId !== settled?.messageId ? nudge : null;
  if (!open) {
    if (settled?.outcome) {
      return <div role="status" data-testid="distill-nudge" className="mx-4 my-1 flex items-center gap-2 rounded-lg border border-outline-variant/20 px-3 py-2 text-xs text-on-surface-variant">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="flex-1">{settled.outcome.message}</span>
        {settled.outcome.distilled && <a href="/skills/proposals" className="text-primary hover:underline">Review proposal</a>}
      </div>;
    }
    if (settled?.closed) {
      return <div role="status" data-testid="distill-nudge" className="mx-4 my-1 flex items-center gap-2 rounded-lg border border-outline-variant/20 px-3 py-2 text-xs text-error">
        <span className="flex-1">{settled.closed}</span>
        <button type="button" onClick={() => setSettled({ messageId: settled.messageId })} title="Close" aria-label="Close"
          className="rounded p-1 hover:bg-surface-container-high"><X className="h-3.5 w-3.5" /></button>
      </div>;
    }
    return null;
  }
  const busy = decide.isPending;
  const send = (decision: DistillNudgeDecision) => decide.mutate({ messageId: open.messageId, decision });
  return <div role="region" aria-label="Distil into a skill" data-testid="distill-nudge"
    className="mx-4 my-1 flex flex-wrap items-center gap-2 rounded-lg border border-outline-variant/20 px-3 py-2 text-xs text-on-surface-variant">
    <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
    <span className="flex-1">That took several steps. Save how it was done as a skill? You review it before it is used.</span>
    <button type="button" disabled={busy} onClick={() => send('accept')}
      className="rounded bg-primary/10 px-2 py-1 text-primary disabled:opacity-50">{busy && decide.variables?.decision === 'accept' ? 'Distilling…' : 'Distil into a skill'}</button>
    <button type="button" disabled={busy} onClick={() => send('never')}
      className="rounded px-2 py-1 hover:bg-surface-container-high disabled:opacity-50">Don't ask again</button>
    <button type="button" disabled={busy} onClick={() => send('dismiss')} title="Not now" aria-label="Not now"
      className="rounded p-1 hover:bg-surface-container-high disabled:opacity-50"><X className="h-3.5 w-3.5" /></button>
    {decide.isError && <p role="alert" className="w-full text-error">{String(decide.error?.message ?? 'Could not distil this run')}</p>}
  </div>;
}
