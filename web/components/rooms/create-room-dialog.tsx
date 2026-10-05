'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { api } from '@/lib/api';
import { type Room, roomsKey, type RoomVisibility, useSpaceMembers } from '@/lib/rooms';

const inputClass = 'w-full px-2 py-1 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[13px] text-on-surface focus:outline-none focus:border-primary';

/**
 * New room (editors and owners): a title, open to the space or private,
 * and for a private room the members who may enter it (I am always in it).
 */
export function CreateRoomDialog({ spaceId, myId, open, onClose, onCreated }: {
  spaceId: string;
  myId: string | undefined;
  open: boolean;
  onClose: () => void;
  onCreated: (room: Room) => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [visibility, setVisibility] = useState<RoomVisibility>('space');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const members = useSpaceMembers(open ? spaceId : null);
  const others = (members.data ?? []).filter((m) => m.userId !== myId);

  const create = useMutation({
    mutationFn: () => api.post<Room>(`/spaces/${spaceId}/rooms`, {
      title: title.trim(),
      visibility,
      ...(visibility === 'private' && memberIds.length > 0 ? { memberIds } : {}),
    }),
    onSuccess: async (room) => {
      await qc.invalidateQueries({ queryKey: roomsKey(spaceId) });
      setTitle('');
      setVisibility('space');
      setMemberIds([]);
      setError(null);
      onCreated(room);
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Modal open={open} onClose={onClose} title="New room">
      <form
        className="p-3 space-y-3 text-[12px]"
        onSubmit={(e) => { e.preventDefault(); if (title.trim()) create.mutate(); }}
      >
        {error && <p role="alert" className="px-2 py-1 border border-error/40 bg-error/10 rounded-xs text-error">! {error}</p>}
        <label className="block space-y-1">
          <span className="text-on-surface-variant">title</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} className={inputClass} aria-label="Room title" placeholder="e.g. launch" />
        </label>
        <fieldset className="space-y-1">
          <legend className="text-on-surface-variant">who can enter</legend>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="visibility" checked={visibility === 'space'} onChange={() => setVisibility('space')} />
            every member of the space
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="visibility" checked={visibility === 'private'} onChange={() => setVisibility('private')} />
            private — only the members I pick
          </label>
        </fieldset>
        {visibility === 'private' && (
          <fieldset className="space-y-1 max-h-40 overflow-y-auto">
            <legend className="text-on-surface-variant">members (you are in it)</legend>
            {others.length === 0 && <p className="text-on-surface-variant">no other members in the space yet</p>}
            {others.map((m) => (
              <label key={m.userId} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={memberIds.includes(m.userId)}
                  onChange={(e) => setMemberIds((ids) => (e.target.checked ? [...ids, m.userId] : ids.filter((id) => id !== m.userId)))}
                />
                {m.username} <span className="text-on-surface-variant">{m.role}</span>
              </label>
            ))}
          </fieldset>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-2.5 py-1 rounded-xs border border-outline-variant/60 text-on-surface-variant hover:text-on-surface cursor-pointer">cancel</button>
          <button type="submit" disabled={!title.trim() || create.isPending} className="px-2.5 py-1 rounded-xs bg-primary text-on-primary hover:bg-primary-dim disabled:opacity-50 cursor-pointer">
            create room
          </button>
        </div>
      </form>
    </Modal>
  );
}
