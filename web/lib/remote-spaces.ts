/**
 * Spaces joined on other installs (docs/plans/federation-spec.md §8.3): the
 * wire shapes of `/api/remote-spaces` (`src/api/routes/remote-spaces.ts`),
 * and the data sources the shared views render them through.
 *
 * A view that shows a space's rooms, notes or files takes a data source
 * instead of calling the space routes itself: `local` reads
 * `/api/spaces/:id/...` and sends gateway frames as they are; `remote`
 * reads `/api/remote-spaces/:id/...` (this install forwards to the host)
 * and wraps every gateway frame in `remote.frame`, unwrapping the host's
 * `remote.event`s. Nothing of a remote space is cached outside the query
 * cache of this tab.
 *
 * Who re-issues what after the link to the host comes back
 * (`remote.link up`): this install re-issues `space.subscribe`; the views
 * re-issue `room.subscribe` with the newest message they hold (paging
 * while `hasMore`) and `doc.join` with their epoch and state vector — the
 * same thing they do after the tab's own gateway reconnects.
 */
import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { api } from './api';
import { remoteFilePath, remotePath, withUuidIds } from './remote-paths';
import type { ClientMessage, GatewayMessage, GatewayStatus, WebGateway } from './gateway';
import type { LiveNoteGateway } from './live-note';
import type { Room, RoomMessage } from './rooms';
import type { SpaceRole } from './workspace-context';

/** A pointer row (`RemoteSpaceView` on the server). */
export interface RemoteSpace {
  id: string;
  hostInstanceId: string;
  /** `[B:abcd1234]`: the host's instance badge. */
  hostBadge: string;
  /** The host's full id in four groups. */
  hostFingerprint: string;
  hostUrl: string;
  spaceId: string;
  spaceName: string;
  role: Exclude<SpaceRole, 'owner'>;
  memberHandle: string;
  agentAnswersWhenAddressed: boolean;
  joinedAt: string;
  leftAt: string | null;
  link: 'up' | 'down';
}

export interface JoinPreview {
  origin: string;
  hostUrl: string;
  hostInstanceId: string;
  fingerprint: string;
  badge: string;
}

export const remoteSpacesKey = ['remote-spaces'] as const;

/** My spaces on other installs, and the leaves still waiting for their host. */
export function useRemoteSpaces(enabled = true) {
  return useQuery({
    queryKey: remoteSpacesKey,
    queryFn: () => api.get<{ remoteSpaces: RemoteSpace[]; pendingLeaves: RemoteSpace[] }>('/remote-spaces'),
    enabled,
    refetchInterval: 30_000,
  });
}

export { remotePath } from './remote-paths';

/** A member of a space on another install, as the host lists it: display names only (FI5). */
export interface RemoteMember {
  userId: string;
  displayName: string;
  role: SpaceRole;
  remote: boolean;
}

/** The text the leave dialog shows. */
export const LEAVE_NOTICE = 'You leave the space on its host. What your agent already read stays in its session history here.';

// ── Gateway ──────────────────────────────────────────────────────────

/** The client frames a view may send to a space (to one on another install: the visitor allowlist). */
export type SpaceFrame = Extract<ClientMessage, {
  type: 'room.subscribe' | 'room.unsubscribe' | 'room.post' | 'room.typing' | 'room.read' | 'space.subscribe'
    | 'doc.join' | 'doc.update' | 'doc.awareness' | 'doc.leave' | 'room.cancel_queued';
}>;

/**
 * The tab's gateway as one space sees it: frames go out as they are
 * (local) or in `remote.frame` (remote); messages come back unwrapped, and
 * a remote space's status is down while its host's link is.
 */
export interface SpaceGateway extends LiveNoteGateway {
  getStatus(): GatewayStatus;
  send(message: SpaceFrame): boolean;
  onMessage(listener: (message: GatewayMessage) => void): () => void;
  onStatus(listener: (status: GatewayStatus) => void): () => void;
}

export function localSpaceGateway(gateway: WebGateway): SpaceGateway {
  return {
    getStatus: () => gateway.getStatus(),
    send: (message) => gateway.send(message),
    onMessage: (listener) => gateway.onMessage((m) => {
      if (m.type !== 'remote.event' && m.type !== 'remote.link') listener(m);
    }),
    onStatus: (listener) => gateway.onStatus(listener),
  };
}

/** Per remote space, whether its host's link was last announced down. One per tab. */
const linkDown = new Map<string, boolean>();

export function remoteSpaceGateway(gateway: WebGateway, remoteSpaceId: string): SpaceGateway {
  const status = (): GatewayStatus => {
    const own = gateway.getStatus();
    return own === 'connected' && linkDown.get(remoteSpaceId) ? 'disconnected' : own;
  };
  return {
    getStatus: status,
    // Cancelling a queued turn is a host member's (not on the visitor allowlist).
    send: (message) => message.type !== 'room.cancel_queued'
      && gateway.send({ type: 'remote.frame', remoteSpaceId, frame: message } as ClientMessage),
    onMessage: (listener) => gateway.onMessage((m) => {
      if (m.type === 'remote.event' && m.remoteSpaceId === remoteSpaceId) listener(m.event as GatewayMessage);
    }),
    onStatus: (listener) => {
      const offOwn = gateway.onStatus(() => listener(status()));
      const offLink = gateway.onMessage((m) => {
        if (m.type !== 'remote.link' || m.remoteSpaceId !== remoteSpaceId) return;
        linkDown.set(remoteSpaceId, m.state === 'down');
        listener(status());
      });
      return () => { offOwn(); offLink(); };
    },
  };
}

/** A space gateway's status, re-rendering on change. */
export function useSpaceGatewayStatus(gateway: SpaceGateway): GatewayStatus {
  return useSyncExternalStore(
    (onChange) => gateway.onStatus(onChange),
    () => gateway.getStatus(),
    () => 'idle' as GatewayStatus,
  );
}

// ── Rooms ────────────────────────────────────────────────────────────

export interface PostOutcome {
  messageId: string;
  clientId?: string;
  notQueued?: string;
  commandResult?: string;
  message?: RoomMessage;
}

/** What a room view needs of its space: rooms, pages, posts (REST), and the gateway. */
export interface RoomSource {
  kind: 'local' | 'remote';
  /** The query-cache key of its room list. */
  roomsKey: readonly unknown[];
  listRooms(): Promise<Room[]>;
  messages(roomId: string, query: { before?: string; after?: string; limit: number }): Promise<{ messages: RoomMessage[]; hasMore: boolean }>;
  /** The REST post (the socket is down, or a remote space). */
  post(roomId: string, body: { content: string; addressed: boolean; clientId: string }): Promise<PostOutcome>;
  gateway: SpaceGateway;
}

function pageQuery(query: { before?: string; after?: string; limit: number }): string {
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.before) params.set('before', query.before);
  if (query.after) params.set('after', query.after);
  return params.toString();
}

export function localRoomSource(spaceId: string, gateway: WebGateway): RoomSource {
  return {
    kind: 'local',
    roomsKey: ['rooms', spaceId],
    listRooms: () => api.get<{ rooms: Room[] }>(`/spaces/${spaceId}/rooms`).then((r) => r.rooms),
    messages: (roomId, query) => api.get(`/spaces/${spaceId}/rooms/${roomId}/messages?${pageQuery(query)}`),
    post: (roomId, body) => api.post(`/spaces/${spaceId}/rooms/${roomId}/messages`, body),
    gateway: localSpaceGateway(gateway),
  };
}

export function remoteRoomSource(remoteSpaceId: string, gateway: WebGateway): RoomSource {
  return {
    kind: 'remote',
    roomsKey: ['remote-rooms', remoteSpaceId],
    // Ids from the host: only UUIDs are kept (they key, link and page the views).
    listRooms: () => api.get<{ rooms: Room[] }>(remotePath(remoteSpaceId, ['rooms'])).then((r) => withUuidIds(r.rooms)),
    messages: (roomId, query) => api.get<{ messages: RoomMessage[]; hasMore: boolean }>(remotePath(remoteSpaceId, ['rooms', roomId, 'messages'], pageQuery(query)))
      .then((page) => ({ messages: withUuidIds(page.messages), hasMore: page.hasMore === true })),
    post: (roomId, body) => api.post(remotePath(remoteSpaceId, ['rooms', roomId, 'messages']), body),
    gateway: remoteSpaceGateway(gateway, remoteSpaceId),
  };
}

/** The rooms of a source, with unread counts. */
export function useSourceRooms(source: RoomSource | null) {
  return useQuery({
    queryKey: source?.roomsKey ?? ['rooms', null],
    queryFn: () => (source as RoomSource).listRooms(),
    enabled: !!source,
    refetchInterval: 30_000,
  });
}

// ── Notes, tasks, files ──────────────────────────────────────────────

export interface RemoteNoteRow { id: string; title: string; slug: string; updatedAt: string }
export interface RemoteNote extends RemoteNoteRow { body: string; bodySha256: string }

/** What the notes view needs of a space on another install. */
export interface NotesSource {
  list(): Promise<RemoteNoteRow[]>;
  read(noteId: string): Promise<RemoteNote>;
  propose(noteId: string, body: { baseSha256: string; body: string; title?: string }): Promise<unknown>;
  /** The live editor's gateway (`doc.*` in `remote.frame`). */
  gateway: SpaceGateway;
}

export function remoteNotesSource(remoteSpaceId: string, gateway: WebGateway): NotesSource {
  return {
    list: () => api.get<{ notes: RemoteNoteRow[] }>(remotePath(remoteSpaceId, ['notes'])).then((r) => withUuidIds(r.notes)),
    read: (noteId) => api.get<RemoteNote>(remotePath(remoteSpaceId, ['notes', noteId])),
    propose: (noteId, body) => api.post(remotePath(remoteSpaceId, ['notes', noteId, 'proposals']), body),
    gateway: remoteSpaceGateway(gateway, remoteSpaceId),
  };
}

export interface RemoteTask {
  id: string;
  title: string;
  status: 'open' | 'in_progress' | 'done' | 'archived';
  notes?: string | null;
  priority?: number;
  checkedOutBy?: string | null;
}

export interface RemoteTaskComment { id: string; body: string; authorKind: string; createdAt: string }

/** What the tasks view needs of a space on another install. */
export interface TasksSource {
  list(): Promise<RemoteTask[]>;
  read(taskId: string): Promise<{ task: RemoteTask; comments: RemoteTaskComment[] }>;
  create(body: { title: string; notes?: string }): Promise<unknown>;
  op(taskId: string, op: 'checkout' | 'release' | 'comment', body?: { body: string }): Promise<unknown>;
}

export function remoteTasksSource(remoteSpaceId: string): TasksSource {
  return {
    list: () => api.get<{ tasks: RemoteTask[] }>(remotePath(remoteSpaceId, ['tasks'])).then((r) => withUuidIds(r.tasks)),
    read: (taskId) => api.get<{ task: RemoteTask; comments: RemoteTaskComment[] }>(remotePath(remoteSpaceId, ['tasks', taskId]))
      .then((r) => ({ task: r.task, comments: withUuidIds(r.comments) })),
    create: (body) => api.post(remotePath(remoteSpaceId, ['tasks']), body),
    op: (taskId, op, body) => api.post(remotePath(remoteSpaceId, ['tasks', taskId, op]), body ?? {}),
  };
}

export interface RemoteFileEntry { name: string; type: 'file' | 'dir'; size: number }
export interface RemoteFile { path: string; size: number; encoding: 'utf8' | 'base64'; content: string }

/** What the files view needs of a space on another install: read-only (F-D8). */
export interface FilesSource {
  /** Its query-cache key. */
  key: string;
  list(path: string): Promise<{ path: string; entries: RemoteFileEntry[] }>;
  read(path: string): Promise<RemoteFile>;
}

export function remoteFilesSource(remoteSpaceId: string): FilesSource {
  return {
    key: `remote:${remoteSpaceId}`,
    list: (path) => api.get(remotePath(remoteSpaceId, ['files'], path ? new URLSearchParams({ path }).toString() : undefined)),
    read: (path) => api.get(remoteFilePath(remoteSpaceId, path)),
  };
}
