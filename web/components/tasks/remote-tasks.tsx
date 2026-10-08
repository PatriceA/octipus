'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, LockOpen, MessageSquare, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type RemoteSpace, type RemoteTask, remoteTasksSource } from '@/lib/remote-spaces';
import { cn } from '@/lib/utils';
import { useWorkspaceAccess } from '@/lib/workspace-context';

const COLUMNS: ReadonlyArray<RemoteTask['status']> = ['open', 'in_progress', 'done'];

/**
 * The tasks of a space on another install (federation §8.3), through the
 * remote tasks source: read live from the host; an editor creates, checks
 * out and releases tasks; a commenter (or guest) comments. What the role
 * does not allow is not offered — the host refuses it anyway.
 */
export function RemoteTasks({ remote }: { remote: RemoteSpace }) {
  const qc = useQueryClient();
  const { canWrite, canComment } = useWorkspaceAccess();
  const source = useMemo(() => remoteTasksSource(remote.id), [remote.id]);
  const key = ['remote-tasks', remote.id] as const;
  const list = useQuery({ queryKey: key, queryFn: () => source.list(), refetchInterval: 30_000 });
  const [title, setTitle] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const create = useMutation({
    mutationFn: (t: string) => source.create({ title: t }),
    onSuccess: () => { setTitle(''); void refresh(); },
    onError: (err: Error) => setError(err.message),
  });
  const op = useMutation({
    mutationFn: ({ id, kind, body }: { id: string; kind: 'checkout' | 'release' | 'comment'; body?: string }) =>
      source.op(id, kind, body ? { body } : undefined),
    onSuccess: () => { setError(null); void refresh(); void qc.invalidateQueries({ queryKey: ['remote-task', remote.id] }); },
    onError: (err: Error) => setError(err.message),
  });
  const tasks = list.data ?? [];

  return (
    <div className="space-y-4 font-mono" data-testid="remote-tasks">
      <div className="flex items-center gap-2">
        <h1 className="text-[15px] text-on-surface">tasks · {remote.spaceName}</h1>
        <span className="text-[11px] text-outline-variant" title={remote.hostFingerprint}>hosted by {remote.hostBadge}</span>
      </div>
      {canWrite && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); if (title.trim()) create.mutate(title.trim()); }}
        >
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="a new task in this space"
            className="flex-1 px-2 py-1 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[13px] text-on-surface focus:outline-none focus:border-primary"
          />
          <button type="submit" disabled={create.isPending || !title.trim()} className="inline-flex items-center gap-1 px-2 py-1 text-[12px] bg-primary text-on-primary rounded-xs disabled:opacity-50 cursor-pointer">
            <Plus className="w-3.5 h-3.5" /> add
          </button>
        </form>
      )}
      {error && <p role="alert" className="text-[12px] text-error">! {error}</p>}
      {list.error && <p role="alert" className="text-[12px] text-error">! {(list.error as Error).message}</p>}
      {list.isLoading && <p className="text-[12px] text-on-surface-variant">loading…</p>}
      <div className="grid gap-3 md:grid-cols-3">
        {COLUMNS.map((status) => (
          <section key={status} className="term-frame rounded-xs p-2 space-y-1.5">
            <h2 className="section-label">{status.replace('_', ' ')}</h2>
            {tasks.filter((t) => t.status === status).map((t) => (
              <div key={t.id} className="rounded-xs border border-outline-variant/40 p-2 text-[12px] space-y-1">
                <button type="button" onClick={() => setOpen(open === t.id ? null : t.id)} className="text-left text-on-surface w-full cursor-pointer">{t.title}</button>
                <div className="flex items-center gap-2 text-on-surface-variant">
                  {t.checkedOutBy && <span className="inline-flex items-center gap-1 text-[10px]"><Lock className="w-3 h-3" /> checked out</span>}
                  {canWrite && !t.checkedOutBy && status !== 'done' && (
                    <button type="button" onClick={() => op.mutate({ id: t.id, kind: 'checkout' })} className="inline-flex items-center gap-1 text-[10px] hover:text-on-surface cursor-pointer">
                      <Lock className="w-3 h-3" /> check out
                    </button>
                  )}
                  {canWrite && t.checkedOutBy && (
                    <button type="button" onClick={() => op.mutate({ id: t.id, kind: 'release' })} className="inline-flex items-center gap-1 text-[10px] hover:text-on-surface cursor-pointer">
                      <LockOpen className="w-3 h-3" /> release
                    </button>
                  )}
                </div>
                {open === t.id && <TaskThread remoteSpaceId={remote.id} taskId={t.id} canComment={canComment} onComment={(body) => op.mutate({ id: t.id, kind: 'comment', body })} />}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function TaskThread({ remoteSpaceId, taskId, canComment, onComment }: { remoteSpaceId: string; taskId: string; canComment: boolean; onComment: (body: string) => void }) {
  const source = useMemo(() => remoteTasksSource(remoteSpaceId), [remoteSpaceId]);
  const thread = useQuery({ queryKey: ['remote-task', remoteSpaceId, taskId], queryFn: () => source.read(taskId) });
  const [body, setBody] = useState('');
  return (
    <div className="border-t border-outline-variant/30 pt-1 space-y-1">
      {thread.data?.task.notes && <p className="text-on-surface-variant whitespace-pre-wrap">{thread.data.task.notes}</p>}
      <ul className="space-y-0.5">
        {(thread.data?.comments ?? []).map((c) => (
          <li key={c.id} className="flex gap-1 text-[11px]"><MessageSquare className="w-3 h-3 mt-0.5 shrink-0" /><span className="whitespace-pre-wrap">{c.body}</span></li>
        ))}
      </ul>
      {canComment && (
        <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); if (body.trim()) { onComment(body.trim()); setBody(''); } }}>
          <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="comment" className={cn('flex-1 px-1.5 py-0.5 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[11px] focus:outline-none')} />
        </form>
      )}
    </div>
  );
}
