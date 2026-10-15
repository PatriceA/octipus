'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { MessageSquare } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useWorkspaceId } from '@/lib/workspace-context';

interface Session {
  id: string;
  title?: string;
  channelType: string;
  messageCount: number;
  status: string;
  updatedAt: string;
}

export function RecentSessions() {
  const workspaceId = useWorkspaceId();
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['sessions', workspaceId],
    queryFn: async () => {
      return await api.get<Session[] | { sessions: Session[]; total?: number }>('/sessions?limit=10');
    },
  });

  const sessions: Session[] = Array.isArray(data) ? data : ((data as { sessions: Session[] })?.sessions || []);
  // Full count — this view fetches only the latest 10, so `sessions.length`
  // caps at 10. Fall back to the page length for the legacy array shape.
  const total = Array.isArray(data) ? data.length : ((data as { total?: number })?.total ?? sessions.length);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pick up a conversation</CardTitle>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-on-surface-variant">
          {!isPending && !error ? `${total} total` : ''}
        </span>
      </CardHeader>
      <CardContent className="p-0">
        {error ? <div role="alert" className="p-4 text-sm text-on-surface-variant">Could not load recent conversations. <button type="button" className="text-primary underline" onClick={() => void refetch()}>Try again</button></div> : isPending ? <p className="p-4 text-sm text-on-surface-variant">Loading conversations…</p> : sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-on-surface-variant">
            <p className="text-sm">Your conversations will appear here.</p>
            <Link href="/chat" className="mt-2 text-sm text-primary underline">Start a conversation</Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left bg-surface-container-low/60 border-b border-outline-variant/40">
                  <th className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-normal text-on-surface-variant">session</th>
                  <th className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-normal text-on-surface-variant">channel</th>
                  <th className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-normal text-on-surface-variant text-right">msgs</th>
                  <th className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-normal text-on-surface-variant">status</th>
                  <th className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-normal text-on-surface-variant">updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/30">
                {sessions.map((session) => (
                  <tr key={session.id} className="hover:bg-surface-container-high transition-colors">
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <MessageSquare className="w-3.5 h-3.5 text-on-surface-variant shrink-0" aria-hidden />
                        <Link href={`/chat?session=${encodeURIComponent(session.id)}`} className="text-on-surface hover:text-primary underline underline-offset-4 truncate">
                          {session.title || 'Untitled conversation'}
                        </Link>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-on-surface-variant">{session.channelType}</td>
                    <td className="px-3 py-1.5 text-on-surface-variant text-right tabular-nums">{session.messageCount}</td>
                    <td className="px-3 py-1.5">
                      <StatusBadge variant={session.status === 'active' ? 'success' : 'neutral'}>
                        {session.status}
                      </StatusBadge>
                    </td>
                    <td className="px-3 py-1.5 text-on-surface-variant" suppressHydrationWarning>
                      {formatDate(session.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
