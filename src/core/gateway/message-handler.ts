import { decodeChatAttachment, storeChatUploads } from '@/core/chat-uploads';
import { sessionFsAccess, WorkspaceFS } from '@/security/workspace-fs';
import { resolveSession, turnWorkspaceId } from '@/core/agent/session-resolver';
import { isSessionControlMessage } from '@/core/session-controls';
import { canActInSession } from '@/core/rooms/access';
import { mentionsOctipus } from '@/core/rooms/service';
import { API_SCOPES, scopesSatisfy } from '@/security/scopes';
import { coreLogger } from '@/utils/logger';
import { resolveInlineUiTurnNotes, type InlineUiTurnNotes } from '@/core/inline-ui/turn-input';
import { presenceAfterClose } from '@/core/rooms/presence';
import { getCommandRegistry } from './commands';
import { handleRoomFrame, isRoomFrame } from './room-handlers';
import type { GatewayHub } from './hub';
import { cancelQueuedTurns, isSessionTurnCancelled, isSessionTurnRunning, queuedTurnCount } from '@/core/session-turn-lock';
import type { ClientMessage, ConnectionContext, PendingApproval, PendingPermission, PermissionPendingMessage, SendMode, SendOutcome } from './protocol';

/**
 * Inject a user message into a running root agent turn for this session, if
 * one exists, so it changes course mid-flight instead of racing a concurrent
 * turn. Returns true when a live root agent absorbed the message.
 *
 * This is the per-session lock the steering design calls for: one live
 * root agent per session; while it runs, further user messages steer it. The
 * root agent drains its steering queue at the next iteration boundary, and
 * because spawning is always-detach it is genuinely free between iterations to
 * react. The injected message is persisted so the transcript stays complete
 * (the steering queue itself does not persist).
 */
type SteerableWorker = {
  steer: (m: { role: 'user'; content: string; timestamp: Date }) => void | boolean;
  canAcceptSteering?: () => boolean;
  /** Will guidance reach the running turn (not only a later tool response or the next turn)? Absent: yes. */
  acceptsMidTurnSteering?: () => boolean;
};

/** Why a message was not steered; `running` when a turn is running all the same. */
export type SteerAttempt = { steered: true } | { steered: false; running: boolean; reason: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * May this connection use `sessionId`? Null when yes: the session is the
 * caller's own or does not exist yet (a fresh client id). Otherwise the
 * refusal text. One gate for every path that binds a connection to a session
 * (chat.send, chat.steer, chat.interject, command adoption) — before it, any
 * authenticated client could attach to another user's existing session by id
 * and read or extend it. It compares user ids and nothing else: no trust
 * level and no admin flag opens another user's session.
 */
export async function sessionAccessError(sessionId: string, context: Pick<ConnectionContext, 'userId'>): Promise<string | null> {
  if (!UUID_RE.test(sessionId)) return null; // channel-style ids resolve per user inside resolveSession
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  const session = await sessionRepository.findById(sessionId);
  // A room is never a personal chat, its creator's included (§6.2): room
  // frames are `room.*`.
  return session && !(await canActInSession(session, context.userId, 'chat')) ? 'Session not found' : null;
}

/**
 * Is `sessionId` an existing session of this connection's user? Stricter than
 * `sessionAccessError`: reading a session's past (replay) needs the row, so a
 * session that does not exist yet is refused like another user's.
 */
async function ownsExistingSession(sessionId: string, context: Pick<ConnectionContext, 'userId'>): Promise<boolean> {
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  const session = await sessionRepository.findById(sessionId);
  return canActInSession(session, context.userId, 'chat');
}

/**
 * The user's open permission requests and root-agent approvals, in the shape
 * `permission.request` / `agent.approval_required` carry them.
 */
export async function readPendingSnapshot(userId: string): Promise<Omit<PermissionPendingMessage, 'type'>> {
  const [{ getPermissionManager }, { getAgentService }] = await Promise.all([
    import('@/security/permissions'),
    import('@/core/agent'),
  ]);
  const rows = await getPermissionManager().getPendingRequests(userId);
  const requests: PendingPermission[] = rows.map((row) => ({
    requestId: row.id,
    toolId: row.toolId,
    action: row.action,
    toolName: row.context.toolName,
    args: row.context.toolArguments,
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
  }));
  const approvals: PendingApproval[] = getAgentService().getPendingApprovals(userId).map((approval) => ({
    requestId: approval.id,
    ...(approval.kind === 'question' ? { kind: 'question' as const } : {}),
    sessionId: approval.sessionId,
    summary: approval.summary,
    question: approval.question,
    ...(approval.options ? { options: approval.options } : {}),
  }));
  return { requests, approvals };
}

/** Exported for unit tests. True when a live root agent absorbed the message. */
export async function trySteerRunningRootAgent(sessionId: string, content: string, inlineUi?: InlineUiTurnNotes): Promise<boolean> {
  return (await steerRunningRootAgent(sessionId, content, inlineUi)).steered;
}

/**
 * `trySteerRunningRootAgent` with the reason it did not steer, for the send
 * modes' `chat.delivery` answer. Nothing is stored unless it steered.
 */
export async function steerRunningRootAgent(sessionId: string, content: string, inlineUi?: InlineUiTurnNotes): Promise<SteerAttempt> {
  const { getAgentManager } = await import('@/core/agent-manager');
  const running = getAgentManager().getBySession(sessionId)
    .filter((a) => a.getStatus() === 'running' && a.getContext().root === true && !a.getContext().metadata?.companionBriefing);
  const refuse = (reason: string): SteerAttempt => ({ steered: false, running: running.length > 0, reason });
  // Slash commands must reach the command registry, never become model guidance.
  if (content.trimStart().startsWith('/') || isSessionControlMessage(content)) return refuse('A command is never steered into a running turn.');
  const target = running.find((a): a is typeof a & SteerableWorker => typeof (a as Partial<SteerableWorker>).steer === 'function');
  if (!target) return refuse(running.length ? 'The running agent cannot take guidance.' : 'No turn is running in this session.');
  if (target.canAcceptSteering?.() === false) return refuse('The running turn is finishing and takes no more guidance.');
  // A buffered CLI (Vibe, Antigravity) would hold the guidance until a later
  // tool response or report it unhandled at the end: not a live steer.
  if (target.acceptsMidTurnSteering?.() === false) return refuse('The running agent cannot take input mid-turn.');
  // A room turn is never steered: a member's post is stored once by the
  // room, and a running room turn belongs to its requester alone (§6.3).
  if (target.getContext().metadata?.room) return refuse('A room turn is never steered.');

  // Guard the injected content exactly as handleMessage guards a normal turn —
  // a steer must not be a hole around the input guard. On block, refuse so
  // the caller falls through to the normal path, which surfaces the block.
  const { guardInput } = await import('@/core/agent/input-guard');
  if (guardInput(content).action === 'block') {
    coreLogger.warn({ sessionId }, 'Input guard blocked a steering message — routing through normal path');
    return refuse('The input guard blocked this message.');
  }

  // Interactive-answer notes (reports, provenance) ride ahead of the steer
  // for the model, and on the row as its prompt context, like a normal turn.
  const notes = inlineUi?.notes.join('\n') ?? '';
  if (target.steer({ role: 'user', content: notes ? `${notes}\n\n${content}` : content, timestamp: new Date() }) === false) {
    return refuse('The running turn is finishing and takes no more guidance.');
  }

  // Race guard: if the root agent finished between the status check and the
  // steer, its steering queue will never drain. Don't persist an orphaned user
  // message — fall back to a normal turn (the dead queue copy is harmless).
  if (target.getStatus() !== 'running') return { steered: false, running: false, reason: 'The running turn ended before the message arrived.' };

  try {
    const { messageRepository } = await import('@/db/repositories/message-repository');
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const metadata = {
      ...(notes ? { promptContext: notes } : {}),
      ...(inlineUi?.provenanceId ? { inlineUiProvenance: { id: inlineUi.provenanceId } } : {}),
    };
    await messageRepository.create({ sessionId, role: 'user', content, ...(Object.keys(metadata).length ? { metadata } : {}) });
    await sessionRepository.incrementMessageCount(sessionId);
  } catch (err) {
    coreLogger.error({ err, sessionId }, 'failed to persist steered user message');
  }
  return { steered: true };
}

/**
 * Stop the session's running turn for a `restart` send, the way `/stop` does
 * (every agent of the session; each ends at its next boundary). The queued
 * turns stay. Returns whether a root turn was running.
 */
async function interruptRunningTurn(sessionId: string, userId: string): Promise<boolean> {
  const { getAgentManager } = await import('@/core/agent-manager');
  const mgr = getAgentManager();
  const running = mgr.getBySession(sessionId).some((a) => a.getStatus() === 'running' && a.getContext().root === true);
  if (running) mgr.stopSession(sessionId, userId);
  return running;
}

/**
 * Wire the gateway hub's message handler to route authenticated messages
 * to the appropriate backend services (root agent, permissions, agents).
 */
export function wireMessageHandler(hub: GatewayHub): void {
  hub.setPendingSnapshotProvider(readPendingSnapshot);

  // A connection that put a session into voice mode takes it out when it
  // goes, so a refresh does not leave the session in the planning gate —
  // unless another connection of the user still holds it in voice mode.
  hub.setConnectionClosedHandler((context) => {
    // Rooms and spaces it was in show it gone (coworking §6.6).
    presenceAfterClose(context);
    // Spaces on other installs it used: their hosts drop its connections
    // there (`conn.close`, federation §8.2).
    import('@/core/federation/visitor-ops')
      .then(({ remoteConnectionClosed }) => remoteConnectionClosed(context))
      .catch((err: unknown) => coreLogger.error({ err, connectionId: context.connectionId }, 'Could not close the remote connections of a closed connection'));
    // Live documents the connection had open: it leaves them (the last one
    // out persists the note).
    import('@/core/docs')
      .then(({ getDocHub }) => getDocHub().connectionClosed(context.connectionId))
      .catch((err: unknown) => coreLogger.error({ err, connectionId: context.connectionId }, 'Could not leave the documents of a closed connection'));
    const sessionId = context.voiceSessionId;
    if (!sessionId) return;
    context.voiceSessionId = undefined;
    if (voiceHeldElsewhere(hub, context, sessionId)) return;
    import('@/core/agent')
      .then(({ getAgentService }) => getAgentService().setVoiceMode(sessionId, context.userId, false))
      .catch((err: unknown) => coreLogger.error({ err, sessionId }, 'Could not clear voice mode of a closed connection'));
  });

  hub.setMessageHandler(async (connectionId, context, message) => {
    const scopeError = frameScopeError(context, message);
    if (scopeError) {
      hub.connectionManager.sendToConnection(connectionId, { type: 'error', code: 'FORBIDDEN', message: scopeError });
      return;
    }
    switch (message.type) {
      case 'chat.send':
        await handleChatSend(hub, connectionId, context, message);
        break;

      case 'chat.interject':
        await handleChatInterject(hub, connectionId, context, message);
        break;

      case 'chat.steer':
        await handleChatSteer(hub, connectionId, context, message);
        break;

      case 'command':
        await handleCommand(hub, connectionId, context, message);
        break;

      case 'permission.respond':
        await handlePermissionRespond(hub, connectionId, context, message);
        break;

      case 'approval.respond':
        await handleApprovalRespond(hub, connectionId, context, message);
        break;

      case 'agent.stop':
        await handleAgentStop(hub, connectionId, context, message);
        break;

      case 'voice.set':
        await handleVoiceSet(hub, connectionId, context, message);
        break;

      case 'replay':
        await handleReplay(hub, connectionId, context, message);
        break;

      // Live documents (docs/plans/coworking-spec.md §7.3). `doc.join` reads
      // the membership from the database; updates and awareness check the
      // in-process membership version (D5).
      case 'doc.join': {
        const { getDocHub } = await import('@/core/docs');
        await getDocHub().join(context, message.noteId, { epoch: message.epoch, stateVector: message.stateVector });
        break;
      }

      case 'doc.update': {
        const { getDocHub } = await import('@/core/docs');
        await getDocHub().update(context, message.noteId, message.epoch, message.update);
        break;
      }

      case 'doc.awareness': {
        const { getDocHub } = await import('@/core/docs');
        await getDocHub().awareness(context, message.noteId, message.update);
        break;
      }

      case 'doc.leave': {
        const { getDocHub } = await import('@/core/docs');
        await getDocHub().leave(context.connectionId, message.noteId);
        break;
      }

      // A frame for a space on another install (federation §8.2): the
      // pointer row must be this user's; the host checks the rest.
      case 'remote.frame': {
        const { handleRemoteFrame } = await import('@/core/federation/visitor-ops');
        await handleRemoteFrame(hub, connectionId, context, message);
        break;
      }

      default:
        // Spaces and rooms (coworking §6.6): access-checked per frame.
        if (isRoomFrame(message)) {
          await handleRoomFrame(hub, connectionId, context, message);
          break;
        }
        // ping, subscribe, unsubscribe handled by hub itself
        break;
    }
  });
}

/**
 * Frames that drive the agent or answer its prompts — what `api:chat` covers
 * on REST (`POST /api/chat`, `/chat/approve`, the learning toggle).
 */
const CHAT_FRAMES: ReadonlySet<string> = new Set([
  'chat.send', 'chat.interject', 'chat.steer', 'command', 'permission.respond', 'approval.respond', 'voice.set',
]);

/**
 * WS6 on the gateway: why a connection signed in with a scoped API token may
 * not send `message`, or null. A frame that drives the agent needs
 * `api:chat` — a room post too when it asks Octipus (the `addressed` toggle
 * or an @octipus mention), as on `POST /api/spaces/:id/rooms/:roomId/messages`.
 * Everything else is what REST lets any token do (reads, subscriptions,
 * documents, room posts that do not ask the agent).
 */
export function frameScopeError(context: Pick<ConnectionContext, 'scopes'>, message: ClientMessage): string | null {
  if (scopesSatisfy(context.scopes, API_SCOPES.CHAT)) return null;
  // A frame for a space on another install: judged as the frame it carries.
  if (message.type === 'remote.frame') {
    const inner = message.frame as { type: string; content?: unknown; addressed?: unknown };
    const asks = inner.type === 'room.post' && typeof inner.content === 'string' && !inner.content.trim().startsWith('/')
      && (inner.addressed === true || mentionsOctipus(inner.content));
    return asks ? `API token missing required scope "${API_SCOPES.CHAT}"` : null;
  }
  const drives = CHAT_FRAMES.has(message.type)
    || (message.type === 'room.post' && !message.content.trim().startsWith('/') && (message.addressed === true || mentionsOctipus(message.content)));
  return drives ? `API token missing required scope "${API_SCOPES.CHAT}"` : null;
}

async function handleChatSend(
  hub: GatewayHub,
  connectionId: string,
  context: ConnectionContext,
  message: Extract<ClientMessage, { type: 'chat.send' }>,
): Promise<void> {
  try {
    const { getAgentService } = await import('@/core/agent');
    const rootAgent = getAgentService();

    const refused = await sessionAccessError(message.sessionId, context);
    if (refused) {
      hub.connectionManager.sendToConnection(connectionId, { type: 'error', code: 'SESSION_NOT_FOUND', message: refused });
      return;
    }
    // Track the session on the connection for /status command
    context.sessionId = message.sessionId;

    const userId = context.userId;
    const mode: SendMode = message.mode ?? 'auto';
    const deliver = (outcome: SendOutcome, extra: { ahead?: number; reason?: string } = {}) =>
      hub.connectionManager.sendToConnection(connectionId, { type: 'chat.delivery', sessionId: message.sessionId, mode, outcome, ...extra });

    // If a root agent turn is already running for this session, steer it
    // with this message instead of spawning a concurrent turn (`auto`,
    // `steer`). Keeps one live root agent per session; the user can redirect
    // work mid-flight. A root that cannot take input mid-turn (a buffered
    // CLI) gets the message as its next turn instead.
    const inlineUiNotes = await resolveInlineUiTurnNotes(message.sessionId, message.inlineUi);
    let queuedBecause: string | undefined;
    if (mode === 'auto' || mode === 'steer') {
      const steer: SteerAttempt = message.attachments?.length || message.fileRefs?.length
        ? { steered: false, running: isSessionTurnRunning(message.sessionId), reason: 'A message with files is never steered; it runs as its own turn.' }
        : await steerRunningRootAgent(message.sessionId, message.content, inlineUiNotes);
      if (steer.steered) {
        hub.publishEvent({
          type: 'chat.message',
          source: `steer:${connectionId}`,
          userId,
          sessionId: message.sessionId,
          payload: {
            role: 'user', content: message.content, injected: true,
            ...(inlineUiNotes.provenanceId ? { inlineUiProvenance: { id: inlineUiNotes.provenanceId } } : {}),
          },
        });
        deliver('steered');
        return;
      }
      if (mode === 'steer') {
        deliver('refused', { reason: steer.reason });
        return;
      }
      if (steer.running) queuedBecause = steer.reason;
    }

    // A new session is created in the send's workspace: the one the message
    // names, else the connection's (the TUI's `?workspace=`, resolved at
    // auth). Either must be the user's own (`turnWorkspaceId` checks); an
    // existing session keeps the workspace it was created in.
    const sendWorkspace = message.workspaceId ?? context.workspaceId;

    // Set project context on the session if provided (enables dev mode).
    //
    // The TUI generates a fresh sessionId per launch — so when the very
    // first message arrives, `findById` returns null, the previous version
    // of this block silently skipped the projectPath write, and by the
    // time the root agent created the row inside `resolveSession`,
    // devMode/projectPath had been lost. The root agent then fell back
    // to the generic workspace path and child workers operated against
    // the wrong repo. Pre-create the session row here when projectPath
    // is supplied so the dev-mode context is in place before the
    // root agent reads it.
    // devMode/projectPath point the agent at an arbitrary host path, so honor
    // them only for a single-user install or an admin caller — otherwise any
    // user on a shared instance could escape their workspace sandbox by
    // sending projectPath='/etc'. Gated at this ingestion site so the flag
    // never reaches session context for an untrusted caller. (See
    // src/security/devmode.ts; mirrors the REST /chat gate.)
    let devModeOk = false;
    if (message.projectPath) {
      const { userRepository } = await import('@/db/repositories/user-repository');
      const { checkProjectPath, devModeAllowed } = await import('@/security/devmode');
      const u = await userRepository.findById(userId);
      devModeOk = devModeAllowed(!!u?.isAdmin, message.projectPath);
      if (!devModeOk) {
        // Distinguish the two rejection causes — "you're not an admin" and
        // "that path isn't a project" need very different operator responses.
        const pathCheck = u?.isAdmin ? checkProjectPath(message.projectPath) : undefined;
        coreLogger.warn(
          { userId, sessionId: message.sessionId, projectPath: message.projectPath, reason: pathCheck?.reason },
          pathCheck
            ? 'Ignoring devMode/projectPath — rejected project path'
            : 'Ignoring devMode/projectPath from non-admin under multiuser',
        );
      }
    }
    if (message.projectPath && devModeOk) {
      const { sessionRepository } = await import('@/db/repositories/session-repository');
      const session = await sessionRepository.findById(message.sessionId);
      if (session) {
        const existingCtx = (session.context || {}) as Record<string, unknown>;
        if (!existingCtx.projectPath) {
          await sessionRepository.update(message.sessionId, {
            context: {
              ...existingCtx,
              devMode: true,
              projectPath: message.projectPath,
              projectName: message.projectPath.split(/[/\\]/).pop() || 'project',
            },
          });
          coreLogger.info({ sessionId: message.sessionId, projectPath: message.projectPath }, 'Set project context on session');
        }
      } else {
        // Pre-create with dev-mode context baked in. resolveSession will
        // see the row exists and skip its own create. Created in the
        // send's workspace so the session shows up only in that
        // workspace's session list.
        const workspaceId = await turnWorkspaceId(userId, sendWorkspace);
        await sessionRepository.create({
          id: message.sessionId,
          userId,
          workspaceId,
          channelType: context.clientType,
          channelId: message.sessionId,
          title: `${context.clientType} conversation`,
          status: 'active',
          context: {
            devMode: true,
            projectPath: message.projectPath,
            projectName: message.projectPath.split(/[/\\]/).pop() || 'project',
          },
        });
        coreLogger.info({ sessionId: message.sessionId, projectPath: message.projectPath, workspaceId }, 'Pre-created session with dev-mode project context');
      }
    }

    await resolveSession(message.sessionId, userId, context.clientType, sendWorkspace);

    if (message.attachments?.length) {
      if (message.attachments.length + (message.fileRefs?.length ?? 0) > 10) throw new Error('Attach at most 10 files per message.');
      const { sessionRepository } = await import('@/db/repositories/session-repository');
      const session = await sessionRepository.findById(message.sessionId);
      if (!session || !(await canActInSession(session, userId, 'chat'))) throw new Error('Session not found');
      const uploaded = await storeChatUploads(WorkspaceFS.forSessionAttachments(session, await sessionFsAccess(session, userId)), message.attachments.map(decodeChatAttachment));
      message.fileRefs = [...(message.fileRefs ?? []), ...uploaded.map((file, index) => ({ path: file.path,
        ...(message.attachments![index].protectionLevel !== undefined ? { protectionLevel: message.attachments![index].protectionLevel } : {}),
      }))];
      message.content += '\n\n' + uploaded.map(file => `Attached file: ${file.path}`).join('\n');
    }

    // `restart`: stop the running turn and go ahead of the queued ones. A
    // command is never a restart (`/stop` and friends act at once anyway).
    const front = mode === 'restart' && !message.content.trimStart().startsWith('/');
    const restarted = front && await interruptRunningTurn(message.sessionId, userId);
    if (restarted) deliver('restarted');
    else {
      const running = isSessionTurnRunning(message.sessionId) ? 1 : 0;
      const ahead = isSessionControlMessage(message.content) ? 0 : front ? running : running + queuedTurnCount(message.sessionId);
      const reason = mode !== 'restart' ? queuedBecause
        : !front ? 'A command is never a restart.'
          : running ? 'The running turn had no agent to stop yet; this message runs next.' : 'No turn was running to restart.';
      deliver('queued', { ahead, ...(reason ? { reason } : {}) });
    }

    // Route through root agent
    const turnInlineUi = { renders: message.renders, notes: inlineUiNotes.notes, provenanceId: inlineUiNotes.provenanceId };
    const result = front
      ? await rootAgent.handleMessage(message.sessionId, userId, message.content, context.clientType, message.fileRefs, message.outputMode,
        undefined, undefined, undefined, turnInlineUi, { queueFront: true })
      : await rootAgent.handleMessage(message.sessionId, userId, message.content, context.clientType, message.fileRefs, message.outputMode,
        undefined, undefined, undefined, turnInlineUi);

    // Send response back through gateway
    hub.publishEvent({
      type: 'chat.response',
      source: 'rootAgent',
      userId: context.userId,
      sessionId: message.sessionId,
      payload: { response: result },
    });

    await publishSessionStats(hub, context.userId, message.sessionId);
  } catch (err) {
    // `/stop` dropped this message while it waited behind the running turn:
    // it never ran and was never stored.
    const cancelled = isSessionTurnCancelled(err);
    if (cancelled) coreLogger.info({ connectionId, sessionId: message.sessionId }, 'Queued chat message dropped by stop');
    else coreLogger.error({ err, connectionId, userId: context.userId }, 'Chat send error');
    hub.connectionManager.sendToConnection(connectionId, {
      type: 'error',
      code: cancelled ? 'CHAT_CANCELLED' : 'CHAT_ERROR',
      message: (err as Error).message,
    });
    // Every tab of the user showing this session stops waiting on the turn.
    hub.publishEvent({
      type: 'chat.error',
      source: 'rootAgent',
      userId: context.userId,
      sessionId: message.sessionId,
      payload: { error: (err as Error).message, ...(cancelled ? { cancelled: true } : {}) },
    });
  }
}

/**
 * Publish the session's authoritative usage after a turn: totals from the cost
 * log (which counts every child agent, not just the completions this client
 * happened to see) plus the last prompt's context fill. Best-effort — a stats
 * query must never fail the turn that produced the answer.
 */
async function publishSessionStats(hub: GatewayHub, userId: string, sessionId: string): Promise<void> {
  try {
    const [{ getCostTracker }, { getContextFill }] = await Promise.all([
      import('@/models/cost-tracker'),
      import('@/core/agent/prompt-budget'),
    ]);
    const usage = await getCostTracker().getSessionStats(sessionId);
    const fill = getContextFill(sessionId);
    hub.publishEvent({
      type: 'session.stats',
      source: 'rootAgent',
      userId,
      sessionId,
      payload: {
        totalTokens: usage.totalInputTokens + usage.totalOutputTokens,
        inputTokens: usage.totalInputTokens,
        outputTokens: usage.totalOutputTokens,
        totalCostUsd: usage.totalCost,
        requestCount: usage.requestCount,
        contextTokens: fill?.promptTokens,
        contextWindow: fill?.contextWindow,
      },
    });
  } catch (err) {
    coreLogger.debug({ err, sessionId }, 'session stats publish skipped');
  }
}

/**
 * Side-channel rate limiter. Interject bypasses the root agent queue
 * and triggers an LLM call directly, so it needs its own brake. Per-session
 * sliding window: at most INTERJECT_MAX hits in INTERJECT_WINDOW_MS.
 */
const INTERJECT_WINDOW_MS = 10_000;
const INTERJECT_MAX = 5;
const interjectHits = new Map<string, number[]>();

function allowInterject(sessionId: string): boolean {
  const now = Date.now();
  const cutoff = now - INTERJECT_WINDOW_MS;
  // A session's entry outlives its window; drop the lapsed ones now and then.
  if (interjectHits.size > 256) {
    for (const [id, hits] of interjectHits) if ((hits.at(-1) ?? 0) <= cutoff) interjectHits.delete(id);
  }
  const history = (interjectHits.get(sessionId) ?? []).filter((t) => t > cutoff);
  if (history.length >= INTERJECT_MAX) {
    interjectHits.set(sessionId, history);
    return false;
  }
  history.push(now);
  interjectHits.set(sessionId, history);
  return true;
}

/**
 * Side-channel chat message — does NOT go through the root agent
 * queue. Routes directly through the persona-aware direct-response
 * path so the user can ask a quick question while a swarm is
 * running. Reply is prefixed with the persona's name and "side
 * question:" so the user can tell it apart from the main thread.
 */
async function handleChatInterject(
  hub: GatewayHub,
  connectionId: string,
  context: ConnectionContext,
  message: Extract<ClientMessage, { type: 'chat.interject' }>,
): Promise<void> {
  try {
    if (!allowInterject(message.sessionId)) {
      hub.connectionManager.sendToConnection(connectionId, {
        type: 'error',
        code: 'INTERJECT_RATE_LIMITED',
        message: `Interject rate limit hit (${INTERJECT_MAX} per ${INTERJECT_WINDOW_MS / 1000}s). Slow down.`,
      });
      return;
    }

    const refused = await sessionAccessError(message.sessionId, context);
    if (refused) {
      hub.connectionManager.sendToConnection(connectionId, { type: 'error', code: 'SESSION_NOT_FOUND', message: refused });
      return;
    }
    const userId = context.userId;
    context.sessionId = message.sessionId;

    const { directResponse } = await import('@/core/agent/direct-response');
    const { ModelSelector } = await import('@/core/agent/model-selector');
    const { resolvePersonaForUser } = await import('@/core/personas/resolver');

    const persona = await resolvePersonaForUser(userId).catch(() => null);
    const personaName = persona?.name || 'Octipus';
    const selector = new ModelSelector();

    let reply: string;
    try {
      // A side question in a space session follows the space's model rules
      // (§5.6); resolving the scope also refuses a role that may not run the agent.
      const { resolveAgentScope } = await import('@/core/agent/context');
      const { sessionRepository } = await import('@/db/repositories/session-repository');
      const session = await sessionRepository.findById(message.sessionId);
      const scope = await resolveAgentScope({ session, userId, trigger: session?.kind === 'room' ? 'room' : 'user' });
      const result = await directResponse(
        message.content,
        message.sessionId,
        userId,
        selector,
        'simple',
        [], '', undefined, scope.space, scope.sponsor,
      );
      reply = `${personaName} — side question: ${result.response}`;
    } catch (err) {
      reply = `${personaName} — side question: ${(err as Error).message}`;
    }

    hub.publishEvent({
      type: 'chat.message',
      source: `interject:${connectionId}`,
      userId,
      sessionId: message.sessionId,
      payload: {
        role: 'assistant',
        content: reply,
        sideChannel: true,
      },
    });
  } catch (err) {
    coreLogger.error({ err, sessionId: message.sessionId }, 'chat.interject failed');
    hub.connectionManager.sendToConnection(connectionId, {
      type: 'error',
      code: 'INTERJECT_ERROR',
      message: (err as Error).message,
    });
  }
}

async function handleCommand(
  hub: GatewayHub,
  connectionId: string,
  context: ConnectionContext,
  message: Extract<ClientMessage, { type: 'command' }>,
): Promise<void> {
  const registry = getCommandRegistry();
  const input = `/${message.name}${message.args ? ' ' + Object.values(message.args).join(' ') : ''}`;

  // A client may point the connection at a session before its first chat.send
  // (resume). Only the owner's sessions; trusted consoles act for the admin.
  if (message.sessionId && message.sessionId !== context.sessionId) {
    const refused = await sessionAccessError(message.sessionId, context);
    if (refused) {
      hub.connectionManager.sendToConnection(connectionId, { type: 'command.result', name: message.name, result: null, error: refused });
      return;
    }
    context.sessionId = message.sessionId;
  }

  const result = await registry.execute(input, {
    userId: context.userId,
    sessionId: context.sessionId,
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
    clientType: context.clientType,
    trustLevel: context.trustLevel,
    metadata: context.metadata,
  });

  hub.connectionManager.sendToConnection(connectionId, {
    type: 'command.result',
    name: message.name,
    result: result?.text || null,
    error: result ? undefined : 'Unknown command',
    data: result?.data,
  });
}

async function handlePermissionRespond(
  hub: GatewayHub,
  connectionId: string,
  context: ConnectionContext,
  message: Extract<ClientMessage, { type: 'permission.respond' }>,
): Promise<void> {
  try {
    const { getPermissionManager } = await import('@/security/permissions');
    const permissionManager = getPermissionManager();
    // Only the requester answers: the manager matches the request's owner.
    // An admin answering someone else's request goes through the audited
    // POST /api/admin/permission-requests/:id/resolve, never through here.
    // An unresolved request is reported instead of swallowed.
    const resolved = message.approved
      ? await permissionManager.approve(message.requestId, context.userId, message.resolution)
      : await permissionManager.deny(message.requestId, context.userId);

    if (!resolved) {
      hub.connectionManager.sendToConnection(connectionId, {
        type: 'error',
        code: 'PERMISSION_ERROR',
        message: 'That permission request is no longer pending (already answered, or expired).',
      });
      // Another client may have answered first: reconcile this one from the
      // owner's current list.
      await hub.sendPendingSnapshot(connectionId, context);
    }
  } catch (err) {
    coreLogger.error({ err, connectionId, requestId: message.requestId }, 'Permission respond error');
    hub.connectionManager.sendToConnection(connectionId, {
      type: 'error',
      code: 'PERMISSION_ERROR',
      message: (err as Error).message,
    });
  }
}

async function handleApprovalRespond(
  hub: GatewayHub,
  connectionId: string,
  context: ConnectionContext,
  message: Extract<ClientMessage, { type: 'approval.respond' }>,
): Promise<void> {
  try {
    const { getAgentService } = await import('@/core/agent');
    const rootAgent = getAgentService();

    // Same rule as REST /chat/approve: only the requester answers. Admins
    // use the audited POST /api/admin/approvals/:id/resolve.
    const outcome = await rootAgent.resolveApprovalDetailed(
      message.requestId, message.approved, message.response,
      { forUserId: context.userId, resolvedBy: context.userId },
    );
    if ('message' in outcome) {
      hub.connectionManager.sendToConnection(connectionId, {
        type: 'error',
        code: 'APPROVAL_EXPIRED',
        message: outcome.message,
      });
    } else if (outcome.status !== 'resolved') {
      // Unknown, someone else's, or answered already: one answer for all
      // three, as REST /chat/approve gives, so ids cannot be probed.
      hub.connectionManager.sendToConnection(connectionId, {
        type: 'error',
        code: 'APPROVAL_NOT_FOUND',
        message: 'Approval request not found or already resolved',
      });
    }
  } catch (err) {
    coreLogger.error({ err, connectionId, requestId: message.requestId }, 'Approval respond error');
    hub.connectionManager.sendToConnection(connectionId, {
      type: 'error',
      code: 'APPROVAL_ERROR',
      message: (err as Error).message,
    });
  }
}

/**
 * Explicit mid-run steer: a text-only `chat.send` with the frame's `mode`.
 * With `auto` (the default) a session where nothing running takes guidance
 * gets it as a normal turn, so a steer is always safe to fire; `steer`
 * refuses instead. The answer is `chat.delivery`.
 */
async function handleChatSteer(
  hub: GatewayHub,
  connectionId: string,
  context: ConnectionContext,
  message: Extract<ClientMessage, { type: 'chat.steer' }>,
): Promise<void> {
  await handleChatSend(hub, connectionId, context, {
    type: 'chat.send',
    sessionId: message.sessionId,
    content: message.content,
    ...(message.mode ? { mode: message.mode } : {}),
  });
}

async function handleAgentStop(
  hub: GatewayHub,
  connectionId: string,
  context: ConnectionContext,
  message: Extract<ClientMessage, { type: 'agent.stop' }>,
): Promise<void> {
  try {
    const { getAgentManager } = await import('@/core/agent-manager');
    const agentManager = getAgentManager();
    // A connection stops its own user's agents only — the owner check compares
    // user ids, whatever the connection's admin flag. Unknown and foreign ids
    // get the same answer so ids cannot be probed.
    const agent = agentManager.get(message.agentId);
    if (!agent || agent.getContext().userId !== context.userId) {
      hub.connectionManager.sendToConnection(connectionId, {
        type: 'error',
        code: 'AGENT_NOT_FOUND',
        message: 'Agent not found',
      });
      return;
    }
    if (agent.getContext().root) {
      try { await (await import('@/core/companion/user-control')).recordCompanionOwnerStop(agent.getContext().sessionId, context.userId); }
      catch (error) { coreLogger.error({ error, sessionId: agent.getContext().sessionId }, 'Could not persist Companion owner stop'); }
    }
    // Stopping a turn's root also drops the turns queued behind it, as `/stop`
    // does: first, so none of them starts in the gap the stopped turn leaves.
    const droppedQueued = agent.getContext().root ? cancelQueuedTurns(agent.getContext().sessionId) : 0;
    agentManager.stop(message.agentId, { actorUserId: context.userId });

    hub.publishEvent({
      type: 'agent.stopped',
      source: `user:${context.userId}`,
      userId: context.userId,
      payload: { agentId: message.agentId, stoppedBy: context.userId, ...(droppedQueued ? { droppedQueued } : {}) },
    });
  } catch (err) {
    coreLogger.error({ err, connectionId, agentId: message.agentId }, 'Agent stop error');
    hub.connectionManager.sendToConnection(connectionId, {
      type: 'error',
      code: 'AGENT_STOP_ERROR',
      message: (err as Error).message,
    });
  }
}

/**
 * Does another connection of the user hold `sessionId` in voice mode? Voice
 * mode is keyed by (session, user) in the root agent, so one connection
 * leaving it must not take it from a tab that still speaks.
 */
function voiceHeldElsewhere(hub: GatewayHub, context: ConnectionContext, sessionId: string): boolean {
  return hub.connectionManager.getConnectionsByUser(context.userId).some((conn) =>
    !!conn.context && conn.context.connectionId !== context.connectionId && conn.context.voiceSessionId === sessionId);
}

/**
 * Put a session into (or out of) voice mode for this connection. Owner check
 * as for `chat.send`: another user's session is refused before anything
 * changes. A session that does not exist yet (a fresh chat) is allowed — the
 * gate is keyed by (session, user), so it only ever affects this user's turns.
 *
 * `on:false` is honoured only for the session this connection turned on, and
 * the root agent leaves voice mode only when no other connection of the user
 * still holds that session in it: a tab without voice cannot switch off
 * another tab's.
 */
async function handleVoiceSet(
  hub: GatewayHub,
  connectionId: string,
  context: ConnectionContext,
  message: Extract<ClientMessage, { type: 'voice.set' }>,
): Promise<void> {
  try {
    const refused = await sessionAccessError(message.sessionId, context);
    if (refused) {
      hub.connectionManager.sendToConnection(connectionId, { type: 'error', code: 'SESSION_NOT_FOUND', message: refused });
      return;
    }
    const { getAgentService } = await import('@/core/agent');
    const service = getAgentService();
    const previous = context.voiceSessionId;
    // Voice is a module (docs/MODULES.md): off, no session goes into voice mode.
    const { isModuleOn } = await import('@/core/modules/registry');
    if (message.on && !isModuleOn('voice')) {
      hub.connectionManager.sendToConnection(connectionId, { type: 'error', code: 'FORBIDDEN', message: 'Voice is switched off on this install' });
      return;
    }
    if (!message.on) {
      if (previous !== message.sessionId) return; // not this connection's voice session
      context.voiceSessionId = undefined;
      if (!voiceHeldElsewhere(hub, context, message.sessionId)) service.setVoiceMode(message.sessionId, context.userId, false);
      return;
    }
    // Moving voice to another session takes the previous one out first, so
    // its flag is not left set in the root agent.
    if (previous && previous !== message.sessionId && !voiceHeldElsewhere(hub, context, previous)) {
      service.setVoiceMode(previous, context.userId, false);
    }
    service.setVoiceMode(message.sessionId, context.userId, true);
    context.voiceSessionId = message.sessionId;
  } catch (err) {
    coreLogger.error({ err, connectionId, sessionId: message.sessionId }, 'voice.set failed');
    hub.connectionManager.sendToConnection(connectionId, { type: 'error', code: 'VOICE_ERROR', message: (err as Error).message });
  }
}

/**
 * Serve a reconnecting client the events of one of its own sessions that it
 * missed. The session must exist and be the caller's; every replayed event is
 * the caller's own as well (a buffer is per session, and a session has one
 * owner — checked again here rather than assumed).
 */
async function handleReplay(
  hub: GatewayHub,
  connectionId: string,
  context: ConnectionContext,
  message: Extract<ClientMessage, { type: 'replay' }>,
): Promise<void> {
  if (!(await ownsExistingSession(message.sessionId, context))) {
    hub.connectionManager.sendToConnection(connectionId, { type: 'error', code: 'SESSION_NOT_FOUND', message: 'Session not found' });
    return;
  }
  // No watermark: the client has seen none of the buffer live, so replaying
  // it would apply old events again. It reloads from REST instead.
  if (!message.afterEventId) {
    hub.connectionManager.sendToConnection(connectionId, { type: 'replay', sessionId: message.sessionId, events: [], gap: true });
    return;
  }
  const { events, gap } = hub.eventBus.replaySince(message.sessionId, message.afterEventId);
  hub.connectionManager.sendToConnection(connectionId, {
    type: 'replay',
    sessionId: message.sessionId,
    events: events.filter((event) => event.userId === context.userId),
    gap,
  });
}
