'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Loader2, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/** A revision as `GET /notes/:id/revisions` lists it (`src/db/repositories/live-documents.ts`). */
interface RevisionRow {
  id: string;
  createdAt: string;
  origin: 'live' | 'external' | 'restore' | 'proposal';
  bodySha256: string;
  size: number;
  authors: Array<{ userId: string; username: string | null }>;
  onBehalfOf: { userId: string; username: string | null } | null;
  restoredFrom: string | null;
}

const ORIGIN_LABEL: Record<RevisionRow['origin'], string> = {
  live: 'edited',
  external: 'saved',
  restore: 'restored',
  proposal: 'accepted a proposal',
};

function who(rev: RevisionRow): string {
  const names = rev.authors.map((a) => a.username ?? 'someone');
  const by = names.length > 0 ? names.join(', ') : 'someone';
  return rev.onBehalfOf ? `${by} for ${rev.onBehalfOf.username ?? 'someone'}` : by;
}

/**
 * A space note's history (§7.6): every saved revision with who made it
 * (and for whom, when an agent wrote), a preview, and Restore — written as
 * a new revision, never by rewinding.
 */
export function NoteHistory({ noteId, canWrite }: { noteId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useQuery<{ revisions: RevisionRow[] }>({
    queryKey: ['note-revisions', noteId],
    queryFn: () => api.get(`/notes/${noteId}/revisions`),
    refetchInterval: 15_000,
  });
  const preview = useQuery<{ revision: { body: string } }>({
    queryKey: ['note-revision', noteId, openId],
    queryFn: () => api.get(`/notes/${noteId}/revisions/${openId}`),
    enabled: !!openId,
  });
  const restore = useMutation({
    mutationFn: (revisionId: string) => api.post(`/notes/${noteId}/revisions/${revisionId}/restore`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['note-revisions', noteId] });
      qc.invalidateQueries({ queryKey: ['note', noteId] });
    },
  });

  const revisions = list.data?.revisions ?? [];
  return (
    <section data-testid="note-history" className="space-y-1">
      <h3 className="section-label text-[10px] mb-1 flex items-center gap-1.5"><History size={11} /> history</h3>
      {list.isLoading && <Loader2 size={12} className="animate-spin text-on-surface-variant" />}
      {!list.isLoading && revisions.length === 0 && <p className="text-[12px] text-on-surface-variant/60">No revisions yet.</p>}
      {restore.error && <p role="alert" className="text-[11px] text-error">{restore.error.message}</p>}
      {revisions.map((rev, i) => (
        <div key={rev.id} data-testid="note-revision" className="rounded-xs border border-outline-variant/30">
          <button
            type="button"
            onClick={() => setOpenId(openId === rev.id ? null : rev.id)}
            className={cn('w-full px-2 py-1 text-left text-[12px] hover:bg-surface-container-high', openId === rev.id && 'bg-surface-container-high')}
          >
            <span className="text-on-surface">{who(rev)}</span>{' '}
            <span className="text-on-surface-variant">{ORIGIN_LABEL[rev.origin]}</span>
            <span className="block text-[10px] text-on-surface-variant/60">
              {new Date(rev.createdAt).toLocaleString()} · {rev.size} bytes{i === 0 ? ' · current' : ''}
            </span>
          </button>
          {openId === rev.id && (
            <div className="border-t border-outline-variant/30 p-2 space-y-2">
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-[11px] text-on-surface-variant">
                {preview.isLoading ? '…' : preview.data?.revision.body || '(empty)'}
              </pre>
              {canWrite && i > 0 && (
                <button
                  type="button"
                  disabled={restore.isPending}
                  onClick={() => restore.mutate(rev.id)}
                  className="inline-flex items-center gap-1 rounded-xs border border-outline-variant/40 px-2 py-0.5 text-[11px] hover:bg-surface-container-high"
                >
                  <RotateCcw size={11} /> restore this version
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
