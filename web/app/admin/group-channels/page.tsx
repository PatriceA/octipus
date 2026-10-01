'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { GroupChannelSummary } from '../../../../src/shared/types';

/**
 * Admin → Group channels.
 *
 * Every shared chat a linked member enrolled Octipus into. Owners enrol from
 * inside the channel; admins do not approve, but can revoke. A channel whose
 * owner is deactivated is paused until a member types `@Octipus join`.
 */
export default function AdminGroupChannelsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'group-channels'],
    queryFn: () => api.get<{ groupChannels: GroupChannelSummary[] }>('/admin/group-channels'),
  });
  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/group-channels/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'group-channels'] }),
  });
  const groups = data?.groupChannels ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="section-label">group channels</h2>
        <p className="mt-1 text-xs text-on-surface-variant">
          Shared chats where Octipus answers members who mention it. Each turn runs as the member who asked.
          Revoking makes the bot go quiet in that channel.
        </p>
      </div>

      {isLoading ? (
        <div className="p-8 text-center text-on-surface-variant">Loading…</div>
      ) : groups.length === 0 ? (
        <div className="p-8 text-center text-on-surface-variant border border-outline-variant/40 rounded-xs border-dashed">
          <p aria-hidden className="text-[16px] text-outline mb-1">[ ]</p>
          <p className="text-[12px]">no group channels enrolled</p>
        </div>
      ) : (
        <ul className="term-frame rounded-xs divide-y divide-outline-variant/10">
          {groups.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <span className="text-on-surface-variant w-14 shrink-0">{g.channelType}</span>
              <span className="text-on-surface break-all flex-1 min-w-0">
                {g.label ?? g.channelId}
                {g.label && <span className="text-on-surface-variant"> · {g.channelId}</span>}
              </span>
              <span className="text-xs text-on-surface-variant">
                enrolled by {g.ownerName}
                {!g.ownerActive && <span className="text-warning"> · paused (owner deactivated)</span>}
              </span>
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Revoke ${g.label ?? g.channelId} (enrolled by ${g.ownerName})? The bot will stay quiet there.`)) {
                    removeMutation.mutate(g.id);
                  }
                }}
                title="Revoke enrolment"
                aria-label={`Revoke ${g.label ?? g.channelId}`}
                className="text-on-surface-variant/60 hover:text-error cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
