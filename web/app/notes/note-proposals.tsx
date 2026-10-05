'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, GitPullRequestArrow, X } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

/** A proposal as `GET /notes/proposals` returns it (`note_edit_proposals`). */
interface ProposalRow {
  id: string;
  noteId: string;
  userId: string;
  agentId: string | null;
  action: 'edit' | 'capture' | 'meeting' | 'archive';
  title: string | null;
  baseBody: string;
  body: string;
  status: 'pending' | 'accepted' | 'rejected' | 'stale';
  updatedAt: string;
}

interface StaleView {
  base: string;
  current: string;
  proposed: string;
}

type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

/** A line diff (LCS) of two texts, for the proposal view. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  // Notes are capped (spaces.noteMaxBytes): the table stays small enough.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: 'del', text: a[i++] });
    else out.push({ kind: 'add', text: b[j++] });
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] });
  while (j < m) out.push({ kind: 'add', text: b[j++] });
  return out;
}

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <pre data-testid="proposal-diff" className="max-h-56 overflow-auto rounded-xs bg-surface-container-lowest p-2 text-[11px] leading-relaxed">
      {lineDiff(before, after).map((line, k) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no identity
          key={k}
          className={cn(line.kind === 'add' && 'bg-success/15 text-success', line.kind === 'del' && 'bg-error/15 text-error line-through')}
        >
          {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}{line.text}
        </div>
      ))}
    </pre>
  );
}

const ACTION_LABEL: Record<ProposalRow['action'], string> = {
  edit: 'edit',
  capture: 'capture',
  meeting: 'meeting notes',
  archive: 'archive the note',
};

/**
 * The agent's pending edit proposals for a space note (§7.4, §7.6): each
 * with a diff from the text the agent read, Accept (applied through the
 * live document, merged with what changed since) and Reject. A proposal
 * whose change collides with a newer edit comes back stale with the three
 * texts side by side.
 */
export function NoteProposals({ noteId, canWrite }: { noteId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const [stale, setStale] = useState<Record<string, StaleView>>({});
  const list = useQuery<{ proposals: ProposalRow[] }>({
    queryKey: ['note-proposals', noteId],
    queryFn: () => api.get(`/notes/proposals?noteId=${noteId}&status=pending`),
    refetchInterval: 15_000,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['note-proposals', noteId] });
    qc.invalidateQueries({ queryKey: ['note-revisions', noteId] });
  };
  const accept = useMutation({
    mutationFn: async (id: string) => {
      try {
        return await api.post<{ status: 'accepted' | 'stale' }>(`/notes/proposals/${id}/accept`, {});
      } catch (err) {
        // 409 with the three-way view: the proposal is stale.
        if (err instanceof ApiError && err.status === 409 && 'proposed' in err.body) {
          const view = err.body as unknown as StaleView;
          setStale((s) => ({ ...s, [id]: view }));
          return { status: 'stale' as const };
        }
        throw err;
      }
    },
    onSettled: refresh,
  });
  const reject = useMutation({
    mutationFn: (id: string) => api.post(`/notes/proposals/${id}/reject`, {}),
    onSettled: refresh,
  });

  const proposals = list.data?.proposals ?? [];
  const staleIds = Object.keys(stale);
  if (proposals.length === 0 && staleIds.length === 0) {
    return (
      <section data-testid="note-proposals" className="space-y-1">
        <h3 className="section-label text-[10px] mb-1 flex items-center gap-1.5"><GitPullRequestArrow size={11} /> proposals</h3>
        <p className="text-[12px] text-on-surface-variant/60">No pending proposals from the agent.</p>
      </section>
    );
  }
  return (
    <section data-testid="note-proposals" className="space-y-2">
      <h3 className="section-label text-[10px] mb-1 flex items-center gap-1.5"><GitPullRequestArrow size={11} /> proposals · {proposals.length}</h3>
      {(accept.error || reject.error) && <p role="alert" className="text-[11px] text-error">{(accept.error ?? reject.error)?.message}</p>}
      {proposals.map((p) => (
        <div key={p.id} data-testid="note-proposal" className="rounded-xs border border-outline-variant/30 p-2 space-y-1.5">
          <div className="text-[11px] text-on-surface-variant">
            The agent proposes to {ACTION_LABEL[p.action]}{p.title ? ` (title: ${p.title})` : ''} · {new Date(p.updatedAt).toLocaleTimeString()}
          </div>
          {p.action !== 'archive' && <Diff before={p.baseBody} after={p.body} />}
          {canWrite && (
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={accept.isPending}
                onClick={() => accept.mutate(p.id)}
                className="inline-flex items-center gap-1 rounded-xs bg-primary px-2 py-0.5 text-[11px] text-on-primary disabled:opacity-40"
              >
                <Check size={11} /> accept
              </button>
              <button
                type="button"
                disabled={reject.isPending}
                onClick={() => reject.mutate(p.id)}
                className="inline-flex items-center gap-1 rounded-xs border border-outline-variant/40 px-2 py-0.5 text-[11px] disabled:opacity-40"
              >
                <X size={11} /> reject
              </button>
            </div>
          )}
        </div>
      ))}
      {staleIds.map((id) => (
        <div key={id} data-testid="proposal-stale" className="rounded-xs border border-warning/40 p-2 space-y-1.5">
          <div className="flex items-center text-[11px] text-warning">
            <span className="flex-1">This proposal collides with a newer edit and was not applied.</span>
            <button type="button" onClick={() => setStale(({ [id]: _drop, ...rest }) => rest)} className="text-on-surface-variant" title="Dismiss"><X size={11} /></button>
          </div>
          <div className="text-[10px] text-on-surface-variant">The agent read → it proposed</div>
          <Diff before={stale[id].base} after={stale[id].proposed} />
          <div className="text-[10px] text-on-surface-variant">The agent read → the note now</div>
          <Diff before={stale[id].base} after={stale[id].current} />
        </div>
      ))}
    </section>
  );
}
