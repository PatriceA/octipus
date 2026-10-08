'use client';

import { useQueryClient } from '@tanstack/react-query';
import { BellOff, Hash, Lock, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { CreateRoomDialog } from '@/components/rooms/create-room-dialog';
import { RoomView } from '@/components/rooms/room-view';
import { useAuth } from '@/lib/auth-context';
import { useGateway } from '@/lib/gateway-context';
import { localRoomSource, remoteRoomSource, useSourceRooms } from '@/lib/remote-spaces';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/lib/workspace-context';

/**
 * `/rooms?room=<id>`: the rooms of the selected shared space — the list
 * with unread badges (new room for editors and owners), and the open room.
 * Rooms exist in shared spaces only; in a personal workspace the page says
 * so. A space on another install (federation §8.3) shows the same views
 * through its remote data source: this install forwards every read, post
 * and frame to the host.
 */
export default function RoomsPage() {
  const { activeWorkspace, access, isLoading } = useWorkspace();
  const { user } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const gateway = useGateway();
  const space = activeWorkspace?.kind === 'shared' || activeWorkspace?.kind === 'remote' ? activeWorkspace : null;
  const remote = activeWorkspace?.kind === 'remote' ? activeWorkspace : null;
  const source = useMemo(
    () => (!space ? null : space.kind === 'remote' ? remoteRoomSource(space.id, gateway) : localRoomSource(space.id, gateway)),
    [space?.id, space?.kind, gateway], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const rooms = useSourceRooms(source);
  const [creating, setCreating] = useState(false);
  const [removed, setRemoved] = useState<{ roomId: string; title: string; reason: string } | null>(null);

  if (isLoading) return <div className="p-8 font-mono text-on-surface-variant">loading…</div>;
  if (!space || !source) {
    return (
      <div className="p-8 font-mono text-[13px] text-on-surface-variant space-y-2" data-testid="rooms-no-space">
        <p>Rooms are shared chats of a space: members talk to each other and ask Octipus together.</p>
        <p>Pick a shared space in the workspace picker (top right), or create one there.</p>
      </div>
    );
  }

  // A room taken away from me stays out of the list until it is re-read.
  const list = (rooms.data ?? []).filter((r) => r.id !== removed?.roomId);
  const wanted = params.get('room');
  const room = (wanted ? list.find((r) => r.id === wanted) : undefined) ?? (wanted ? undefined : list[0]);
  // Nothing of a space on another install is managed from here.
  const canManage = (r: { createdBy: string }) => !remote && (r.createdBy === user?.id || space.role === 'owner');
  const open = (id: string) => router.replace(`/rooms?room=${encodeURIComponent(id)}`);

  const onRemoved = (roomId: string, title: string) => (reason: string) => {
    setRemoved({ roomId, title, reason });
    router.replace('/rooms');
    void qc.invalidateQueries({ queryKey: source.roomsKey });
  };

  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="Rooms" className="w-56 shrink-0 border-r border-outline-variant/40 flex flex-col min-h-0 font-mono bg-surface-container-lowest">
        <div className="flex items-center justify-between px-3 h-11 border-b border-outline-variant/40">
          <h2 className="text-[12px] text-on-surface flex items-center gap-1.5 min-w-0">
            rooms
            {remote && (
              <span className="text-[10px] text-outline-variant truncate" title={`Hosted by another install: ${remote.hostFingerprint}`} data-testid="rooms-host-badge">
                {remote.hostBadge}
              </span>
            )}
          </h2>
          {access.canWrite && !remote && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              aria-label="New room"
              title="New room"
              className="p-1 rounded-xs text-on-surface-variant hover:text-primary hover:bg-surface-container cursor-pointer"
            >
              <Plus className="w-4 h-4" />
            </button>
          )}
        </div>
        <ul className="flex-1 overflow-y-auto py-2 px-1.5 space-y-px">
          {rooms.isLoading && <li className="px-2 text-[12px] text-on-surface-variant">loading…</li>}
          {rooms.error && <li role="alert" className="px-2 text-[12px] text-error">! {(rooms.error as Error).message}</li>}
          {list.map((r) => (
            <li key={r.id}>
              <Link
                href={`/rooms?room=${r.id}`}
                aria-current={room?.id === r.id ? 'page' : undefined}
                data-testid="room-link"
                className={cn(
                  'flex items-center gap-2 px-2 py-1.5 rounded-xs text-[13px] border',
                  room?.id === r.id
                    ? 'text-primary bg-primary-container/40 border-primary/30'
                    : 'border-transparent text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low',
                  r.unreadCount > 0 && !r.muted && room?.id !== r.id && 'text-on-surface font-semibold',
                )}
              >
                {r.visibility === 'private' ? <Lock className="w-3.5 h-3.5 shrink-0" /> : <Hash className="w-3.5 h-3.5 shrink-0" />}
                <span className="truncate flex-1">{r.title}</span>
                {r.muted && <BellOff className="w-3 h-3 shrink-0 opacity-60" aria-label="muted" />}
                {r.unreadCount > 0 && (
                  <span
                    data-testid="room-unread"
                    aria-label={`${r.unreadCount} unread`}
                    className={cn('rounded-sm px-1.5 text-[10px] font-semibold', r.muted ? 'bg-surface-container-high text-on-surface-variant' : 'bg-primary text-on-primary')}
                  >
                    {r.unreadCount}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        {removed && (
          <div role="alert" data-testid="room-removed" className="flex items-center gap-2 px-4 py-2 text-[12px] font-mono border-b border-warning/30 bg-warning/10 text-on-surface">
            <span className="text-warning font-bold">!</span>
            <span className="flex-1">#{removed.title}: {removed.reason}</span>
            <button type="button" onClick={() => setRemoved(null)} aria-label="Dismiss" className="text-on-surface-variant hover:text-on-surface cursor-pointer">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {room ? (
          <RoomView
            key={room.id}
            source={source}
            spaceId={space.id}
            room={room}
            myId={user?.id}
            access={access}
            canManage={canManage(room)}
            onRemoved={onRemoved(room.id, room.title)}
          />
        ) : (
          !rooms.isLoading && (
            <div className="p-8 font-mono text-[13px] text-on-surface-variant" data-testid="room-missing">
              {wanted ? 'This room does not exist, or you cannot enter it.' : 'No rooms in this space yet.'}
            </div>
          )
        )}
      </div>

      {!remote && <CreateRoomDialog
        spaceId={space.id}
        myId={user?.id}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(r) => { setCreating(false); open(r.id); }}
      />}
    </div>
  );
}
