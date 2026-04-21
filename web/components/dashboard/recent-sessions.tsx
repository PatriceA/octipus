'use client';

import { useQuery } from '@tanstack/react-query';
import { Clock, MessageSquare } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
        return await api.get<Session[] | { sessions: Session[] }>('/sessions?limit=10');
      } catch {
        return [];
      }
    },
  });

  const sessions: Session[] = Array.isArray(data) ? data : ((data as { sessions: Session[] })?.sessions || []);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Recent Sessions</CardTitle>
          <span className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">
            {sessions.length} sessions
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-on-surface-variant">
            <MessageSquare className="w-8 h-8 mb-2 opacity-40" />
            <p className="text-sm">No sessions yet</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left">
                  <th className="pb-3 text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">Session</th>
                  <th className="pb-3 text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">Channel</th>
                  <th className="pb-3 text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">Messages</th>
                  <th className="pb-3 text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">Status</th>
                  <th className="pb-3 text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/5">
                {sessions.map((session) => (
                  <tr key={session.id} className="text-sm hover:bg-surface-container-high/50 transition-colors">
                    <td className="py-3">
                      <div className="flex items-center gap-2">
                        <MessageSquare className="w-4 h-4 text-on-surface-variant" />
                        <span className="font-medium text-white">
                          {session.title || 'Untitled'}
                        </span>
                      </div>
                    </td>
                    <td className="py-3 text-on-surface-variant">
                      {session.channelType}
                    </td>
                    <td className="py-3 text-on-surface-variant">
                      {session.messageCount}
                    </td>
                    <td className="py-3">
                      <span
                        className={`px-2.5 py-1 rounded-full text-[10px] uppercase tracking-widest font-bold ${
                          session.status === 'active'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : 'bg-surface-container-high text-on-surface-variant'
                        }`}
                      >
                        {session.status}
                      </span>
                    </td>
                    <td className="py-3 text-on-surface-variant">
                      <div className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatDate(session.updatedAt)}
                      </div>
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
