/**
 * Rooms of a shared space (docs/SPACES.md → Rooms): the wire shapes of the
 * room routes (`src/api/routes/rooms.ts`) and gateway events
 * (`src/core/rooms/*`), and the queries the rooms page, the sidebar and the
 * space header share.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { SpaceRole } from './workspace-context';

export type RoomVisibility = 'space' | 'private';

/** `RoomView` on the server: a room the caller may enter. */
export interface Room {
  id: string;
  workspaceId: string;
  title: string;
  visibility: RoomVisibility;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Posts and replies after my read position, not counting my own. */
  unreadCount: number;
  muted: boolean;
}

/** `RoomMessageView` on the server. */
export interface RoomMessage {
  id: string;
  roomId: string;
  role: 'user' | 'assistant';
  content: string;
  authorUserId: string | null;
  authorName: string | null;
  agentId: string | null;
  createdAt: string;
  metadata: {
    kind?: 'progress';
    clientId?: string;
    addressed?: boolean;
    replyTo?: string;
    requesterId?: string;
  };
}

export interface RoomMember {
  userId: string;
  username: string;
  addedAt: string | null;
}

/** A member of the space (`GET /api/spaces/:id/members`). */
export interface SpaceMember {
  userId: string;
  username: string;
  role: SpaceRole;
  joinedAt: string;
}

export interface SpaceMemoryEntry {
  id: string;
  body: string;
  authorKind: 'member' | 'agent';
  authorUserId: string | null;
  authorName: string | null;
  sessionId: string | null;
  createdAt: string;
}

/** The turn strip as the server sees it (`RoomQueueSnapshot`). */
export interface RoomQueue {
  running: { requesterId: string; requesterName: string; messageId: string; startedAt: string; waiting: boolean; model?: string } | null;
  queued: Array<{ requesterId: string; requesterName: string; messageId: string; enqueuedAt: string }>;
}

export const EMPTY_QUEUE: RoomQueue = { running: null, queued: [] };

/** `room.turn` payload. `queue` is authoritative: the client replaces its strip with it. */
export interface RoomTurnPayload {
  roomId: string;
  state: 'queued' | 'started' | 'waiting' | 'done';
  requesterId: string;
  requesterName: string;
  messageId: string;
  outcome?: 'success' | 'failed' | 'stopped' | 'cancelled' | 'dropped';
  error?: string;
  queue: RoomQueue;
}

/** `space.presence` payload: who is online in the space, and where when I may see it. */
export interface SpacePresencePayload {
  spaceId: string;
  members: Array<{ userId: string; username: string | null; where?: { kind: string; id: string } }>;
}

export const roomsKey = (spaceId: string | null) => ['rooms', spaceId] as const;

/** The rooms of the space I may enter, with unread counts. */
export function useRooms(spaceId: string | null) {
  return useQuery({
    queryKey: roomsKey(spaceId),
    queryFn: () => api.get<{ rooms: Room[] }>(`/spaces/${spaceId}/rooms`).then((r) => r.rooms),
    enabled: !!spaceId,
    refetchInterval: 30_000,
  });
}

/** The space's members (for creating a room, adding to a private one). */
export function useSpaceMembers(spaceId: string | null) {
  return useQuery({
    queryKey: ['space', spaceId, 'members'],
    queryFn: () => api.get<{ members: SpaceMember[] }>(`/spaces/${spaceId}/members`).then((r) => r.members),
    enabled: !!spaceId,
  });
}

/** Up to two letters for an avatar: "anna" → "AN", "Anna Berg" → "AB". */
export function initials(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** The `@` word ending at `caret` in `text`, if the caret is in one. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([\w.-]*)$/.exec(before);
  if (!match) return null;
  return { start: caret - match[2].length - 1, query: match[2] };
}
