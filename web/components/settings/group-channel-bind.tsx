'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Link2, Unlink } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import type { Space } from '@/lib/workspace-context';
import type { GroupChannelSummary } from '../../../src/shared/types';

interface RoomOption {
  id: string;
  title: string;
  visibility: 'space' | 'private';
}

/**
 * "Bind to space room" for one group channel (coworking §9.4).
 *
 * Only a space owner who enrolled the channel can bind it, and only after
 * acknowledging that everyone in the channel can read what the room shows.
 * Bound, each thread of the channel is a room of the space (the chosen room
 * for the chat's main thread), turns run as the member who asked, and the
 * space's budget replaces the channel's.
 */
export function GroupChannelBind({ group, onChanged }: { group: GroupChannelSummary; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [spaceId, setSpaceId] = useState('');
  const [roomId, setRoomId] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = group.label ?? group.channelId;

  const spacesQ = useQuery({
    queryKey: ['spaces', 'owned'],
    queryFn: () => api.get<{ spaces: Space[] }>('/spaces'),
    enabled: open,
  });
  const owned = (spacesQ.data?.spaces ?? []).filter((s) => s.role === 'owner' && !s.archivedAt);
  const roomsQ = useQuery({
    queryKey: ['space', spaceId, 'rooms'],
    queryFn: () => api.get<{ rooms: RoomOption[] }>(`/spaces/${spaceId}/rooms`),
    enabled: open && !!spaceId,
  });
  const openRooms = (roomsQ.data?.rooms ?? []).filter((r) => r.visibility === 'space');

  const bind = useMutation({
    mutationFn: () => api.post(`/me/group-channels/${group.id}/bind`, {
      workspaceId: spaceId, acknowledged, ...(roomId ? { roomId } : {}),
    }),
    onSuccess: () => { setOpen(false); setError(null); setAcknowledged(false); onChanged(); },
    onError: (err: Error) => setError(err.message),
  });
  const unbind = useMutation({
    mutationFn: () => api.delete(`/me/group-channels/${group.id}/bind`),
    onSuccess: () => { setError(null); onChanged(); },
    onError: (err: Error) => setError(err.message),
  });

  if (group.workspaceId) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-on-surface-variant" data-testid={`bound-${group.id}`}>
        <Link2 className="w-3.5 h-3.5" aria-hidden />
        <span>Bound to the space <strong className="text-on-surface">{group.spaceName ?? 'a space'}</strong>: its threads are rooms there.</span>
        <button
          type="button"
          onClick={() => { if (confirm(`Unbind ${label}? Its threads go back to each member's own sessions.`)) unbind.mutate(); }}
          className="inline-flex items-center gap-1 text-on-surface-variant hover:text-error cursor-pointer"
        >
          <Unlink className="w-3.5 h-3.5" aria-hidden /> Unbind
        </button>
        {error && <span className="text-error">! {error}</span>}
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1 text-xs text-primary hover:underline cursor-pointer">
        <Link2 className="w-3.5 h-3.5" aria-hidden /> Bind to space room
      </button>
    );
  }

  return (
    <form
      className="space-y-2 p-3 border border-outline-variant/40 rounded-xs text-xs"
      aria-label={`Bind ${label} to a space room`}
      onSubmit={(e) => { e.preventDefault(); bind.mutate(); }}
    >
      <p className="text-on-surface-variant">
        Bind <strong className="text-on-surface">{label}</strong> to a space you own. Each thread becomes a room of the space;
        members who are in the space get answers there as themselves, others are told privately they need an invite.
      </p>
      {spacesQ.isLoading ? <p>Loading spaces…</p> : owned.length === 0 ? (
        <p className="text-on-surface-variant">You own no open space to bind to.</p>
      ) : (
        <>
          <label className="flex items-center gap-2">
            <span className="w-16">Space</span>
            <select
              value={spaceId}
              onChange={(e) => { setSpaceId(e.target.value); setRoomId(''); }}
              className="px-2 py-1 bg-surface-container-low border border-outline-variant/60 rounded-xs"
            >
              <option value="">Choose a space…</option>
              {owned.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          {spaceId && (
            <label className="flex items-center gap-2">
              <span className="w-16">Room</span>
              <select
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                className="px-2 py-1 bg-surface-container-low border border-outline-variant/60 rounded-xs"
              >
                <option value="">A new room per thread</option>
                {openRooms.map((r) => <option key={r.id} value={r.id}>{r.title} (main thread)</option>)}
              </select>
            </label>
          )}
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-0.5" />
            <span>
              I understand that <strong>everyone in this channel can read what the room shows</strong>: every post and every answer of
              the space&apos;s agent in the room is posted in the channel.
            </span>
          </label>
        </>
      )}
      {error && <p className="text-error">! {error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!spaceId || !acknowledged || bind.isPending}
          className="px-2.5 py-1 rounded-xs bg-primary text-on-primary disabled:opacity-50 cursor-pointer"
        >
          Bind
        </button>
        <button type="button" onClick={() => { setOpen(false); setError(null); }} className="px-2.5 py-1 rounded-xs border border-outline-variant/60 cursor-pointer">
          Cancel
        </button>
      </div>
    </form>
  );
}
