import { z } from 'zod';
import { CHAT_INLINE_ATTACHMENT_MAX_CHARS, CHAT_MESSAGE_MAX_CHARS } from '../../shared/chat-gateway';

// ── Trust Levels ──────────────────────────────────────────────────

/**
 * Trust never widens what a connection may see or touch: every authenticated
 * connection is `user`, whatever credential it used or where it came from.
 * Ownership checks compare user ids; admin-only commands read `is_admin` from
 * the database. (`local` — the machine token — and `system` — admin API tokens
 * and HMAC adapters — were removed: both reached every user's sessions.)
 */
export type TrustLevel = 'user' | 'agent';

// ── Client Types ──────────────────────────────────────────────────

export type ClientType = 'webchat' | 'tui' | 'channel' | 'mobile' | 'acp' | 'agent';

// ── Connection Context ────────────────────────────────────────────

export interface ConnectionContext {
  connectionId: string;
  userId: string;
  sessionId?: string;
  clientType: ClientType;
  trustLevel: TrustLevel;
  ip: string;
  connectedAt: number;
  lastActivityAt: number;
  eventSubscriptions: Set<string>;
  /**
   * Resources this connection receives through `GatewayHub.publishToResource`
   * (`artifact:<id>`, …). Filled only by a `subscribe` whose access check
   * passed — never by default, never by trust level.
   */
  resources: Set<string>;
  /**
   * Set on a connection that signed in with an `artifact_token`: the one
   * artifact it may subscribe to. Such a connection is not a user — it may
   * only ping and (un)subscribe that artifact's resource.
   */
  artifactId?: string;
  /**
   * The workspace this connection works in: the one named by the socket's
   * `?workspace=` (id or slug, owned by the user), else the user's default.
   * Resolved at auth; new sessions from `chat.send` are created in it.
   * Unset only on an artifact-viewer connection.
   */
  workspaceId?: string;
  /**
   * The API scopes of the token this connection signed in with (WS6), as on
   * the REST principal. Unset (all scopes) for a browser session and an
   * unscoped token; a frame that drives the agent needs `api:chat`
   * (`frameScopeError`).
   */
  scopes?: readonly string[];
  /**
   * The session this connection put into voice mode (`voice.set`): turn
   * events of that session are narrated to this connection as `voice.speak`.
   * Cleared on `voice.set {on:false}` and when the connection closes.
   */
  voiceSessionId?: string;
  /**
   * Set while the `permission.pending` snapshot for this connection is being
   * read: live `permission.*`, `agent.approval_required` and
   * `approval.resolved` events are held here and sent after the snapshot, so
   * a resolution during hydration cannot resurrect a request.
   */
  hydrationQueue?: UserGatewayEvent[];
  metadata: Record<string, unknown>;
}

// ── Gateway Events ────────────────────────────────────────────────

/**
 * Discriminator for events flowing through the gateway event bus.
 * New event types must be added here so subscribers can be type-checked
 * against typos and stale references.
 */
export type GatewayEventType =
  // Agent lifecycle
  | 'agent.spawned'
  | 'agent.completed'
  | 'agent.stopped'
  | 'agent.event'
  // Tool-call stream from the agent's executor — start / complete /
  // file_change / cli_tool_use payloads land here. Distinct subtype
  // so consumers can subscribe just to the stream without picking
  // up the generic agent.event bucket.
  | 'agent.action'
  // Per-iteration tick during a worker's reasoning loop. Surfaces so
  // chat/TUI UIs can show a "thinking …" indicator with a progress
  // count instead of a frozen spinner.
  | 'agent.iteration'
  // Emitted every ~20s while a worker sits in a legitimately-long wait, naming
  // WHAT it is waiting for (your approval / a child / a long tool) and for how
  // long. Purely informational — nothing is cancelled. Exists because all three
  // of those states look identical from outside: silence.
  | 'agent.blocked'
  // NOTE: `worker_spawned`, `worker_completed` and `pipeline_event` are NOT
  // gateway types and were never emitted as any. They belong to
  // `TurnEvent['type']`, and `mapTurnEventType` translates them
  // INTO `agent.spawned` / `agent.completed` / `pipeline.event` — so declaring
  // them here described a producer that by construction cannot exist. Same for
  // `status_update`, `typing`, `message` and `approval_required` below. All
  // found by the generated event matrix (`npm run catalog`).
  // Pipeline + team
  | 'pipeline.event'
  | 'team.started'
  | 'team.completed'
  // Swarm (Phase 1 + Phase 2)
  | 'swarm.node_spawned'
  | 'swarm.node_completed'
  // NOTE: there is no `swarm.node_status`. It was declared here and documented
  // in three places as an intermediate progress update, and nothing ever
  // emitted one — the generated event matrix (`npm run catalog`) is what
  // surfaced that. Retired rather than given a producer: nothing renders it
  // either, so writing one would be building a feature to satisfy a type. A
  // live worker's progress already travels as `agent.iteration` and
  // `agent.blocked`. Add the member back with its producer if that changes.
  | 'swarm.budget_warning'
  | 'swarm.call_graph_cycle_blocked'
  // Persona narration — derived from swarm.node_spawned / completed,
  // rendered through the active persona's narration_templates. Carries
  // a one-line `text` payload like "Octipus dispatches a research arm.".
  | 'swarm.narration'
  // Chat
  | 'chat.response'
  // A user-stamped chat line that is not a turn's reply: a steered message
  // (`injected: true`), a side question's answer (`sideChannel: true`), or an
  // in-app proactive delivery (`proactive: true`, `webChatChannel.sendToUser`).
  | 'chat.message'
  // Streamed slice of the root agent's reply text; the full text follows as chat.response.
  | 'chat.delta'
  // A chat.send turn that failed: every tab of the user showing the session
  // stops its spinner and shows the error.
  | 'chat.error'
  // Approval / permission flows
  | 'agent.approval_required'
  // A root-agent approval left the pending list (answered, timed out,
  // expired); every tab drops its prompt.
  | 'approval.resolved'
  | 'rootAgent.status'
  | 'permission.request'
  | 'permission.resolved'
  // Document processing (the documents queue), stamped with the uploader.
  | 'document.enqueued'
  | 'document.processing'
  | 'document.completed'
  | 'document.failed'
  // A local model install's progress (hwfit), stamped with who started it.
  | 'model.install_progress'
  // A spoken narration line for the connection(s) that put the session into
  // voice mode (`voice.set`) — never the user's other connections.
  | 'voice.speak'
  // Session. `session.cleared` was declared here with no producer and no
  // consumer, and is retired for the same reason as `swarm.node_status` above.
  | 'session.compaction_stalled'
  // Authoritative per-session usage, published at the end of every root turn:
  // token/cost totals straight from the cost log (so child agents are counted,
  // which a client summing the agent.completed events it happened to see is
  // not), plus how full the last prompt left the context window.
  | 'session.stats'
  // Audit (catch-all for connection-manager audit signals — payload carries
  // the specific audit event name in `originalType`).
  | 'audit'
  // Extensions (user-authored)
  | 'extension.notify'
  // Live Artifacts (Phase 8)
  | 'artifact.data_updated'
  | 'artifact.version_updated'
  | 'artifact.source_error'
  // Rooms (coworking §6.6): delivered to the resource `room:<id>` only.
  | 'room.message'
  | 'room.turn'
  | 'room.presence'
  | 'room.typing'
  | 'room.read'
  | 'room.removed'
  // Who is online in a space, and where (a room only when the recipient may
  // enter it, I3): to the resource `space:<id>`, one view per recipient.
  | 'space.presence'
  // A task of a space changed (coworking §9.3): ids only, to `space:<id>`.
  | 'task.changed'
  // Published only by the gateway's own tests, as a synthetic type to drive
  // subscription and replay. It shows up in the generated catalog's
  // never-published list because that scan deliberately excludes test files —
  // tests describe the code, they are not it — so this is the one entry there
  // with a good reason.
  | 'test.event';
  // NOTE: no `| 'error'`. That is a `ServerMessage` type (see below), sent
  // directly to one connection by the message handler, never an event on the
  // bus. Declaring it here described a second, parallel error channel that has
  // never existed.

/**
 * The event types that may travel without a user, each with the reason. Every
 * other event names the user it belongs to, and the hub delivers it to that
 * user's connections only, whatever their trust level. None of these reach a
 * client through the user rule: they stay on the internal bus, or go to a
 * resource (`artifact:<id>`) through `GatewayHub.publishToResource`.
 */
export const GLOBAL_EVENT_TYPES = {
  audit:
    'Connection-manager audit signals. Pre-auth ones (rejected or failed connections) have no user yet. Internal bus only, never sent to a client.',
  'extension.notify':
    'Host extensions are files the operator installs (~/.octipus/extensions, <cwd>/.octipus/extensions); there is no installing user. Internal bus only (other extensions), never sent to a client.',
  'artifact.data_updated':
    'Belongs to an artifact, not a user: sent to the resource artifact:<id> only, to connections that passed the artifact access check.',
  'artifact.version_updated':
    'Belongs to an artifact, not a user: sent to the resource artifact:<id> only, to connections that passed the artifact access check.',
  'artifact.source_error':
    'Belongs to an artifact, not a user: sent to the resource artifact:<id> only, to connections that passed the artifact access check.',
  'room.message':
    'Belongs to a room, not a user: sent to the resource room:<id> only, to connections whose room.subscribe passed roomAccess.',
  'room.turn':
    'Belongs to a room, not a user: sent to the resource room:<id> only, to connections whose room.subscribe passed roomAccess.',
  'room.presence':
    'Belongs to a room, not a user: sent to the resource room:<id> only, to connections whose room.subscribe passed roomAccess.',
  'room.typing':
    'Belongs to a room, not a user: sent to the resource room:<id> only, to connections whose room.subscribe passed roomAccess.',
  'room.read':
    'Belongs to a room, not a user: sent to the resource room:<id> only, to connections whose room.subscribe passed roomAccess.',
  'room.removed':
    'Sent once, directly, to a connection whose room subscription was just pruned (it lost access); never broadcast.',
  'space.presence':
    'Belongs to a space, not a user: sent to connections in the resource space:<id> (space.subscribe passed the membership check), each with its own view.',
  'task.changed':
    'Belongs to a space, not a user: sent to connections in the resource space:<id> (space.subscribe passed the membership check); ids only, the board refetches through the space door.',
} as const satisfies Partial<Record<GatewayEventType, string>>;

export type GlobalEventType = keyof typeof GLOBAL_EVENT_TYPES;
export type UserEventType = Exclude<GatewayEventType, GlobalEventType>;

export function isGlobalEventType(type: string): type is GlobalEventType {
  return Object.hasOwn(GLOBAL_EVENT_TYPES, type);
}

interface GatewayEventBase {
  id: string;
  source: string;
  sessionId?: string;
  timestamp: number;
  payload: unknown;
}

/** An event that belongs to one user and is delivered to that user only. */
export interface UserGatewayEvent extends GatewayEventBase {
  type: UserEventType;
  userId: string;
}

/** One of `GLOBAL_EVENT_TYPES`: may carry no user, never delivered by user. */
export interface GlobalGatewayEvent extends GatewayEventBase {
  type: GlobalEventType;
  userId?: string;
}

export type GatewayEvent = UserGatewayEvent | GlobalGatewayEvent;

// ── Client → Gateway Messages ─────────────────────────────────────

export const AuthMessageSchema = z.object({
  type: z.literal('auth'),
  method: z.enum(['session_token', 'api_key', 'artifact_token']),
  credentials: z.record(z.string(), z.unknown()),
  clientType: z.enum(['webchat', 'tui', 'channel', 'mobile', 'acp', 'agent']),
  clientVersion: z.string().optional(),
});

/**
 * A reference to a session-scoped workspace file the user attached to a turn,
 * so the agent operates on the file's current contents (edit-and-continue,
 * `.octipus/end-user-ux-design.md` Thread 2) instead of a copy pasted into the
 * transcript. `version` is the version the UI last saw — a mismatch is surfaced
 * to the agent, not silently ignored.
 */
export const FileRefSchema = z.object({
  path: z.string().min(1).max(4096),
  version: z.string().max(128).optional(),
});

export const ChatSendSchema = z.object({
  type: z.literal('chat.send'),
  sessionId: z.string().uuid(),
  content: z.string().min(1).max(CHAT_MESSAGE_MAX_CHARS),
  /**
   * Workspace a NEW session is created in (one the user owns); defaults to
   * the connection's workspace. An existing session keeps its own.
   */
  workspaceId: z.string().uuid().optional(),
  projectPath: z.string().optional(),
  /**
   * Small files inline, base64. They share the frame with everything else, so
   * each is held to the default `gateway.maxFrameBytes`; clients upload larger
   * files over REST (`POST /sessions/:id/attachments`) and send `fileRefs`.
   */
  attachments: z.array(z.object({
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(128),
    data: z.string().min(1).max(CHAT_INLINE_ATTACHMENT_MAX_CHARS),
  })).max(10).optional(),
  /** Session files to inline (current version) into this turn's context. */
  fileRefs: z.array(FileRefSchema).max(10).optional(),
  /** Chat/work split (Thread 3): force the deliverable mode for this message. */
  outputMode: z.enum(['inline', 'file']).optional(),
});

export const CommandSchema = z.object({
  type: z.literal('command'),
  name: z.string().min(1).max(50),
  args: z.record(z.string(), z.string()).optional(),
  /** Session to run against. The connection adopts it, so a client can resume a session before its first chat.send. */
  sessionId: z.string().uuid().optional(),
});

/** A resource a connection can subscribe to, e.g. `artifact:<uuid>`. */
const ResourceSchema = z.string().regex(/^[a-z]+:[A-Za-z0-9_-]{1,128}$/, 'resource must look like <kind>:<id>');

/**
 * `patterns` are event-type patterns over the connection's own events.
 * `resources` ask for a resource's events; each is access-checked and answered
 * with `subscribed` or a `FORBIDDEN` error.
 */
export const SubscribeSchema = z.object({
  type: z.literal('subscribe'),
  patterns: z.array(z.string().min(1).max(100)).max(50).optional(),
  resources: z.array(ResourceSchema).max(50).optional(),
}).refine(m => (m.patterns?.length ?? 0) + (m.resources?.length ?? 0) > 0, {
  message: 'subscribe needs at least one pattern or resource',
});

export const UnsubscribeSchema = z.object({
  type: z.literal('unsubscribe'),
  patterns: z.array(z.string().min(1).max(100)).max(50).optional(),
  resources: z.array(ResourceSchema).max(50).optional(),
}).refine(m => (m.patterns?.length ?? 0) + (m.resources?.length ?? 0) > 0, {
  message: 'unsubscribe needs at least one pattern or resource',
});

export const PermissionRespondSchema = z.object({
  type: z.literal('permission.respond'),
  requestId: z.string(),
  approved: z.boolean(),
});

export const ApprovalRespondSchema = z.object({
  type: z.literal('approval.respond'),
  requestId: z.string(),
  response: z.string(),
  approved: z.boolean(),
});

export const AgentStopSchema = z.object({
  type: z.literal('agent.stop'),
  agentId: z.string(),
});

/**
 * `chat.interject` — a non-blocking side-channel message sent while
 * the session already has an active root agent turn running.
 *
 * Distinct from `chat.send`:
 *   - `chat.send` is the canonical user input; substantive turns
 *     queue on a per-session basis.
 *   - `chat.interject` is a quick aside the user wants answered
 *     WITHOUT cancelling the in-flight task. The handler routes
 *     directly to the persona-tagged direct-response path, so the
 *     answer comes back with persona attribution ("Octipus — side
 *     question: …") in parallel with the swarm.
 *
 * Foundation for option (b) from the plan's B.3. The plumbing for
 * the *running* root agent to *observe* interject events lands
 * later; for now an interject opens a parallel mini-conversation.
 */
export const ChatInterjectSchema = z.object({
  type: z.literal('chat.interject'),
  sessionId: z.string().uuid(),
  content: z.string().min(1).max(20_000),
});

/**
 * `chat.steer` — inject a user message into the SAME running root agent turn
 * so it changes course mid-flight, instead of spawning a concurrent turn.
 *
 * Distinct from `chat.interject` (a parallel side-question that does NOT touch
 * the running turn): a steer enters the live root agent's context at the next
 * iteration boundary via its steering queue. If no root agent is currently
 * running for the session, the handler treats it like a normal `chat.send`.
 */
export const ChatSteerSchema = z.object({
  type: z.literal('chat.steer'),
  sessionId: z.string().uuid(),
  content: z.string().min(1).max(20_000),
});

export const PingSchema = z.object({
  type: z.literal('ping'),
});

// ── Spaces and rooms (coworking §6.6) ──
// Every frame below is access-checked when it arrives: membership read from
// the database for subscribe, post, read and cancel (D5); the in-process
// membership version for typing.

const RoomIdSchema = z.string().uuid();

/** Join the space's presence (`space:<id>`); answered with `subscribed` and a `space.presence`. */
export const SpaceSubscribeSchema = z.object({
  type: z.literal('space.subscribe'),
  spaceId: z.string().uuid(),
});

/**
 * Receive the room's events (`room:<id>`). `afterMessageId` asks for the
 * posts missed since (catch-up after a reconnect, served from the messages
 * table): answered with `room.catchup`.
 */
export const RoomSubscribeSchema = z.object({
  type: z.literal('room.subscribe'),
  roomId: RoomIdSchema,
  afterMessageId: z.string().uuid().optional(),
});

export const RoomUnsubscribeSchema = z.object({
  type: z.literal('room.unsubscribe'),
  roomId: RoomIdSchema,
});

/**
 * Post in a room. `addressed` (the "Ask Octipus" toggle, or `@octipus` in
 * the text) queues a turn for the poster. `clientId` is echoed on the
 * resulting `room.message` so the client reconciles its optimistic copy.
 */
export const RoomPostSchema = z.object({
  type: z.literal('room.post'),
  roomId: RoomIdSchema,
  content: z.string().min(1).max(CHAT_MESSAGE_MAX_CHARS),
  addressed: z.boolean().optional(),
  clientId: z.string().min(1).max(64).optional(),
});

export const RoomReadSchema = z.object({
  type: z.literal('room.read'),
  roomId: RoomIdSchema,
  messageId: z.string().uuid(),
});

/** "I am typing" — clients send at most one per 3 s. */
export const RoomTypingSchema = z.object({
  type: z.literal('room.typing'),
  roomId: RoomIdSchema,
});

export const RoomCancelQueuedSchema = z.object({
  type: z.literal('room.cancel_queued'),
  roomId: RoomIdSchema,
  messageId: z.string().uuid(),
});

/**
 * `voice.set` — put a session into (or out of) voice mode for this
 * connection: the root agent's propose-then-confirm gate applies to the
 * user's turns in it, and its lifecycle is narrated to this connection as
 * `voice.speak`. Owner-checked like `chat.send`.
 */
export const VoiceSetSchema = z.object({
  type: z.literal('voice.set'),
  sessionId: z.string().uuid(),
  on: z.boolean(),
});

/**
 * `replay` — a reconnecting client asks for the events of one of its own
 * sessions published after `afterEventId`. Answered with a `replay` message;
 * without `afterEventId` the client has no watermark to resume from, so the
 * answer is `gap: true` with no events (it reloads from REST rather than
 * apply the whole buffer a second time).
 */
export const ReplaySchema = z.object({
  type: z.literal('replay'),
  sessionId: z.string().uuid(),
  afterEventId: z.string().min(1).max(64).optional(),
});

// ── Live documents (docs/plans/coworking-spec.md §7.3, S3) ─────────

/** A base64 Yjs update, state vector or awareness update. The frame cap bounds its size. */
const Base64Schema = z.string().max(64 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'must be base64');

/**
 * `doc.join` — open a space note for live editing. A client that already
 * holds the note's document passes the `epoch` it was synced at and its
 * `stateVector`: with a matching epoch the answer is only what it lacks;
 * otherwise it is the whole document and the client discards its own.
 */
export const DocJoinSchema = z.object({
  type: z.literal('doc.join'),
  noteId: z.string().uuid(),
  epoch: z.string().min(1).max(64).optional(),
  stateVector: Base64Schema.optional(),
});

/** `doc.update` — a Yjs update to the note's document, made at `epoch`. */
export const DocUpdateSchema = z.object({
  type: z.literal('doc.update'),
  noteId: z.string().uuid(),
  epoch: z.string().min(1).max(64),
  update: Base64Schema.min(1),
});

/** `doc.awareness` — cursors and selections (a y-protocols awareness update). */
export const DocAwarenessSchema = z.object({
  type: z.literal('doc.awareness'),
  noteId: z.string().uuid(),
  update: Base64Schema.min(1),
});

/** `doc.leave` — stop editing the note. */
export const DocLeaveSchema = z.object({
  type: z.literal('doc.leave'),
  noteId: z.string().uuid(),
});

// Union of all client messages
export const ClientMessageSchema = z.discriminatedUnion('type', [
  AuthMessageSchema,
  ChatSendSchema,
  ChatInterjectSchema,
  ChatSteerSchema,
  CommandSchema,
  SubscribeSchema,
  UnsubscribeSchema,
  PermissionRespondSchema,
  ApprovalRespondSchema,
  AgentStopSchema,
  PingSchema,
  VoiceSetSchema,
  ReplaySchema,
  SpaceSubscribeSchema,
  RoomSubscribeSchema,
  RoomUnsubscribeSchema,
  RoomPostSchema,
  RoomReadSchema,
  RoomTypingSchema,
  RoomCancelQueuedSchema,
  DocJoinSchema,
  DocUpdateSchema,
  DocAwarenessSchema,
  DocLeaveSchema,
]);

export type AuthMessage = z.infer<typeof AuthMessageSchema>;
export type ChatSendMessage = z.infer<typeof ChatSendSchema>;
export type CommandMessage = z.infer<typeof CommandSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ── Gateway → Client Messages ─────────────────────────────────────

export interface AuthOkMessage {
  type: 'auth_ok';
  connectionId: string;
  sessionId?: string;
  userId: string;
  capabilities: string[];
  serverTime: string;
  serverTimezone: string;
  /** The largest frame the server accepts (`gateway.maxFrameBytes`). */
  maxFrameBytes?: number;
}

export interface AuthErrorMessage {
  type: 'auth_error';
  reason: string;
}

export interface EventMessage {
  type: 'event';
  event: GatewayEvent;
}

export interface CommandResultMessage {
  type: 'command.result';
  name: string;
  result: unknown;
  error?: string;
  /** Structured payload for clients that render more than text (session lists, transcripts). */
  data?: unknown;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export interface PongMessage {
  type: 'pong';
  serverTime: string;
}

/** Acknowledges the resources of a `subscribe` that passed the access check. */
export interface SubscribedMessage {
  type: 'subscribed';
  resources: string[];
}

export interface EventsDroppedMessage {
  type: 'events_dropped';
  count: number;
  reason: string;
}

/** An open permission request, as `permission.request` carries it. */
export interface PendingPermission {
  requestId: string;
  toolId: string;
  action: string;
  toolName: string;
  args: Record<string, unknown>;
  sessionId?: string;
}

/** An open root-agent approval, as `agent.approval_required` carries it. */
export interface PendingApproval {
  requestId: string;
  sessionId: string;
  summary: string;
  question: string;
  options?: string[];
}

/**
 * The connection's user's open permission requests and root-agent approvals.
 * Sent after every `subscribe` of a user connection (live events raised while
 * it was read follow it), and again after a `permission.respond` that found
 * the request already answered. Authoritative: a client replaces its list.
 */
export interface PermissionPendingMessage {
  type: 'permission.pending';
  requests: PendingPermission[];
  approvals: PendingApproval[];
}

/**
 * Answer to `replay`. `gap` is true when `afterEventId` is missing or no
 * longer in the buffer (the session was evicted, or more events passed than
 * are kept): the client cannot catch up from `events` alone and reloads from
 * REST.
 */
export interface ReplayMessage {
  type: 'replay';
  sessionId: string;
  events: GatewayEvent[];
  gap: boolean;
}

/** Answer to `room.subscribe` with `afterMessageId`: the room's posts since, oldest first. */
export interface RoomCatchupMessage {
  type: 'room.catchup';
  roomId: string;
  messages: unknown[];
  /** More posts follow; page with the last id. */
  hasMore: boolean;
}

/** Answer to a `room.post`: stored (and queued when addressed). */
export interface RoomPostedMessage {
  type: 'room.posted';
  roomId: string;
  messageId: string;
  clientId?: string;
  /** Set when the post queued a turn: its position (0 = runs next). */
  queuedPosition?: number;
  /** Set when the post was addressed but no turn was queued, with why. */
  notQueued?: string;
  /** A room command's answer (`/status`, `/stop`, …), for the poster only. */
  commandResult?: string;
}

// ── Live documents (S3) ──────────────────────────────────────────

/**
 * The note's document: everything (`state` is a full Yjs update) when the
 * client's epoch differs, else what its state vector lacks. `epoch` changes
 * whenever the server rebuilds the document from `notes.body`; a client
 * holding another epoch discards its document and re-seeds from `state`.
 */
export interface DocSyncMessage {
  type: 'doc.sync';
  noteId: string;
  epoch: string;
  state: string;
  /** The server's state vector: the client sends back what it has beyond it. */
  stateVector: string;
  /** The member may read but not edit (commenter, viewer, archived space). */
  readOnly: boolean;
  /** sha256 of the text as synced. */
  sha256: string;
  /** `spaces.noteMaxBytes`. */
  maxBytes: number;
}

export interface DocUpdateMessage {
  type: 'doc.update';
  noteId: string;
  epoch: string;
  update: string;
}

export interface DocAwarenessMessage {
  type: 'doc.awareness';
  noteId: string;
  update: string;
}

/** The note was saved (the "Saved" indicator). */
export interface DocSavedMessage {
  type: 'doc.saved';
  noteId: string;
  sha256: string;
  revisionId: string;
  savedAt: string;
}

/** The member's edit right changed (role change, space archived or unarchived). */
export interface DocStatusMessage {
  type: 'doc.status';
  noteId: string;
  readOnly: boolean;
}

/** The connection is no longer in the note's document. */
export interface DocClosedMessage {
  type: 'doc.closed';
  noteId: string;
  reason: 'access' | 'archived' | 'deleted';
}

export type DocErrorCode =
  | 'NOT_FOUND'
  | 'NOT_JOINED'
  | 'FORBIDDEN'
  | 'ARCHIVED'
  | 'RATE_LIMITED'
  | 'TOO_LARGE'
  | 'STALE_EPOCH'
  | 'INVALID_UPDATE';

/** A refused `doc.*` frame. Nothing of it was applied. */
export interface DocErrorMessage {
  type: 'doc.error';
  noteId: string;
  code: DocErrorCode;
  message: string;
}

/**
 * The agent's edit proposals for the note changed (§7.4): one was made or
 * updated, accepted, rejected or went stale. Sent to the note's `doc:<id>`
 * resource; `pending` is how many wait for a decision now.
 */
export interface DocProposalsMessage {
  type: 'doc.proposals';
  noteId: string;
  spaceId: string;
  pending: number;
}

export interface FileLeaseView {
  path: string;
  /** Null (with `holderName`) for a guest when the holder is not among the members of their rooms (S6). */
  holderUserId: string | null;
  holderName: string | null;
  holderKind: 'human' | 'agent';
  expiresAt: string;
}

/** The space's live file leases ("Ben is editing"), after every change, to the `space:<id>` resource. */
export interface FileLeasesMessage {
  type: 'file.leases';
  spaceId: string;
  leases: FileLeaseView[];
}

export type GatewayMessage =
  | AuthOkMessage
  | AuthErrorMessage
  | EventMessage
  | CommandResultMessage
  | ErrorMessage
  | PongMessage
  | SubscribedMessage
  | EventsDroppedMessage
  | PermissionPendingMessage
  | ReplayMessage
  | RoomCatchupMessage
  | RoomPostedMessage
  | DocSyncMessage
  | DocUpdateMessage
  | DocAwarenessMessage
  | DocSavedMessage
  | DocStatusMessage
  | DocClosedMessage
  | DocErrorMessage
  | DocProposalsMessage
  | FileLeasesMessage;

// ── Protocol Version ──────────────────────────────────────────────

export const PROTOCOL_VERSION = '1.0';
export const SUPPORTED_VERSIONS = ['1.0'];

// ── Connection States ─────────────────────────────────────────────

export type ConnectionState = 'connecting' | 'authenticating' | 'active' | 'draining' | 'closed';

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Validate a raw JSON message from a client.
 * Returns the parsed message or null if invalid.
 */
export function parseClientMessage(raw: string): { ok: true; message: ClientMessage } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Invalid JSON' };
  }

  const result = ClientMessageSchema.safeParse(json);
  if (!result.success) {
    const firstError = result.error.issues[0];
    return { ok: false, error: `Invalid message: ${firstError?.path.join('.')} — ${firstError?.message}` };
  }

  return { ok: true, message: result.data };
}

/**
 * Check if an event type matches a subscription pattern.
 * Supports: exact match, prefix wildcard (e.g., "agent.*"), global wildcard ("*")
 */
export function matchesPattern(eventType: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern === eventType) return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    return eventType.startsWith(prefix + '.');
  }
  return false;
}
