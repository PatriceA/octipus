'use client';

import { useQuery } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';

interface Session {
  id: string;
  title?: string;
  channelType: string;
  messageCount: number;
  status: string;
  updatedAt: string;
}

export function RecentSessions() {
  const { data } = useQuery({
    queryKey: ['sessions'],
    queryFn: async () => {
      try {
        return await api.get<Session[] | { sessions: Session[]; total?: number }>('/sessions?limit=10');
      } catch {
        return [];
      }
    },
  });

  const sessions: Session[] = Array.isArray(data) ? data : ((data as { sessions: Session[] })?.sessions || []);
  // Full count — this view fetches only the latest 10, so `sessions.length`
  // caps at 10. Fall back to the page length for the legacy array shape.
  const total = Array.isArray(data) ? data.length : ((data as { total?: number })?.total ?? sessions.length);

  return (
    <Card>
      <CardHeader>
        <CardTitle>recent sessions</CardTitle>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-outline-variant">
          {total} total
        </span>
      </CardHeader>
      <CardContent className="p-0">
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-on-surface-variant">
            <MessageSquare className="w-6 h-6 mb-2 opacity-40" />
            <p className="text-[12px]">-- no sessions yet --</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left bg-surface-container-low/60 border-b border-outline-variant/40">
                  <th className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-normal text-outline-variant">session</th>
                  <th className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-normal text-outline-variant">channel</th>
                  <th className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-normal text-outline-variant text-right">msgs</th>
                  <th className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-normal text-outline-variant">status</th>
                  <th className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-normal text-outline-variant">updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/30">
                {sessions.map((session) => (
                  <tr key={session.id} className="hover:bg-surface-container-high transition-colors">
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <MessageSquare className="w-3.5 h-3.5 text-on-surface-variant shrink-0" aria-hidden />
                        <span className="text-on-surface truncate">
                          {session.title || 'untitled'}
                        </span>
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
