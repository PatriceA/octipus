'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Check, CheckCheck, Loader2, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';
import type { Notification } from '@/lib/types/notifications';
import { cn } from '@/lib/utils';

type Filter = 'unread' | 'all' | 'agents' | 'pipelines' | 'approvals';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'unread', label: 'unread' },
  { key: 'all', label: 'all' },
  { key: 'agents', label: 'agents' },
  { key: 'pipelines', label: 'pipelines' },
  { key: 'approvals', label: 'approvals' },
];

const PAGE_SIZE = 50;
/** Same cadence as the header bell; both read the `['notifications']` key. */
const POLL_MS = 30_000;

type ListResponse = { notifications?: Notification[]; unreadCount?: number; error?: string };
type MutationResponse = { success?: boolean; error?: string };

/** The server-side filter for a tab: paging happens over the filtered set. */
function queryFor(filter: Filter, offset: number): string {
  const q = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (filter === 'unread') q.set('unread', '1');
  else if (filter === 'agents') q.set('type', 'agent');
  else if (filter === 'pipelines') q.set('type', 'pipeline');
  else if (filter === 'approvals') q.set('type', 'approval');
  return `/notifications?${q.toString()}`;
}

/**
 * Where a notification leads. Producers (worker-spawner, pipeline-manager,
 * approval-manager) put the id of the thing that happened in `metadata`;
 * the inbox turns that into the page that shows it.
 */
function linkFor(n: Notification): { href: string; label: string } | null {
  const m = n.metadata ?? {};
  if (typeof m.workerId === 'string') return { href: `/agents/view?id=${encodeURIComponent(m.workerId)}`, label: 'open agent' };
  if (typeof m.pipelineId === 'string') return { href: '/pipelines', label: 'open pipelines' };
  if (typeof m.requestId === 'string') return { href: '/chat', label: 'open chat' };
  if (typeof m.taskId === 'string') return { href: '/tasks', label: 'open to-dos' };
  return null;
}

function toneFor(type: string): string {
  if (type.endsWith('_error') || type.endsWith('_failed')) return 'text-error';
  if (type === 'approval_required') return 'text-primary';
  if (type.endsWith('_complete')) return 'text-tertiary';
  return 'text-on-surface-variant';
}

function when(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** A 200 that says no is still a failure; `api.post` only throws on non-2xx. */
function assertOk(res: MutationResponse): void {
  if (res.error) throw new Error(res.error);
  if (res.success === false) throw new Error('Notification not found');
}

export default function NotificationsPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('unread');
  // Pages after the first, loaded on demand; reset whenever the filter changes.
  const [older, setOlder] = useState<Notification[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  // The first page is a react-query entry under the same root key the header
  // bell uses, so a mutation here invalidates the bell and a mutation in the
  // bell invalidates this page. The poll is the live update — nothing pushes
  // notifications to the browser today.
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['notifications', 'inbox', filter],
    queryFn: () => api.get<ListResponse>(queryFor(filter, 0)),
    refetchInterval: POLL_MS,
  });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a filter change starts a new page sequence
    setOlder([]);
    setHasMore(false);
  }, [filter]);

  useEffect(() => {
    if (!data) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- derive "more pages?" from the freshly fetched first page
    if (data.error) setError(data.error);
    else if (older.length === 0) setHasMore((data.notifications?.length ?? 0) === PAGE_SIZE);
  }, [data, older.length]);

  const firstPage = data?.notifications ?? [];
  const unreadCount = data?.unreadCount ?? 0;
  const seen = new Set<string>();
  const items = [...firstPage, ...older].filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });

  const loadOlder = async () => {
    setLoadingMore(true);
    try {
      const res = await api.get<ListResponse>(queryFor(filter, items.length));
      if (res.error) throw new Error(res.error);
      const page = res.notifications ?? [];
      setOlder((xs) => [...xs, ...page]);
      setHasMore(page.length === PAGE_SIZE);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const markRead = async (id: string) => {
    const target = items.find((x) => x.id === id);
    if (!target || target.read) return;
    // Optimistic on both halves of the list; the invalidate afterwards
    // restores the server's truth either way.
    setOlder((xs) => xs.map((x) => (x.id === id ? { ...x, read: true } : x)));
    queryClient.setQueryData<ListResponse>(['notifications', 'inbox', filter], (old) =>
      old
        ? {
            ...old,
            notifications: (old.notifications ?? []).map((x) => (x.id === id ? { ...x, read: true } : x)),
            unreadCount: Math.max(0, (old.unreadCount ?? 1) - 1),
          }
        : old,
    );
    try {
      assertOk(await api.post<MutationResponse>(`/notifications/${id}/read`));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      void invalidate();
    }
  };

  const markAllRead = async () => {
    setOlder((xs) => xs.map((x) => ({ ...x, read: true })));
    queryClient.setQueryData<ListResponse>(['notifications', 'inbox', filter], (old) =>
      old ? { ...old, notifications: (old.notifications ?? []).map((x) => ({ ...x, read: true })), unreadCount: 0 } : old,
    );
    try {
      assertOk(await api.post<MutationResponse>('/notifications/read-all'));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      void invalidate();
    }
  };

  // Under "unread", a row marked read is gone from the server's view; keep it
  // out of the list too rather than showing a read row in an unread inbox.
  const visible = filter === 'unread' ? items.filter((n) => !n.read) : items;

  return (
    <div className="space-y-6">
      <PageHeader
        title="inbox"
        description="everything that needed you while you were not looking — finished runs, failures, approvals"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => refetch()}
              className="p-1.5 text-on-surface-variant hover:text-on-surface rounded-xs hover:bg-surface-container"
              aria-label="Refresh"
            >
              <RefreshCw className={cn('w-4 h-4', isFetching && 'animate-spin')} />
            </button>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-xs border border-outline-variant/20 hover:bg-surface-container-high text-on-surface"
              >
                <CheckCheck className="w-3.5 h-3.5" /> mark all read
              </button>
            )}
          </div>
        }
      />

      {error && (
        <div className="bg-error/10 border border-error/20 rounded-xs px-4 py-3 text-error text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline">dismiss</button>
        </div>
      )}

      <div className="flex items-center gap-2 text-sm text-on-surface-variant">
        <span>Show</span>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-2.5 py-1 rounded-full text-xs ${filter === f.key ? 'bg-primary/10 text-primary' : 'hover:bg-surface-container-high'}`}
          >
            {f.label}
            {f.key === 'unread' && unreadCount > 0 && <span className="ml-1 text-[10px] opacity-70">{unreadCount}</span>}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <RefreshCw className="w-6 h-6 animate-spin text-on-surface-variant" />
        </div>
      ) : visible.length === 0 ? (
        <div className="py-10 text-center font-mono animate-enter">
          <p aria-hidden className="text-2xl text-on-surface-variant/40"><Bell className="w-6 h-6 inline" /></p>
          <p className="mt-2 text-sm text-on-surface-variant/70">
            {filter === 'unread' ? 'nothing unread — you are caught up' : 'no notifications here'}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-outline-variant/10 rounded-xs border border-outline-variant/10 bg-surface">
          {visible.map((n) => {
            const link = linkFor(n);
            return (
              <li
                key={n.id}
                className={cn('flex items-start gap-3 px-4 py-3', !n.read && 'bg-primary-container/20')}
                data-testid="notification-row"
                data-read={n.read ? 'true' : 'false'}
              >
                <span aria-hidden className={cn('mt-1.5 shrink-0 dot', !n.read ? 'dot-ok dot-live text-tertiary' : 'dot-idle')} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <p className={cn('text-sm', n.read ? 'text-on-surface-variant' : 'text-on-surface font-medium')}>{n.title}</p>
                    <span className={cn('text-[10px] font-mono', toneFor(n.type))}>{n.type}</span>
                    <span className="text-[10px] text-outline ml-auto" suppressHydrationWarning>{when(n.createdAt)}</span>
                  </div>
                  {n.body && <p className="text-xs text-on-surface-variant mt-1 whitespace-pre-wrap line-clamp-3">{n.body}</p>}
                  <div className="flex items-center gap-3 mt-1.5">
                    {link && (
                      // Client-side navigation keeps the mark-read request alive;
                      // a full-page <a> would tear it down mid-flight.
                      <Link href={link.href} onClick={() => { void markRead(n.id); }} className="text-[11px] text-primary hover:underline">
                        {link.label} →
                      </Link>
                    )}
                    {!n.read && (
                      <button onClick={() => markRead(n.id)} className="text-[11px] inline-flex items-center gap-1 text-on-surface-variant hover:text-on-surface">
                        <Check className="w-3 h-3" /> mark read
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!isLoading && hasMore && (
        <div className="flex justify-center">
          <button
            onClick={loadOlder}
            disabled={loadingMore}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-xs border border-outline-variant/20 hover:bg-surface-container-high disabled:opacity-50 text-on-surface"
          >
            {loadingMore ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} load older
          </button>
        </div>
      )}
    </div>
  );
}
