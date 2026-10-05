'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { useGateway, useGatewayMessages, useGatewayStatus } from '@/lib/gateway-context';
import { initials, type SpacePresencePayload, useRooms } from '@/lib/rooms';
import { useWorkspace } from '@/lib/workspace-context';

/**
 * Who else is in the selected space right now (`space.presence`), as
 * avatars in the header, each saying where the member is — a room or a note
 * — when the server lets me see it (a private room I am not in is left out).
 *
 * Joins the space's presence with `space.subscribe` on every (re)connect and
 * every switch to a space. The server sends each subscriber its own view.
 */
export function SpacePresence() {
  const { activeWorkspace } = useWorkspace();
  const { user } = useAuth();
  const gateway = useGateway();
  const status = useGatewayStatus();
  const spaceId = activeWorkspace?.kind === 'shared' ? activeWorkspace.id : null;
  const rooms = useRooms(spaceId);
  const [presence, setPresence] = useState<SpacePresencePayload | null>(null);

  useEffect(() => {
    if (spaceId && status === 'connected') gateway.send({ type: 'space.subscribe', spaceId });
  }, [gateway, spaceId, status]);

  useGatewayMessages((message) => {
    if (message.type !== 'event' || message.event.type !== 'space.presence') return;
    setPresence(message.event.payload as SpacePresencePayload);
  });

  // A view of another space (the connection stays subscribed to a space
  // left earlier) or from before the last disconnect is not shown.
  if (!spaceId || status !== 'connected' || presence?.spaceId !== spaceId) return null;
  const others = presence.members.filter((m) => m.userId !== user?.id);
  if (others.length === 0) return null;

  const roomTitle = (id: string) => rooms.data?.find((r) => r.id === id)?.title;
  const whereLabel = (where?: { kind: string; id: string }) => {
    if (!where) return 'online';
    if (where.kind === 'room') return `in #${roomTitle(where.id) ?? 'a room'}`;
    if (where.kind === 'note') return 'in a note';
    return 'online';
  };

  return (
    <div className="flex items-center -space-x-1.5" data-testid="space-presence" aria-label="Online in this space">
      {others.slice(0, 6).map((m) => {
        const name = m.username ?? 'someone';
        const label = `${name} — ${whereLabel(m.where)}`;
        const avatar = (
          <span
            className="h-6 w-6 rounded-full bg-surface-container-highest border-2 border-background ring-1 ring-tertiary/60 flex items-center justify-center text-[9px] font-semibold text-on-surface"
          >
            {initials(name)}
          </span>
        );
        return m.where?.kind === 'room' ? (
          <Link key={m.userId} href={`/rooms?room=${m.where.id}`} title={label} aria-label={label} data-testid="presence-avatar">
            {avatar}
          </Link>
        ) : (
          <span key={m.userId} title={label} aria-label={label} data-testid="presence-avatar">
            {avatar}
          </span>
        );
      })}
      {others.length > 6 && (
        <span className="pl-2.5 text-[11px] text-on-surface-variant" title={others.slice(6).map((m) => m.username).join(', ')}>
          +{others.length - 6}
        </span>
      )}
    </div>
  );
}
