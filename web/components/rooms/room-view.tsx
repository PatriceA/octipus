'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, Bot, Hash, Lock, MessageSquareLock, PanelRight, WifiOff, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MessageTimeline, { type ChatMessageData } from '@/components/chat/message-timeline';
import { api } from '@/lib/api';
import type { GatewayMessage } from '@/lib/gateway';
import { isUuid, withUuidIds } from '@/lib/remote-paths';
import { remotePath, type RoomSource, useSpaceGatewayStatus } from '@/lib/remote-spaces';
import {
  EMPTY_QUEUE,
  initials,
  type Room,
  type RoomMessage,
  type RoomQueue,
  type RoomTurnPayload,
} from '@/lib/rooms';
import { cn } from '@/lib/utils';
import type { WorkspaceAccess } from '@/lib/workspace-context';
import { RoomComposer } from './room-composer';
import { MembersPanel, MemoryPanel, RemoteMembersPanel, SettingsPanel, useRemoteMembers, useRoomMembers } from './room-panels';
import { TurnStrip } from './turn-strip';

const PAGE = 50;
/** A gateway `error` this soon after a room frame is that frame's answer. */
const FRAME_ERROR_WINDOW_MS = 5_000;
const TYPING_SHOWN_MS = 5_000;

type Panel = 'members' | 'memory' | 'settings';

interface Pending {
  clientId: string;
  content: string;
  at: string;
}

interface RoomViewProps {
  /**
   * Where the room's data comes from: this install's space, or a space on
   * another install (federation §8.3) through this install's
   * `/api/remote-spaces` and `remote.frame`.
   */
  source: RoomSource;
  /** The space's id here, or the pointer row's for a space on another install. */
  spaceId: string;
  room: Room;
  myId: string | undefined;
  access: WorkspaceAccess;
  /** I may change the room (its creator, or an owner of the space). */
  canManage: boolean;
  /** The server took the room away from this connection (`room.removed`). */
  onRemoved: (reason: string) => void;
}

/** Oldest first by the server's `created_at`, then id; one row per id. */
function merge(current: RoomMessage[], incoming: RoomMessage[]): RoomMessage[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function clientId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A room: the shared timeline (members' posts and Octipus's answers), the
 * turn strip, the composer, and the side panels (members, space memory,
 * settings).
 *
 * Live through the tab's gateway connection: `room.subscribe` on every
 * (re)connect, with `afterMessageId` = the newest message held, so what was
 * missed while away comes back as `room.catchup` from the messages table.
 * Posts go out as `room.post` (REST when the socket is down) and show at
 * once, greyed, until their `room.message` echo — matched by `clientId` —
 * replaces them. The requester sees Octipus's answer stream in; everyone
 * else sees the turn strip, then the stored answer.
 */
export function RoomView({ source, spaceId, room, myId, access, canManage, onRemoved }: RoomViewProps) {
  const roomId = room.id;
  const remote = source.kind === 'remote';
  const gateway = source.gateway;
  // A remote room is offline while its host's link is down, too.
  const status = useSpaceGatewayStatus(gateway);
  const qc = useQueryClient();
  const router = useRouter();
  const localMembers = useRoomMembers(spaceId, roomId, !remote);
  const remoteMembers = useRemoteMembers(remote ? spaceId : null);

  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [load, setLoad] = useState<{ state: 'loading' | 'ready' | 'error'; error?: string }>({ state: 'loading' });
  const [hasOlder, setHasOlder] = useState(false);
  const [queue, setQueue] = useState<RoomQueue>(EMPTY_QUEUE);
  const [typing, setTyping] = useState<Record<string, { name: string; until: number }>>({});
  const [here, setHere] = useState<Array<{ userId: string; username: string | null }>>([]);
  const [streaming, setStreaming] = useState<{ iteration: number; text: string } | null>(null);
  const [notices, setNotices] = useState<Array<{ id: string; text: string; at: string }>>([]);
  const [panel, setPanel] = useState<Panel | null>(() =>
    typeof window !== 'undefined' && window.matchMedia?.('(min-width: 1024px)').matches ? 'members' : null);
  const [asking, setAsking] = useState(false);

  const lastIdRef = useRef<string | undefined>(undefined);
  const lastFrameAtRef = useRef(0);
  const inflightRef = useRef<string[]>([]);
  const readSentRef = useRef<string | undefined>(undefined);

  const notify = useCallback((text: string) => {
    setNotices((n) => [...n.slice(-4), { id: clientId(), text, at: new Date().toISOString() }]);
  }, []);

  // The newest stored message, for catch-up and read marks.
  useEffect(() => {
    lastIdRef.current = messages.at(-1)?.id;
  }, [messages]);

  // First page from REST; live updates follow the subscribe below.
  useEffect(() => {
    let cancelled = false;
    source.messages(roomId, { limit: PAGE })
      .then((page) => {
        if (cancelled) return;
        setMessages((current) => merge(current, page.messages));
        setHasOlder(page.hasMore);
        setLoad({ state: 'ready' });
      })
      .catch((err: Error) => {
        if (!cancelled) setLoad({ state: 'error', error: err.message });
      });
    return () => { cancelled = true; };
  }, [source, roomId]);

  // Subscribe on every (re)connect once the first page is in, asking for
  // what was missed since the newest message held.
  const ready = load.state === 'ready';
  useEffect(() => {
    if (!ready || status !== 'connected') return;
    const afterMessageId = lastIdRef.current;
    gateway.send({ type: 'room.subscribe', roomId, ...(afterMessageId ? { afterMessageId } : {}) });
    return () => { gateway.send({ type: 'room.unsubscribe', roomId }); };
  }, [gateway, roomId, ready, status]);

  /** More catch-up than one frame carries: page the rest from REST. */
  const catchUpFrom = useCallback(async (after: string) => {
    let cursor: string | undefined = after;
    while (cursor) {
      const page: { messages: RoomMessage[]; hasMore: boolean } = await source.messages(roomId, { after: cursor, limit: 200 });
      setMessages((current) => merge(current, page.messages));
      cursor = page.hasMore ? page.messages.at(-1)?.id : undefined;
    }
  }, [source, roomId]);

  const dropPending = useCallback((id: string | undefined) => {
    if (!id) return;
    setPending((p) => p.filter((x) => x.clientId !== id));
    inflightRef.current = inflightRef.current.filter((x) => x !== id);
  }, []);

  const handlePosted = useCallback((outcome: { messageId?: string; clientId?: string; notQueued?: string; commandResult?: string }) => {
    inflightRef.current = inflightRef.current.filter((x) => x !== outcome.clientId);
    if (outcome.commandResult !== undefined) {
      dropPending(outcome.clientId);
      notify(outcome.commandResult);
    }
    if (outcome.notQueued) notify(`Octipus was not asked: ${outcome.notQueued}`);
  }, [dropPending, notify]);

  // The space's messages: this tab's own, or the host's unwrapped from `remote.event`.
  const handleMessage = (message: GatewayMessage) => {
    if (message.type === 'room.catchup') {
      if (message.roomId !== roomId) return;
      // A host's rows keep only UUID ids (they key and page the view).
      const caught = remote ? withUuidIds(message.messages as RoomMessage[]) : message.messages as RoomMessage[];
      setMessages((current) => merge(current, caught));
      const last = caught.at(-1)?.id;
      if (message.hasMore && last) void catchUpFrom(last).catch((err: Error) => notify(`Could not load the missed messages: ${err.message}`));
      return;
    }
    if (message.type === 'room.posted') {
      if (message.roomId === roomId) handlePosted(message);
      return;
    }
    if (message.type === 'error') {
      if (Date.now() - lastFrameAtRef.current > FRAME_ERROR_WINDOW_MS) return;
      // Room frames of a connection are answered in order: the oldest post
      // still waiting is the one refused.
      dropPending(inflightRef.current[0]);
      notify(message.message);
      return;
    }
    if (message.type !== 'event') return;
    const { event } = message;
    const payload = event.payload as Record<string, any>;
    if (event.type === 'chat.delta' && event.sessionId === roomId) {
      // My own turn's text as it is written (deltas go to the requester only).
      const iteration = Number(payload.iteration ?? 0);
      const delta = String(payload.delta ?? '');
      setStreaming((prev) => prev && prev.iteration === iteration
        ? { iteration, text: prev.text + delta }
        : { iteration, text: prev ? `${prev.text.trimEnd()}\n\n${delta}` : delta });
      return;
    }
    if (!event.type.startsWith('room.') || payload?.roomId !== roomId) return;
    switch (event.type) {
      case 'room.message': {
        const row = payload.message as RoomMessage;
        if (remote && !isUuid(row?.id)) break;
        setMessages((current) => merge(current, [row]));
        dropPending(payload.clientId ?? row.metadata?.clientId);
        if (row.role === 'assistant' && row.metadata.requesterId === myId && row.metadata.kind !== 'progress') setStreaming(null);
        if (row.authorUserId) {
          setTyping((t) => {
            if (!t[row.authorUserId!]) return t;
            const next = { ...t };
            delete next[row.authorUserId!];
            return next;
          });
        }
        break;
      }
      case 'room.turn': {
        const turn = payload as RoomTurnPayload;
        setQueue(turn.queue);
        if (turn.state === 'done' && turn.requesterId === myId) {
          setStreaming(null);
          if (turn.outcome && turn.outcome !== 'success') {
            notify(`Your request ${turn.outcome === 'dropped' ? 'was dropped' : turn.outcome}${turn.error ? `: ${turn.error}` : ''}`);
          }
        }
        break;
      }
      case 'room.typing':
        if (payload.userId !== myId) {
          const until = Date.now() + TYPING_SHOWN_MS;
          setTyping((t) => ({ ...t, [payload.userId]: { name: payload.username ?? 'someone', until } }));
        }
        break;
      case 'room.presence':
        setHere(payload.members ?? []);
        break;
      case 'room.removed':
        onRemoved(String(payload.reason ?? 'You no longer have access to this room.'));
        break;
      default:
        break;
    }
  };
  const onMessageRef = useRef(handleMessage);
  useEffect(() => {
    onMessageRef.current = handleMessage;
  });
  useEffect(() => gateway.onMessage((message) => onMessageRef.current(message)), [gateway]);

  // Typing lines fade on their own.
  useEffect(() => {
    const live = Object.values(typing);
    if (live.length === 0) return;
    const next = Math.min(...live.map((t) => t.until)) - Date.now();
    const timer = setTimeout(() => {
      const now = Date.now();
      setTyping((t) => Object.fromEntries(Object.entries(t).filter(([, v]) => v.until > now)));
    }, Math.max(next, 50));
    return () => clearTimeout(timer);
  }, [typing]);

  // Mark what I have seen as read (the unread badges follow).
  const newestId = messages.at(-1)?.id;
  useEffect(() => {
    if (!newestId || readSentRef.current === newestId || document.visibilityState !== 'visible') return;
    readSentRef.current = newestId;
    const sent = gateway.send({ type: 'room.read', roomId, messageId: newestId });
    // A space on another install is marked read through the frame only.
    const done = sent || remote
      ? Promise.resolve()
      : api.patch(`/spaces/${spaceId}/rooms/${roomId}/me`, { lastReadMessageId: newestId }).then(() => undefined);
    done
      .then(() => qc.invalidateQueries({ queryKey: source.roomsKey }))
      .catch((err: Error) => console.warn('Could not mark the room read', err));
  }, [gateway, newestId, qc, roomId, spaceId, source, remote]);

  const post = (content: string, addressed: boolean) => {
    const id = clientId();
    const command = content.startsWith('/');
    if (!command) setPending((p) => [...p, { clientId: id, content, at: new Date().toISOString() }]);
    inflightRef.current.push(id);
    if (gateway.send({ type: 'room.post', roomId, content, addressed, clientId: id })) {
      lastFrameAtRef.current = Date.now();
      return;
    }
    // The socket is down: the REST fallback stores the same post.
    source.post(roomId, { content, addressed, clientId: id })
      .then((outcome) => {
        if (outcome.message) setMessages((current) => merge(current, [outcome.message!]));
        dropPending(id);
        handlePosted({ ...outcome, clientId: id });
      })
      .catch((err: Error) => {
        dropPending(id);
        notify(err.message);
      });
  };

  const cancelQueued = (messageId: string) => {
    if (remote) {
      notify('Only members of the install that hosts this space can cancel a queued request.');
      return;
    }
    if (gateway.send({ type: 'room.cancel_queued', roomId, messageId })) lastFrameAtRef.current = Date.now();
    else notify('Not connected: the request cannot be cancelled right now.');
  };

  const loadOlder = async () => {
    const first = messages[0]?.id;
    if (!first) return;
    try {
      const page = await source.messages(roomId, { before: first, limit: PAGE });
      setMessages((current) => merge(current, page.messages));
      setHasOlder(page.hasMore);
    } catch (err) {
      notify(`Could not load older messages: ${(err as Error).message}`);
    }
  };

  const toggleMute = async () => {
    try {
      await api.patch(`/spaces/${spaceId}/rooms/${roomId}/me`, { muted: !room.muted });
      await qc.invalidateQueries({ queryKey: source.roomsKey });
    } catch (err) {
      notify(`Could not change the mute: ${(err as Error).message}`);
    }
  };

  /** My private chat in the space about this room (made once, then reopened). */
  const askPrivately = async () => {
    setAsking(true);
    try {
      const { sessions } = await api.get<{ sessions: Array<{ id: string; status: string; context?: { linkedRoomId?: string } }> }>('/sessions');
      let session = sessions.find((s) => s.status === 'active' && s.context?.linkedRoomId === roomId);
      if (!session) {
        session = await api.post<{ id: string; status: string }>('/sessions', {
          channelType: 'webchat',
          title: `Privately about #${room.title}`,
          context: { linkedRoomId: roomId },
        });
      }
      router.push(`/chat?session=${encodeURIComponent(session.id)}`);
    } catch (err) {
      notify(`Could not open your private chat: ${(err as Error).message}`);
      setAsking(false);
    }
  };

  /**
   * My own agent, here on my install, about this room of a space on another
   * install (federation §9): its session gets the room's recent messages
   * each turn, and posts only through its remote space tools, asking me first.
   */
  const askMyAgent = async () => {
    setAsking(true);
    try {
      const { session } = await api.post<{ session: { id: string } }>(remotePath(spaceId, ['rooms', roomId, 'agent']), {});
      router.push(`/chat?session=${encodeURIComponent(session.id)}`);
    } catch (err) {
      notify(`Could not open your agent: ${(err as Error).message}`);
      setAsking(false);
    }
  };

  const timeline: ChatMessageData[] = useMemo(() => {
    const stored: ChatMessageData[] = messages.map((m) => {
      if (m.role === 'assistant') {
        return { id: m.id, role: m.metadata.kind === 'progress' ? 'system' : 'assistant', content: m.content, timestamp: new Date(m.createdAt) };
      }
      const mine = !!myId && m.authorUserId === myId;
      return {
        id: m.id,
        role: 'user',
        content: m.content,
        timestamp: new Date(m.createdAt),
        author: { name: m.authorName ?? 'a former member', mine },
      };
    });
    const local: ChatMessageData[] = pending.map((p) => ({
      id: `pending-${p.clientId}`, role: 'user', content: p.content, timestamp: new Date(p.at), author: { name: 'you', mine: true }, pending: true,
    }));
    const said: ChatMessageData[] = notices.map((n) => ({ id: `notice-${n.id}`, role: 'system', content: n.text, timestamp: new Date(n.at) }));
    return [...stored, ...local, ...said];
  }, [messages, pending, notices, myId]);

  // The agent's newest post, when it spoke unprompted (a listen room, §9.3): members rate it.
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.metadata.kind !== 'progress');
  const lastUnprompted = lastAssistant?.metadata.unprompted ? lastAssistant : null;
  const myTurnRunning = !!myId && queue.running?.requesterId === myId && !queue.running.waiting;
  const typers = Object.values(typing).map((t) => t.name);
  const memberNames = remote
    ? (remoteMembers.data ?? []).map((m) => m.displayName)
    : (localMembers.data ?? []).map((m) => m.username);

  return (
    <div className="flex flex-1 min-w-0 min-h-0" data-testid="room-view" data-room-id={roomId}>
      <section className="flex flex-col flex-1 min-w-0 min-h-0" aria-label={`Room ${room.title}`}>
        <header className="flex items-center gap-2 px-4 h-11 shrink-0 border-b border-outline-variant/40 font-mono">
          {room.visibility === 'private' ? <Lock className="w-4 h-4 text-on-surface-variant" /> : <Hash className="w-4 h-4 text-on-surface-variant" />}
          <h1 className="text-[14px] text-on-surface truncate" data-testid="room-title">{room.title}</h1>
          <div className="flex items-center -space-x-1 ml-2" aria-label="In this room now" data-testid="room-presence">
            {here.filter((m) => m.userId !== myId).slice(0, 5).map((m) => (
              <span key={m.userId} title={m.username ?? undefined} className="h-5 w-5 rounded-full bg-surface-container-highest border border-background ring-1 ring-tertiary/60 flex items-center justify-center text-[8px] font-semibold">
                {initials(m.username)}
              </span>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1">
            {status !== 'connected' && (
              <span className="flex items-center gap-1 text-[11px] text-warning mr-2" role="status" data-testid="room-offline">
                <WifiOff className="w-3.5 h-3.5" /> live updates paused — reconnecting
              </span>
            )}
            {remote && access.role !== 'viewer' && (
              <button
                type="button"
                onClick={() => void askMyAgent()}
                disabled={asking}
                data-testid="ask-my-agent"
                title="Ask your own agent, on this install and your models, with this room's recent messages as context; it posts only after you approve"
                className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] rounded-xs border border-outline-variant/60 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high disabled:opacity-50 cursor-pointer"
              >
                <Bot className="w-3.5 h-3.5" /> Ask my agent
              </button>
            )}
            {!remote && access.role !== 'viewer' && (
              <button
                type="button"
                onClick={() => void askPrivately()}
                disabled={asking || access.archived}
                title="Ask Octipus in your own private chat, with this room's recent messages as context; the answer stays private"
                className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] rounded-xs border border-outline-variant/60 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high disabled:opacity-50 cursor-pointer"
              >
                <MessageSquareLock className="w-3.5 h-3.5" /> Ask privately
              </button>
            )}
            {!remote && <button
              type="button"
              onClick={() => void toggleMute()}
              aria-pressed={room.muted}
              aria-label={room.muted ? 'Unmute this room' : 'Mute this room'}
              title={room.muted ? 'Muted: no mention notifications, no unread badge in the sidebar' : 'Mute mentions of you in this room'}
              className="p-1.5 rounded-xs text-on-surface-variant hover:text-on-surface hover:bg-surface-container cursor-pointer"
            >
              {room.muted ? <BellOff className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
            </button>}
            <button
              type="button"
              onClick={() => setPanel((p) => (p ? null : 'members'))}
              aria-pressed={!!panel}
              aria-label="Room panel"
              className="p-1.5 rounded-xs text-on-surface-variant hover:text-on-surface hover:bg-surface-container cursor-pointer"
            >
              <PanelRight className="w-4 h-4" />
            </button>
          </div>
        </header>

        <TurnStrip queue={queue} myId={myId} onCancel={cancelQueued} />

        {load.state === 'error' && (
          <div role="alert" className="m-4 px-3 py-2 border border-error/40 bg-error/10 rounded-xs text-[12px] text-error font-mono">
            ! The room's messages could not be loaded: {load.error}
          </div>
        )}
        {load.state === 'loading' && <div className="p-4 font-mono text-[12px] text-on-surface-variant">loading…</div>}
        {load.state === 'ready' && (
          <>
            {hasOlder && (
              <button type="button" onClick={() => void loadOlder()} className="self-center mt-2 text-[11px] font-mono text-on-surface-variant hover:text-on-surface underline cursor-pointer">
                older messages…
              </button>
            )}
            <MessageTimeline
              messages={timeline}
              trackedAgents={new Map()}
              teams={new Map()}
              isLoading={myTurnRunning}
              statusMessage="Octipus is answering you"
              streamingText={myTurnRunning ? streaming?.text ?? null : null}
              emptyLabel="No messages yet — say hello, or ask Octipus"
              untrusted={remote}
            />
          </>
        )}

        {lastUnprompted && !remote && <UnpromptedFeedback key={lastUnprompted.id} spaceId={spaceId} roomId={roomId} messageId={lastUnprompted.id} />}

        <div className="h-5 px-4 text-[11px] font-mono text-on-surface-variant" aria-live="polite" data-testid="room-typing">
          {typers.length > 0 && `${typers.join(', ')} ${typers.length === 1 ? 'is' : 'are'} typing…`}
        </div>

        {access.canComment ? (
          <RoomComposer
            members={memberNames.filter((n) => n !== undefined)}
            canAsk={access.canComment}
            onPost={post}
            onTyping={() => { gateway.send({ type: 'room.typing', roomId }); }}
          />
        ) : (
          <div className="border-t border-outline-variant/60 px-4 py-3 text-[12px] font-mono text-on-surface-variant" data-testid="room-read-only">
            {access.archived
              ? 'This space is archived: the room is read-only.'
              : `You are a ${access.role} in this space: you can read this room, not post.`}
          </div>
        )}
      </section>

      {panel && (
        <aside className="w-72 shrink-0 border-l border-outline-variant/40 flex flex-col min-h-0 font-mono bg-surface-container-lowest" aria-label="Room panel">
          <div className="flex items-center border-b border-outline-variant/40" role="tablist">
            {(remote ? (['members'] as const) : (['members', 'memory', 'settings'] as const)).map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={panel === p}
                onClick={() => setPanel(p)}
                className={cn('flex-1 px-2 py-2 text-[12px] cursor-pointer border-b-2', panel === p ? 'border-primary text-primary' : 'border-transparent text-on-surface-variant hover:text-on-surface')}
              >
                {p === 'memory' ? 'space memory' : p}
              </button>
            ))}
            <button type="button" onClick={() => setPanel(null)} aria-label="Close the panel" className="px-2 text-on-surface-variant hover:text-on-surface cursor-pointer">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {panel === 'members' && (remote
              ? <RemoteMembersPanel members={remoteMembers.data ?? []} error={remoteMembers.error ? (remoteMembers.error as Error).message : null} />
              : <MembersPanel spaceId={spaceId} room={room} canManage={canManage && !access.archived} />)}
            {panel === 'memory' && <MemoryPanel spaceId={spaceId} canWrite={access.canWrite} />}
            {panel === 'settings' && <SettingsPanel key={`${room.id}:${room.updatedAt}`} spaceId={spaceId} room={room} canManage={canManage && !access.archived} />}
          </div>
        </aside>
      )}
    </div>
  );
}

/** 👍 / 👎 on the agent's unprompted post (`room_feedback`): tells the room's owners whether listen mode helps. */
function UnpromptedFeedback({ spaceId, roomId, messageId }: { spaceId: string; roomId: string; messageId: string }) {
  const [mine, setMine] = useState<1 | -1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rate = async (value: 1 | -1) => {
    const next = mine === value ? null : value;
    try {
      await api.put(`/spaces/${spaceId}/rooms/${roomId}/messages/${messageId}/feedback`, { value: next });
      setMine(next);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="flex items-center gap-2 px-4 py-1 text-[11px] font-mono text-on-surface-variant" data-testid="unprompted-feedback">
      <span>Octipus spoke up unprompted — was that useful?</span>
      <button type="button" aria-pressed={mine === 1} onClick={() => void rate(1)} className={cn('px-1 rounded-xs cursor-pointer', mine === 1 && 'bg-primary/20')}>👍</button>
      <button type="button" aria-pressed={mine === -1} onClick={() => void rate(-1)} className={cn('px-1 rounded-xs cursor-pointer', mine === -1 && 'bg-error/20')}>👎</button>
      {error && <span role="alert" className="text-error">{error}</span>}
    </div>
  );
}
