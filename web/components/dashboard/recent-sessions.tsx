'use client';

import { useQuery } from '@tanstack/react-query';
import { MessageSquare, Clock } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
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
        <CardTitle>Recent Sessions</CardTitle>
      </CardHeader>
      <CardContent>
        {sessions.length === 0 ? (
          <p className="text-center text-gray-500 dark:text-gray-400 py-8">
            No sessions yet
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-sm text-gray-500 dark:text-gray-400">
                  <th className="pb-3 font-medium">Session</th>
                  <th className="pb-3 font-medium">Channel</th>
                  <th className="pb-3 font-medium">Messages</th>
                  <th className="pb-3 font-medium">Status</th>
                  <th className="pb-3 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {sessions.map((session) => (
                  <tr key={session.id} className="text-sm">
                    <td className="py-3">
                      <div className="flex items-center gap-2">
                        <MessageSquare className="w-4 h-4 text-gray-500" />
                        <span className="font-medium text-gray-900 dark:text-gray-100">
                          {session.title || 'Untitled'}
                        </span>
                      </div>
                    </td>
                    <td className="py-3 text-gray-600 dark:text-gray-400">
                      {session.channelType}
                    </td>
                    <td className="py-3 text-gray-600 dark:text-gray-400">
                      {session.messageCount}
                    </td>
                    <td className="py-3">
                      <span
                        className={`px-2 py-1 rounded text-xs font-medium ${
                          session.status === 'active'
                            ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                            : 'bg-gray-100 text-gray-800 dark:bg-gray-600 dark:text-gray-300'
                        }`}
                      >
                        {session.status}
                      </span>
                    </td>
                    <td className="py-3 text-gray-600 dark:text-gray-400">
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
