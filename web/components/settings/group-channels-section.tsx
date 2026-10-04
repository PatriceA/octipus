'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { GroupChannelModeForm } from '@/components/group-channel-mode-form';
import { api } from '@/lib/api';
import type { GroupChannelSummary } from '../../../src/shared/types';

/**
 * Settings → Channels → Group channels.
 *
 * Shared chats this user enrolled Octipus into by typing `@Octipus join` in
 * the channel. Enrolment happens only there (it proves membership); here the
 * owner sets the mode (and, for listen / proactive, quiet hours and a rate
 * limit) or removes the bot. Each request runs as the member who asked, in
 * their own workspace, so there is no workspace to pick.
 */
export function GroupChannelsSection() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['me', 'group-channels'],
    queryFn: () => api.get<{ groupChannels: GroupChannelSummary[] }>('/me/group-channels'),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['me', 'group-channels'] });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/me/group-channels/${id}`),
    onSuccess: () => { setError(null); invalidate(); },
    onError: (err: Error) => setError(err.message),
  });

  const groups = data?.groupChannels ?? [];

  return (
    <div>
      <h3 className="text-xs font-bold text-on-surface-variant uppercase mb-2">Group channels</h3>
      <p className="text-xs text-on-surface-variant mb-3">
        Invite the bot to a Slack channel, a Teams channel or group chat, or a Telegram group, then type{' '}
        <code>@Octipus join</code> there. It answers when mentioned, replies in threads, and acts with the
        permissions and workspace of whoever asks. Remove it here or with <code>@Octipus leave</code>.
      </p>
      <p className="text-xs text-on-surface-variant mb-3">
        In <em>listen</em> mode it offers help with questions nobody answered; in <em>proactive</em> mode it may answer
        them. Those posts use no tools and no one&apos;s data, cost your account, and need an admin to allow unprompted
        posts.
      </p>
      {error && <p className="text-xs text-error mb-2">! {error}</p>}
      {isLoading ? (
        <p className="text-sm text-on-surface-variant">Loading…</p>
      ) : groups.length === 0 ? (
        <div className="p-4 text-center text-xs text-on-surface-variant border border-outline-variant/40 rounded-xs border-dashed">
          no group channels enrolled
        </div>
      ) : (
        <ul className="term-frame rounded-xs divide-y divide-outline-variant/10">
          {groups.map((g) => (
            <li key={g.id} className="px-4 py-2 space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-3">
                <Users className="w-4 h-4 text-on-surface-variant shrink-0" aria-hidden />
                <span className="text-on-surface flex-1 min-w-0 break-all">
                  {g.label ?? g.channelId}
                  <span className="text-on-surface-variant"> · {g.channelType}</span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(`Remove Octipus from ${g.label ?? g.channelId}? It will stay quiet there until someone types @Octipus join.`)) {
                      removeMutation.mutate(g.id);
                    }
                  }}
                  title="Remove from channel"
                  aria-label={`Remove from ${g.label ?? g.channelId}`}
                  className="text-on-surface-variant/60 hover:text-error cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <GroupChannelModeForm key={g.updatedAt} group={g} endpoint={`/me/group-channels/${g.id}`} onSaved={invalidate} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
